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

# Shared operation lock — the SAME <update-status>.lock the updater uses, via
# the SAME existence/O_EXCL scheme (NOT flock — the updater holds no advisory
# flock, so a flock acquire would NOT exclude an in-flight update). Backup /
# update / restore are therefore mutually exclusive on one install.
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

# ---------------------------------------------------------------------------
# Helpers — sourced BEFORE the status-path allowlist check so we can use the
# shared assert_allowed_status_path / acquire_op_lock (parity with the TS side).
# ---------------------------------------------------------------------------
HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=scripts/lib/cavecms-update-helpers.sh
. "${HELPERS_DIR}/cavecms-update-helpers.sh"
# shellcheck source=scripts/lib/cavecms-backup-helpers.sh
. "${HELPERS_DIR}/cavecms-backup-helpers.sh"

if ! assert_allowed_status_path "$STATUS_PATH"; then
  echo "[cavecms-backup] STATUS_PATH '$STATUS_PATH' not under allowed prefix" >&2
  exit 2
fi

mkdir -p "$(dirname "$STATUS_PATH")"
mkdir -p "$LOG_DIR" 2>/dev/null || true
if ! ( touch "$LOG_DIR/.cavecms-write-probe" 2>/dev/null && rm -f "$LOG_DIR/.cavecms-write-probe" 2>/dev/null ); then
  LOG_DIR=/tmp
fi

export PHASE_STARTED_AT
PHASE_STARTED_AT="$(now_iso)"
# A cloud destination adds a 6th "upload" step (the modal shows step/6).
TOTAL=5
[ "${CAVECMS_BACKUP_DESTINATION:-local}" != "local" ] && TOTAL=6
STAGING=""
ARCHIVE_ID=""
LOCK_HELD=0

bstatus() { write_phase_status "$STATUS_PATH" "$TOTAL" "$@"; }

# Tiny best-effort status-state reader for an arbitrary path (the EXIT trap
# inspects $STATUS_PATH to avoid overwriting an already-terminal state).
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
# An rc=0 exit (incl. lock-contention) writes NO status and releases nothing.
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
  # Defence in depth: wipe the plaintext cloud creds file on EVERY exit
  # (success or failure) — cloud-push removes it on success, but a failed
  # upload must not leave the decrypted refresh token + passphrase on disk.
  [ -n "${CAVECMS_BACKUP_CLOUD_CREDS_FILE:-}" ] && rm -f "$CAVECMS_BACKUP_CLOUD_CREDS_FILE" 2>/dev/null || true
  [ "$LOCK_HELD" = "1" ] && release_op_lock "$SHARED_LOCK_PATH" 2>/dev/null || true
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Acquire the shared op lock FIRST — before any status write — so a loser in a
# concurrent-spawn race exits WITHOUT clobbering the winner's status. The route
# / CLI pre-check already 409'd / refused the common case; this O_EXCL acquire
# is the authoritative cross-process gate. Held by another op → exit cleanly
# (the modal polls the winner's live status).
if ! acquire_op_lock "$SHARED_LOCK_PATH"; then
  echo "[cavecms-backup] another operation holds the lock — exiting without changes" >&2
  exit 0
fi
LOCK_HELD=1

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
# Disk pre-check — byte-level estimate (raw uploads size × 1.2 + a DB/overhead
# margin) vs free space on the BACKUP filesystem. Staging lives inside
# CAVECMS_BACKUP_DIR (same FS as the final archive), so one check covers the
# whole operation. Raw uploads size over-estimates the gzip'd archive → safe.
UPLOADS_KB=$(du_kb "${UPLOADS_ROOT}/originals" "${UPLOADS_ROOT}/variants" "${UPLOADS_ROOT}/brochures-private")
NEED_KB=$(( UPLOADS_KB * 12 / 10 + 51200 ))
if ! assert_disk_for "$CAVECMS_BACKUP_DIR" "$NEED_KB"; then
  bstatus failed 1 "Backup failed" "There isn't enough free disk space to make a backup."
  post_backup_audit_terminal backup_failed unknown "insufficient disk"
  exit 1
fi

# ===========================================================================
# STEP 2 — database dump
# ===========================================================================
bstatus running 2 "Saving your content"
# Stage INSIDE the backup dir (same FS) so the final publish is an atomic `mv`
# (no second full copy) and the step-1 disk check covers staging too. The
# `.staging.*` prefix is ignored by listBackups' archive-name regex.
STAGING="$(mktemp -d "${CAVECMS_BACKUP_DIR}/.staging.XXXXXX")"
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
  # No uploads tree yet (brand-new install) — tar three EMPTY subdirs so the
  # archive is valid (GNU tar refuses to create a truly-empty archive via
  # `--files-from /dev/null`) and restore always has dirs to extract.
  _emptyup="${STAGING}/_emptyuploads"
  mkdir -p "${_emptyup}/originals" "${_emptyup}/variants" "${_emptyup}/brochures-private"
  ( cd "$_emptyup" && tar -czf "${STAGING}/uploads.tar.gz" originals variants brochures-private )
  rm -rf "$_emptyup"
  UPLOAD_FILECOUNT=0
else
  # --sort=name + --warning=* are GNU-tar extensions (deterministic ordering +
  # race-noise suppression) that bsdtar (macOS / the laptop surface) rejects
  # outright. Gate them on a real GNU tar; --exclude is portable and stays.
  TAR_GNU_FLAGS=()
  if tar --version 2>/dev/null | grep -qi 'GNU tar'; then
    TAR_GNU_FLAGS=(--sort=name --warning=no-file-changed --warning=no-file-removed)
  fi
  if ! tar -C "$UPLOADS_ROOT" --exclude='.tmp' \
        ${TAR_GNU_FLAGS[@]+"${TAR_GNU_FLAGS[@]}"} \
        -czf "${STAGING}/uploads.tar.gz" "${UPLOAD_SUBDIRS[@]}" 2>>"${LOG_DIR}/backup-uploads.log"; then
    bstatus failed 3 "Backup failed" "We couldn't save your media files."
    post_backup_audit_terminal backup_failed unknown "uploads tar failed"
    exit 1
  fi
  # Count source files with a single inode walk (cheaper than gunzip-listing
  # the whole tar). `wc -l` ALWAYS prints exactly one integer and exits 0 —
  # unlike `grep -c` which prints a count AND exits 1 on zero matches, so a
  # `grep -vc … || echo 0` would emit a second line ("0\n0") on an empty tree
  # and corrupt the manifest JSON. Exclude .tmp via -path.
  UPLOAD_FILECOUNT=$(find "${UPLOAD_SUBDIRS[@]/#/${UPLOADS_ROOT}/}" -type f -not -path '*/.tmp/*' 2>/dev/null | wc -l | tr -d ' ')
  [ -z "$UPLOAD_FILECOUNT" ] && UPLOAD_FILECOUNT=0
fi
# Mid-stream guard: a hard FREE-BYTES floor (catches a concurrent disk fill /
# an under-estimate), NOT the percent gate — the step-1 byte estimate already
# authorised the whole operation, and a near-full-but-large disk with ample
# free bytes must not be refused here just for being >90% used.
assert_disk_for "$CAVECMS_BACKUP_DIR" 51200 || { bstatus failed 3 "Backup failed" "Ran out of disk space while saving media."; post_backup_audit_terminal backup_failed unknown "disk full mid-uploads"; exit 1; }

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
DB_NAME=$(_parse_db_url_portable "$DATABASE_URL" | awk 'NR==5')
[ -z "$DB_NAME" ] && DB_NAME="cavecms"

# Probe serverVersion + fingerprint + migrationCount + latest-hash in ONE query.
PROBE=$(db_manifest_probe 2>/dev/null || true)
SERVER_VERSION=$(printf '%s' "$PROBE" | awk -F'\t' 'NR==1{print $1}')
FINGERPRINT=$(printf '%s' "$PROBE" | awk -F'\t' 'NR==1{print $2}')
MIG_COUNT=$(printf '%s' "$PROBE" | awk -F'\t' 'NR==1{print $3+0}')
MIG_HASH=$(printf '%s' "$PROBE" | awk -F'\t' 'NR==1{print $4}')
MIG_ENCODING=$(encoding_of_hash "$MIG_HASH")
[ -z "$SERVER_VERSION" ] && SERVER_VERSION="unknown"

# Refuse to produce a backup whose migration state can't be introspected — an
# 'unknown' encoding (empty/failed __drizzle_migrations probe) would bake an
# un-restorable value into the manifest (both validators reject it). Fail loud
# here instead of writing a poisoned archive.
if [ "$MIG_ENCODING" = "unknown" ] || [ "${MIG_COUNT:-0}" -eq 0 ]; then
  bstatus failed 4 "Backup failed" "This site isn't fully set up yet, so there's nothing to back up."
  post_backup_audit_terminal backup_failed unknown "migrator encoding unknown / no migrations"
  exit 1
fi
[ -z "$FINGERPRINT" ] && FINGERPRINT="0000000000000000000000000000000000000000000000000000000000000000"
AGE_SCHEME="none"; AGE_RECIP=""
# Local age encryption only applies to LOCAL backups. For a cloud destination,
# cloud-push.mjs owns encryption (passphrase → AES-256-GCM) and must read the
# plain-tar manifest, so we must NOT age-wrap the archive here (an .age blob
# isn't a gzip stream and would break the cloud manifest read).
if [ -n "${CAVECMS_BACKUP_AGE_RECIPIENT:-}" ] \
   && [ "${CAVECMS_BACKUP_DESTINATION:-local}" = "local" ]; then
  if ! command -v age >/dev/null 2>&1; then
    # The operator configured encryption — delivering a PLAINTEXT archive
    # (possibly with env.production secrets inside) because the binary went
    # missing would be a silent downgrade they'd only discover at restore
    # time. Fail loud instead.
    bstatus failed 4 "Backup failed" "This backup is set to be encrypted, but the encryption tool (age) isn't installed on this server. Install it, or turn off backup encryption, then try again."
    post_backup_audit_terminal backup_failed unknown "age recipient configured but age binary missing"
    exit 1
  fi
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
# Staging lives on the SAME filesystem as the backup dir → mv is an atomic
# rename, not a second full copy of a multi-GB archive.
mv -f "${STAGING}/archive.${FINAL_EXT}" "$PARTIAL"
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
# Orphaned cloud-encryption temp blobs (.cavecms-backup-*.enc.<pid>) from an
# upload that died before cloud-push could clean them — multi-GB, so prune
# anything older than 2h to stop a failing-token nightly schedule filling disk.
find "$CAVECMS_BACKUP_DIR" -maxdepth 1 -type f -name '.cavecms-backup-*.enc.*' -mmin +120 -delete 2>/dev/null || true
# Orphaned cloud sidecar temp files (only leak on a SIGKILL of cloud-push that
# bypasses its finally). Sub-KB dotfiles, but prune for tidiness.
find "$CAVECMS_BACKUP_DIR" -maxdepth 1 -type f -name '.cavecms-backup-*.meta.*.json' -mmin +120 -delete 2>/dev/null || true
# Prune trashed archives (dashboard deletes mv into .trash-<ts>/), orphaned
# staging dirs, and orphaned upload partials (.incoming, from a timed-out /
# interrupted upload-restore that the restore orchestrator never cleaned), so
# deleted/aborted operations don't leak space.
find "$CAVECMS_BACKUP_DIR" -maxdepth 1 -type d -name '.trash-*' -mtime +30 -exec rm -rf {} + 2>/dev/null || true
find "$CAVECMS_BACKUP_DIR" -maxdepth 1 -type d -name '.staging.*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find "$CAVECMS_BACKUP_DIR/.incoming" -maxdepth 1 -type f -name 'upload-*' -mmin +120 -delete 2>/dev/null || true

# ===========================================================================
# STEP 6 — cloud upload (optional)
# ===========================================================================
# When a cloud destination is configured, the local archive (above) is the
# staging copy; cloud-push.mjs uploads it, encrypts it if a passphrase is set,
# writes a sidecar, applies remote retention, and (if KEEP_LOCAL=0) removes the
# local copy AFTER a successful upload. A failed upload KEEPS the local copy.
DEST="${CAVECMS_BACKUP_DESTINATION:-local}"
if [ "$DEST" != "local" ]; then
  bstatus running 6 "Uploading to the cloud"
  CLOUD_PUSH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup/cloud-push.mjs"
  NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ] || [ ! -f "$CLOUD_PUSH" ]; then
    bstatus failed 6 "Backup failed" "We saved a local backup, but the cloud uploader isn't available."
    post_backup_audit_terminal backup_failed "$ARCHIVE_ID" "node/cloud-push missing"
    exit 1
  fi
  # Hard wall-clock bound on the upload child so a half-open socket can't wedge
  # the engine (and hold the shared op lock) forever. `timeout` is coreutils on
  # Linux prod; skip the wrapper where it's absent (macOS dev w/o coreutils).
  CLOUD_TIMEOUT=""
  command -v timeout >/dev/null 2>&1 && CLOUD_TIMEOUT="timeout --signal=TERM 10800"
  if ! CAVECMS_CLOUD_STEP=6 CAVECMS_CLOUD_TOTAL="$TOTAL" $CLOUD_TIMEOUT "$NODE_BIN" "$CLOUD_PUSH" "${CAVECMS_BACKUP_DIR}/${FINAL_NAME}"; then
    bstatus failed 6 "Backup failed" "We saved a local backup, but couldn't upload it to the cloud. Your data is safe on this server."
    post_backup_audit_terminal backup_failed "$ARCHIVE_ID" "cloud upload failed"
    exit 1
  fi
fi

# Humanised label for the terminal modal copy (no path/timestamp jargon).
# %d (zero-padded) is portable; %-d is GNU-only.
ARCHIVE_LABEL=$(date -u +"%b %d, %Y" 2>/dev/null || echo "Today")

bstatus completed "$TOTAL" "Backup complete" "" "" "$ARCHIVE_LABEL"
post_backup_audit_terminal backup_completed "$ARCHIVE_ID"
release_op_lock "$SHARED_LOCK_PATH"; LOCK_HELD=0
rm -rf "$STAGING"; STAGING=""
exit 0
