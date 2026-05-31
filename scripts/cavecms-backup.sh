#!/usr/bin/env bash
# scripts/cavecms-backup.sh — operator-facing on-demand backup orchestrator.
#
# Invoked from app/api/admin/backups/create/route.ts (detached spawn) OR from
# the CLI (`cavecms backup`, foreground). Writes progress to
# $CAVECMS_BACKUP_STATUS_PATH (or <stateDir>/backup-status.json) so the
# dashboard modal can poll.
#
# READ-ONLY: no maintenance toggle, no app restart, no watchdog. mysqldump
# --single-transaction is consistent without locking; the uploads tar is a copy.
#
# 5 steps (BACKUP_TOTAL_STEPS):
#   1. preflight   — resolve env, disk check, acquire the shared op lock
#   2. db-dump     — full mysqldump | gzip → staging/database.sql.gz
#   3. uploads     — tar+gzip of UPLOADS_ROOT/{originals,variants,brochures-private}
#   4. assemble    — manifest.json (first) + tar.gz the archive
#   5. finalize    — optional age-encrypt, atomic move into the backup dir, prune
#
# Produces: <CAVECMS_BACKUP_DIR>/cavecms-backup-<UTCstamp>-<commit12>.tar.gz[.age]
#
# Env contract (from the install's sealed env.production, forwarded narrowly):
#   DATABASE_URL, UPLOADS_ROOT, CAVECMS_BACKUP_DIR, CAVECMS_COMMIT,
#   CAVECMS_ENV_FILE, CAVECMS_BACKUP_STATUS_PATH, CAVECMS_STATE_DIR,
#   CAVECMS_LOG_DIR, INTERNAL_REVALIDATE_SECRET, and optionally
#   CAVECMS_BACKUP_INCLUDE_ENV=1, CAVECMS_BACKUP_AGE_RECIPIENT,
#   CAVECMS_BACKUP_DRY_RUN=1 (dev/test only).
#
# Usage: /bin/bash scripts/cavecms-backup.sh

set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HOME_DIR="${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${HOME_DIR}/.local/share/pnpm:${HOME_DIR}/.npm-global/bin:${PATH:-}"

# ---------------------------------------------------------------------------
# Status path + shared lock resolution
# ---------------------------------------------------------------------------
if [ -n "${CAVECMS_BACKUP_STATUS_PATH:-}" ]; then
  STATUS_PATH="$CAVECMS_BACKUP_STATUS_PATH"
elif [ -n "${CAVECMS_STATE_DIR:-}" ]; then
  STATUS_PATH="$CAVECMS_STATE_DIR/backup-status.json"
else
  STATUS_PATH="/var/lib/cavecms/backup-status.json"
fi

# Same allowlist guard as lib/backups/statusPath.ts / cavecms-update.sh.
allowed=0
case "$STATUS_PATH" in
  /var/lib/cavecms/*|/tmp/*|/var/folders/*) allowed=1 ;;
esac
if [ "$allowed" = "0" ] && [ -n "${CAVECMS_STATE_DIR:-}" ]; then
  case "$STATUS_PATH" in "$CAVECMS_STATE_DIR"/*) allowed=1 ;; esac
fi
if [ "$allowed" = "0" ]; then
  case "$STATUS_PATH" in */.cavecms-state/*) allowed=1 ;; esac
fi
if [ "$allowed" = "0" ]; then
  echo "[cavecms-backup] STATUS_PATH '$STATUS_PATH' not under allowed prefix" >&2
  exit 2
fi

# Shared operation lock — the SAME file the updater locks, so backup / update /
# restore are mutually exclusive on one install.
if [ -n "${CAVECMS_UPDATE_STATUS_PATH:-}" ]; then
  _UPDATE_STATUS="$CAVECMS_UPDATE_STATUS_PATH"
elif [ -n "${CAVECMS_STATE_DIR:-}" ]; then
  _UPDATE_STATUS="$CAVECMS_STATE_DIR/update-status.json"
else
  _UPDATE_STATUS="/var/lib/cavecms/update-status.json"
fi
SHARED_LOCK_PATH="${_UPDATE_STATUS}.lock"

REPO_DIR="${CAVECMS_REPO_DIR:-$(pwd)}"
LOG_DIR="${CAVECMS_LOG_DIR:-/var/log/cavecms}"
ENV_FILE="${CAVECMS_ENV_FILE:-${REPO_DIR}/env.production}"
UPLOADS_ROOT="${UPLOADS_ROOT:-/opt/cavecms/uploads}"

mkdir -p "$(dirname "$STATUS_PATH")"
mkdir -p "$LOG_DIR" 2>/dev/null || true
if ! ( touch "$LOG_DIR/.cavecms-write-probe" 2>/dev/null && rm -f "$LOG_DIR/.cavecms-write-probe" 2>/dev/null ); then
  LOG_DIR=/tmp
fi

# ---------------------------------------------------------------------------
# Helpers (update helpers FIRST, then backup helpers which depend on them)
# ---------------------------------------------------------------------------
HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=scripts/lib/cavecms-update-helpers.sh
. "${HELPERS_DIR}/cavecms-update-helpers.sh"
# shellcheck source=scripts/lib/cavecms-backup-helpers.sh
. "${HELPERS_DIR}/cavecms-backup-helpers.sh"

export PHASE_STARTED_AT
PHASE_STARTED_AT="$(now_iso)"
TOTAL=5
STAGING=""
ARCHIVE_ID=""
LOCK_HELD=0

bstatus() { write_phase_status "$STATUS_PATH" "$TOTAL" "$@"; }

# read_status_state reads $STATUS_PATH (update-shaped); we need it for an
# arbitrary path. Tiny inline reader (best-effort). Defined before on_exit so
# the EXIT trap can always call it.
read_status_state_at() {
  local f="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("state",""))
except Exception: print("")' "$f" 2>/dev/null || true
  else
    awk -F'"' '/"state"[[:space:]]*:/ {for(i=1;i<=NF;i++) if ($i ~ /^state$/){print $(i+2); exit}}' "$f" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# EXIT trap — mark failed if not already terminal; clean staging; release lock.
# ---------------------------------------------------------------------------
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    local cur
    cur=$( (read_status_state_at "$STATUS_PATH" 2>/dev/null) || true )
    case "$cur" in
      completed|failed) ;;
      *)
        bstatus failed 0 "Backup failed" "The backup couldn't be completed." "" || true
        post_backup_audit_terminal backup_failed "${ARCHIVE_ID:-unknown}" "exit ${rc}" || true
        ;;
    esac
  fi
  [ -n "$STAGING" ] && rm -rf "$STAGING" 2>/dev/null || true
  [ "$LOCK_HELD" = "1" ] && release_lock "$SHARED_LOCK_PATH" 2>/dev/null || true
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# ---------------------------------------------------------------------------
# Dry-run — walk the states on a timer for Playwright. No real work.
# ---------------------------------------------------------------------------
if [ "${CAVECMS_BACKUP_DRY_RUN:-0}" = "1" ]; then
  bstatus running 1 "Getting ready"; sleep 1
  bstatus running 2 "Saving your content"; sleep 1
  bstatus running 3 "Saving your media"; sleep 1
  bstatus running 4 "Packaging the archive"; sleep 1
  bstatus running 5 "Finishing up"; sleep 1
  bstatus completed 5 "Backup complete" "" "" "Just now (demo)"
  exit 0
fi

# ===========================================================================
# STEP 1 — preflight
# ===========================================================================
bstatus running 1 "Getting ready"

: "${CAVECMS_BACKUP_DIR:?CAVECMS_BACKUP_DIR is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
mkdir -p "$CAVECMS_BACKUP_DIR" 2>/dev/null || true
if ! ( touch "$CAVECMS_BACKUP_DIR/.cavecms-write-probe" 2>/dev/null && rm -f "$CAVECMS_BACKUP_DIR/.cavecms-write-probe" 2>/dev/null ); then
  bstatus failed 1 "Backup failed" "The backup folder isn't writable."
  post_backup_audit_terminal backup_failed unknown "backup dir not writable"
  exit 1
fi
if ! assert_disk_ok "$CAVECMS_BACKUP_DIR"; then
  bstatus failed 1 "Backup failed" "There isn't enough free disk space to make a backup."
  post_backup_audit_terminal backup_failed unknown "disk full"
  exit 1
fi

# Acquire the shared op lock (mutually exclusive with update + restore).
if ! acquire_lock_or_defer "$SHARED_LOCK_PATH"; then
  bstatus failed 1 "Backup failed" "Another update or backup is already running. Try again in a moment."
  exit 1
fi
LOCK_HELD=1

# ===========================================================================
# STEP 2 — database dump
# ===========================================================================
bstatus running 2 "Saving your content"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/cavecms-backup-stage.XXXXXX")"
if ! dump_database "${STAGING}/database.sql.gz" >/dev/null; then
  bstatus failed 2 "Backup failed" "We couldn't save your content."
  post_backup_audit_terminal backup_failed unknown "db dump failed"
  exit 1
fi

# ===========================================================================
# STEP 3 — uploads tar
# ===========================================================================
bstatus running 3 "Saving your media"
UPLOAD_SUBDIRS=()
for sub in originals variants brochures-private; do
  [ -d "${UPLOADS_ROOT}/${sub}" ] && UPLOAD_SUBDIRS+=("$sub")
done
if [ "${#UPLOAD_SUBDIRS[@]}" -eq 0 ]; then
  # No uploads tree yet (brand-new install) — produce an empty uploads tar so
  # the archive shape is uniform and restore always has something to extract.
  ( cd "$STAGING" && tar -czf uploads.tar.gz --files-from /dev/null )
  UPLOAD_FILECOUNT=0
else
  if ! tar -C "$UPLOADS_ROOT" \
        --exclude='.tmp' --sort=name \
        --warning=no-file-changed --warning=no-file-removed \
        -czf "${STAGING}/uploads.tar.gz" "${UPLOAD_SUBDIRS[@]}" 2>>"${LOG_DIR}/backup-uploads.log"; then
    bstatus failed 3 "Backup failed" "We couldn't save your media files."
    post_backup_audit_terminal backup_failed unknown "uploads tar failed"
    exit 1
  fi
  UPLOAD_FILECOUNT=$(tar -tzf "${STAGING}/uploads.tar.gz" 2>/dev/null | grep -vc '/$' || echo 0)
fi
assert_disk_ok "$CAVECMS_BACKUP_DIR" || { bstatus failed 3 "Backup failed" "Ran out of disk space while saving media."; post_backup_audit_terminal backup_failed unknown "disk full mid-uploads"; exit 1; }

# Optional env.production inclusion (--include-env).
ENV_INCLUDED=false
if [ "${CAVECMS_BACKUP_INCLUDE_ENV:-0}" = "1" ]; then
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "${STAGING}/env.production"
    chmod 600 "${STAGING}/env.production"
    ENV_INCLUDED=true
  fi
fi

# ===========================================================================
# STEP 4 — manifest + assemble
# ===========================================================================
bstatus running 4 "Packaging the archive"

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Resolve version + commit for the manifest.
RAW_VERSION="${CAVECMS_RELEASE_VERSION:-}"
if [ -z "$RAW_VERSION" ]; then
  for pj in "${REPO_DIR}/package.json" "${REPO_DIR}/.next/standalone/package.json"; do
    [ -f "$pj" ] && RAW_VERSION=$(awk -F'"' '/"version":/ {print $4; exit}' "$pj") && break
  done
fi
[ -z "$RAW_VERSION" ] && RAW_VERSION="0.0.0"
RAW_COMMIT="${CAVECMS_COMMIT:-}"
if printf '%s' "$RAW_COMMIT" | grep -Eq '^[0-9a-fA-F]{7,64}$'; then
  COMMIT=$(printf '%s' "$RAW_COMMIT" | tr 'A-F' 'a-f')
else
  COMMIT="0000000"
fi
COMMIT12="${COMMIT:0:12}"

DB_FILE="${STAGING}/database.sql.gz"
UP_FILE="${STAGING}/uploads.tar.gz"
DB_SHA=$(_sha256 "$DB_FILE"); DB_SIZE=$(wc -c < "$DB_FILE" | tr -d ' ')
UP_SHA=$(_sha256 "$UP_FILE"); UP_SIZE=$(wc -c < "$UP_FILE" | tr -d ' ')
DB_NAME=$(echo "$DATABASE_URL" | python3 -c 'import sys,urllib.parse as u; print((u.urlparse(sys.stdin.read().strip()).path or "/").lstrip("/").split("?")[0])' 2>/dev/null || echo "cavecms")
SERVER_VERSION=$(db_server_version 2>/dev/null || echo "unknown")
FINGERPRINT=$(db_schema_fingerprint 2>/dev/null || echo "")
MIG_ENCODING=$(detect_migrator_encoding 2>/dev/null || echo "unknown")
MIG_COUNT=$(db_migration_count 2>/dev/null || echo 0)
[ -z "$FINGERPRINT" ] && FINGERPRINT="0000000000000000000000000000000000000000000000000000000000000000"
AGE_SCHEME="none"; AGE_RECIP=""
if [ -n "${CAVECMS_BACKUP_AGE_RECIPIENT:-}" ] && command -v age >/dev/null 2>&1; then
  AGE_SCHEME="age"; AGE_RECIP="$CAVECMS_BACKUP_AGE_RECIPIENT"
fi

ENC_FIELD="\"encryption\": { \"scheme\": \"${AGE_SCHEME}\""
[ -n "$AGE_RECIP" ] && ENC_FIELD="${ENC_FIELD}, \"recipient\": \"$(json_escape "$AGE_RECIP")\""
ENC_FIELD="${ENC_FIELD} }"

cat > "${STAGING}/manifest.json" << EOF
{
  "formatVersion": 1,
  "kind": "cavecms-backup",
  "createdAt": "${PHASE_STARTED_AT}",
  "cavecms": { "version": "${RAW_VERSION}", "commit": "${COMMIT}" },
  "database": {
    "name": "$(json_escape "$DB_NAME")",
    "engine": "mariadb",
    "serverVersion": "$(json_escape "$SERVER_VERSION")",
    "schemaFingerprint": "${FINGERPRINT}",
    "migratorEncoding": "${MIG_ENCODING}",
    "migrationCount": ${MIG_COUNT:-0},
    "file": "database.sql.gz",
    "sha256": "${DB_SHA}",
    "sizeBytes": ${DB_SIZE}
  },
  "uploads": {
    "file": "uploads.tar.gz",
    "sha256": "${UP_SHA}",
    "sizeBytes": ${UP_SIZE},
    "fileCount": ${UPLOAD_FILECOUNT}
  },
  "env": { "included": ${ENV_INCLUDED} },
  ${ENC_FIELD}
}
EOF

# Assemble with manifest FIRST so `listing` can read it cheaply.
# Timestamp from PHASE_STARTED_AT (GNU date) with a portable fallback (BSD/
# macOS date can't parse an ISO string with -d, so fall back to "now").
ARCHIVE_BASENAME=$(printf 'cavecms-backup-%s-%s' "$(date -u -d "$PHASE_STARTED_AT" +%Y%m%d-%H%M%S 2>/dev/null || date -u +%Y%m%d-%H%M%S)" "$COMMIT12")
ARCHIVE_ID="$ARCHIVE_BASENAME"
TAR_MEMBERS=(manifest.json database.sql.gz uploads.tar.gz)
[ "$ENV_INCLUDED" = "true" ] && TAR_MEMBERS+=(env.production)
( cd "$STAGING" && tar -czf "archive.tar.gz" "${TAR_MEMBERS[@]}" )

# ===========================================================================
# STEP 5 — encrypt (optional), atomic move, prune
# ===========================================================================
bstatus running 5 "Finishing up"
FINAL_EXT="tar.gz"
if [ "$AGE_SCHEME" = "age" ]; then
  if ! age -r "$AGE_RECIP" "${STAGING}/archive.tar.gz" > "${STAGING}/archive.tar.gz.age"; then
    bstatus failed 5 "Backup failed" "We couldn't encrypt the backup."
    post_backup_audit_terminal backup_failed "$ARCHIVE_ID" "age encrypt failed"
    exit 1
  fi
  rm -f "${STAGING}/archive.tar.gz"
  FINAL_EXT="tar.gz.age"
fi

FINAL_NAME="${ARCHIVE_BASENAME}.${FINAL_EXT}"
PARTIAL=$(mktemp "${CAVECMS_BACKUP_DIR}/.${FINAL_NAME}.partial.XXXXXX")
cp "${STAGING}/archive.${FINAL_EXT}" "$PARTIAL"
chmod 600 "$PARTIAL"
mv -f "$PARTIAL" "${CAVECMS_BACKUP_DIR}/${FINAL_NAME}"

# Retention: keep newest CAVECMS_BACKUP_KEEP (default 5), delete > 30d.
KEEP="${CAVECMS_BACKUP_KEEP:-5}"
if command -v python3 >/dev/null 2>&1; then
  CAVECMS_BACKUP_DIR_ARG="$CAVECMS_BACKUP_DIR" KEEP_ARG="$KEEP" python3 -c '
import os, glob
d = os.environ["CAVECMS_BACKUP_DIR_ARG"]; keep = int(os.environ["KEEP_ARG"])
files = []
for pat in ("cavecms-backup-*.tar.gz", "cavecms-backup-*.tar.gz.age"):
    files += glob.glob(os.path.join(d, pat))
files.sort(key=lambda f: os.stat(f).st_mtime, reverse=True)
for f in files[keep:]:
    try: os.remove(f)
    except OSError: pass
' 2>/dev/null || true
fi
find "$CAVECMS_BACKUP_DIR" -maxdepth 1 -type f \( -name 'cavecms-backup-*.tar.gz' -o -name 'cavecms-backup-*.tar.gz.age' \) -mtime +30 -delete 2>/dev/null || true
find "$CAVECMS_BACKUP_DIR" -maxdepth 1 -type f -name '.cavecms-backup-*.partial.*' -mtime +1 -delete 2>/dev/null || true

# Humanised label for the terminal modal copy (no path/timestamp jargon).
ARCHIVE_LABEL=$(date -u +"%b %-d, %Y" 2>/dev/null || echo "Today")

bstatus completed 5 "Backup complete" "" "" "$ARCHIVE_LABEL"
post_backup_audit_terminal backup_completed "$ARCHIVE_ID"
release_lock "$SHARED_LOCK_PATH"; LOCK_HELD=0
rm -rf "$STAGING"; STAGING=""
exit 0
