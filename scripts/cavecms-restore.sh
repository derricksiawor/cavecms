#!/usr/bin/env bash
# scripts/cavecms-restore.sh — operator-facing restore orchestrator.
#
# Invoked from app/api/admin/backups/restore/route.ts (detached spawn) OR from
# the CLI (`cavecms restore`, foreground). Writes progress to
# $CAVECMS_RESTORE_STATUS_PATH (or <stateDir>/restore-status.json).
#
# DESTRUCTIVE: replaces the DB + uploads with the archive's contents, then
# forward-migrates + restarts. Holds maintenance mode + the shared op lock
# throughout. Auto-rolls-back to a pre-restore safety snapshot on any failure.
#
# 7 steps (RESTORE_TOTAL_STEPS):
#   1. validate        — backup-lib.mjs validate + compat gate (NO mutation)
#   2. safety-snapshot — dump current DB + tar current uploads
#   3. db              — restore the archive's database.sql.gz
#   4. uploads         — move current uploads aside, extract the archive's
#   5. migrate         — install-migrate.mjs (forward-migrate + fingerprint)
#   6. restart         — restart_app (laptop → restart_required terminal)
#   7. verify          — healthz; on any failure → roll back to safety snapshot
#
# Env contract:
#   CAVECMS_RESTORE_ARCHIVE (path, required), CAVECMS_RESTORE_IDENTITY (age
#   identity, optional), CAVECMS_RESTORE_ENV=1 (opt-in env.production restore),
#   DATABASE_URL, UPLOADS_ROOT, CAVECMS_ENV_FILE, CAVECMS_REPO_DIR,
#   CAVECMS_RESTORE_STATUS_PATH, CAVECMS_STATE_DIR, CAVECMS_LOG_DIR,
#   CAVECMS_RESTART_MODE, INTERNAL_REVALIDATE_SECRET, HEALTHZ_*,
#   CAVECMS_RESTORE_DRY_RUN=1 (dev/test only).
#
# Usage: /bin/bash scripts/cavecms-restore.sh

set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HOME_DIR="${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${HOME_DIR}/.local/share/pnpm:${HOME_DIR}/.npm-global/bin:${PATH:-}"

# ---------------------------------------------------------------------------
# Status path + shared lock resolution (mirrors cavecms-backup.sh)
# ---------------------------------------------------------------------------
if [ -n "${CAVECMS_RESTORE_STATUS_PATH:-}" ]; then
  STATUS_PATH="$CAVECMS_RESTORE_STATUS_PATH"
elif [ -n "${CAVECMS_STATE_DIR:-}" ]; then
  STATUS_PATH="$CAVECMS_STATE_DIR/restore-status.json"
else
  STATUS_PATH="/var/lib/cavecms/restore-status.json"
fi
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
HEALTHZ_URL="${CAVECMS_HEALTHZ_URL:-http://127.0.0.1:3040/healthz}"
HEALTHZ_TOKEN="${HEALTHZ_TOKEN:-}"
ARCHIVE="${CAVECMS_RESTORE_ARCHIVE:-}"
IDENTITY="${CAVECMS_RESTORE_IDENTITY:-}"

# Helpers sourced BEFORE the allowlist check so we can use the shared
# assert_allowed_status_path / acquire_op_lock (parity with the TS side).
HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=scripts/lib/cavecms-update-helpers.sh
. "${HELPERS_DIR}/cavecms-update-helpers.sh"
# shellcheck source=scripts/lib/cavecms-backup-helpers.sh
. "${HELPERS_DIR}/cavecms-backup-helpers.sh"

if ! assert_allowed_status_path "$STATUS_PATH"; then
  echo "[cavecms-restore] STATUS_PATH '$STATUS_PATH' not under allowed prefix" >&2
  exit 2
fi

mkdir -p "$(dirname "$STATUS_PATH")"
mkdir -p "$LOG_DIR" 2>/dev/null || true
if ! ( touch "$LOG_DIR/.cavecms-write-probe" 2>/dev/null && rm -f "$LOG_DIR/.cavecms-write-probe" 2>/dev/null ); then
  LOG_DIR=/tmp
fi

export PHASE_STARTED_AT
PHASE_STARTED_AT="$(now_iso)"
TOTAL=7

rstatus() { write_phase_status "$STATUS_PATH" "$TOTAL" "$@"; }

# State carried across steps for the rollback path.
SCRATCH=""
SAFETY_DIR=""
PULL_DIR=""
LOCK_HELD=0
MAINT_ON=0
MAINT_KEEP_ON=0       # set when a FAILED rollback must leave maintenance ON
UPLOADS_MOVED=0
UPLOADS_TRASH=""
MUTATION_STARTED=0    # set =1 immediately before the first destructive DB op
RESTORE_COMMITTED=0   # set =1 after migrate succeeds (data is fully restored)
CURRENT_STEP=0
ARCHIVE_ID="$(basename "${ARCHIVE:-restore}")"

read_state_at() {
  local f="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("state",""))
except Exception: print("")' "$f" 2>/dev/null || true
  else
    awk -F'"' '/"state"[[:space:]]*:/ {for(i=1;i<=NF;i++) if ($i ~ /^state$/){print $(i+2); exit}}' "$f" 2>/dev/null || true
  fi
}

# ensure_uploads_dirs — recreate all FOUR subdirs (incl .tmp) on one fs, or the
# app boot's assertSameFs (lib/media/storage.ts) will process.exit(1).
ensure_uploads_dirs() {
  for sub in originals variants brochures-private .tmp; do
    mkdir -p "${UPLOADS_ROOT}/${sub}" 2>/dev/null || true
  done
}

# ---------------------------------------------------------------------------
# rollback_to_safety — restore the pre-restore DB + uploads snapshot. Returns 0
# if the rollback genuinely succeeded (DB restored + healthz green), 1 if it
# could NOT fully restore (caller must report a hard failure + keep maintenance
# ON). Called on any failure AFTER the safety snapshot was taken.
# ---------------------------------------------------------------------------
rollback_to_safety() {
  echo "[cavecms-restore] rolling back to the pre-restore safety snapshot" >&2
  post_maintenance_toggle true || true
  MAINT_ON=1
  local ok=1
  if [ -n "$SAFETY_DIR" ] && [ -f "${SAFETY_DIR}/db.sql.gz" ]; then
    restore_database "${SAFETY_DIR}/db.sql.gz" || { echo "[cavecms-restore] safety DB restore FAILED" >&2; ok=0; }
  fi
  if [ "$UPLOADS_MOVED" = "1" ] && [ -n "$UPLOADS_TRASH" ]; then
    for sub in originals variants brochures-private; do
      rm -rf "${UPLOADS_ROOT:?}/${sub}" 2>/dev/null || true
      [ -d "${UPLOADS_TRASH}/${sub}" ] && mv "${UPLOADS_TRASH}/${sub}" "${UPLOADS_ROOT}/${sub}" 2>/dev/null || true
    done
  fi
  ensure_uploads_dirs
  restart_app || true
  verify_healthz 2 90 || { echo "[cavecms-restore] healthz still failing after rollback" >&2; ok=0; }
  [ "$ok" = "1" ] && return 0 || return 1
}

# ---------------------------------------------------------------------------
# EXIT trap
# ---------------------------------------------------------------------------
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    local cur
    cur=$( (read_state_at "$STATUS_PATH") || true )
    case "$cur" in
      completed|restart_required|rolled_back|failed) ;;
      *)
        rstatus failed 0 "Restore failed" "The restore couldn't be completed." || true
        post_backup_audit_terminal restore_failed "$ARCHIVE_ID" "exit ${rc}" || true
        ;;
    esac
  fi
  # Leave maintenance ON if a failed rollback set MAINT_KEEP_ON (a down /
  # inconsistent site is safer behind a 503 than exposed).
  if [ "$MAINT_KEEP_ON" != "1" ] && [ "$MAINT_ON" = "1" ]; then
    post_maintenance_toggle false || true
  fi
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH" 2>/dev/null || true
  [ -n "$SAFETY_DIR" ] && rm -rf "$SAFETY_DIR" 2>/dev/null || true
  [ -n "$PULL_DIR" ] && rm -rf "$PULL_DIR" 2>/dev/null || true
  if [ "${CAVECMS_RESTORE_CLEANUP_ARCHIVE:-0}" = "1" ] && [ -n "$ARCHIVE" ]; then
    rm -f "$ARCHIVE" 2>/dev/null || true
  fi
  [ "$LOCK_HELD" = "1" ] && release_op_lock "$SHARED_LOCK_PATH" 2>/dev/null || true
}

# on_term — a SIGTERM mid-restore must NOT leave a half-applied DB exposed.
on_term() {
  set +e
  trap '' TERM  # no re-entry
  local cur; cur=$( (read_state_at "$STATUS_PATH") || true )
  case "$cur" in
    completed|restart_required|rolled_back|failed) exit 143 ;;
  esac
  if [ "$RESTORE_COMMITTED" = "1" ]; then
    # Data is fully restored; only the restart/verify was interrupted. Clear
    # maintenance and ask for a manual restart — do NOT undo a good restore.
    [ "$MAINT_ON" = "1" ] && post_maintenance_toggle false || true
    MAINT_ON=0
    rstatus restart_required 7 "Restore complete — restart your CaveCMS process to finish"
    post_backup_audit_terminal restore_completed "$ARCHIVE_ID"
  elif [ "$MUTATION_STARTED" = "1" ]; then
    fail_and_rollback "$CURRENT_STEP" "Restore interrupted" "The restore was interrupted; your previous data was put back."
  else
    [ "$MAINT_ON" = "1" ] && post_maintenance_toggle false || true
    MAINT_ON=0
    rstatus failed "$CURRENT_STEP" "Restore interrupted" "The restore was interrupted before any changes were made."
    post_backup_audit_terminal restore_failed "$ARCHIVE_ID" "interrupted"
  fi
  exit 143
}

fail_and_rollback() {
  local step="$1" label="$2" detail="$3"
  if rollback_to_safety; then
    rstatus rolled_back "$step" "$label" "$detail"
    post_backup_audit_terminal restore_rolled_back "$ARCHIVE_ID" "$detail"
  else
    # The rollback itself could not fully restore the previous data — surface a
    # hard failure and KEEP maintenance ON (the EXIT trap honours MAINT_KEEP_ON).
    MAINT_KEEP_ON=1
    rstatus failed "$step" "Restore failed — needs attention" "We couldn't fully put your previous data back. Your site is paused for safety. Recovery logs are on the server."
    post_backup_audit_terminal restore_failed "$ARCHIVE_ID" "rollback_failed: ${detail}"
  fi
  exit 1
}

# Register traps AFTER all handler functions are defined (so a signal arriving
# during startup can never invoke an undefined function).
trap on_exit EXIT
# pm2 reload leaks SIGINT to the orchestrator during restart — ignore BOTH INT
# and HUP (matches the updater). TERM → on_term (rollback-aware) so a
# `systemctl stop` / pm2 stop / CLI-timeout SIGTERM can't bypass the rollback.
trap '' INT HUP
trap on_term TERM

# fail_validate — step-1 failure (pre-mutation, no snapshot taken yet): write a
# failed status + audit and exit. NO rollback (nothing was changed).
fail_validate() {
  local detail="$1"
  rstatus failed 1 "Restore not possible" "$detail"
  post_backup_audit_terminal restore_failed "$ARCHIVE_ID" "validate: ${detail}"
  exit 1
}

# ---------------------------------------------------------------------------
# Dry-run
# ---------------------------------------------------------------------------
if [ "${CAVECMS_RESTORE_DRY_RUN:-0}" = "1" ]; then
  rstatus validating 1 "Checking the archive"; sleep 1
  rstatus restoring 2 "Safeguarding current data"; sleep 1
  rstatus restoring 3 "Restoring your content"; sleep 1
  rstatus restoring 4 "Restoring your media"; sleep 1
  rstatus restoring 5 "Bringing things up to date"; sleep 1
  rstatus restarting 6 "Restarting your site"; sleep 1
  rstatus completed 7 "Restore complete"
  exit 0
fi

# Acquire the shared op lock FIRST — before ANY status write — using the same
# existence/O_EXCL scheme + lock file the updater uses. On contention exit
# cleanly (nothing mutated; the modal polls the winner's status). The route/CLI
# pre-check 409'd the common case; this is the authoritative cross-process gate.
if ! acquire_op_lock "$SHARED_LOCK_PATH"; then
  echo "[cavecms-restore] another operation holds the lock — exiting without changes" >&2
  exit 0
fi
LOCK_HELD=1

# ===========================================================================
# STEP 0 — cloud download (optional, pre-mutation)
# ===========================================================================
# When restoring from a cloud destination, fetch the archive FIRST: cloud-pull
# downloads the blob, verifies sha256 against the sidecar, and decrypts it if it
# was passphrase-encrypted — all before any mutation. ARCHIVE is then the local
# plaintext path the rest of the restore consumes unchanged.
if [ "${CAVECMS_RESTORE_SOURCE:-file}" = "cloud" ]; then
  rstatus validating 1 "Finding your backup in the cloud"
  CLOUD_PULL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup/cloud-pull.mjs"
  NODE_BIN="$(command -v node || true)"
  PULL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cavecms-pull.XXXXXX")"
  PULL_OUT="${PULL_DIR}/path.txt"
  if [ -z "$NODE_BIN" ] || [ ! -f "$CLOUD_PULL" ]; then
    rstatus failed 1 "Restore failed" "The cloud downloader isn't available on this install."
    exit 1
  fi
  if ! CAVECMS_RESTORE_DOWNLOAD_DIR="$PULL_DIR" CAVECMS_RESTORE_PULL_OUT="$PULL_OUT" "$NODE_BIN" "$CLOUD_PULL"; then
    rstatus failed 1 "Restore failed" "We couldn't download the backup from the cloud. Nothing was changed."
    exit 1
  fi
  ARCHIVE="$(cat "$PULL_OUT" 2>/dev/null || true)"
  if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
    rstatus failed 1 "Restore failed" "The downloaded backup couldn't be read."
    exit 1
  fi
fi

# ===========================================================================
# STEP 1 — validate + compat gate (NO mutation)
# ===========================================================================
CURRENT_STEP=1
rstatus validating 1 "Checking the archive"
[ -n "$ARCHIVE" ] || { rstatus failed 1 "Restore failed" "No backup file was provided."; exit 2; }
[ -f "$ARCHIVE" ] || { rstatus failed 1 "Restore failed" "That backup file couldn't be found."; exit 2; }

# Locate the bundled validator (state-dir copy first for offline use).
BACKUP_LIB=""
for cand in "${CAVECMS_STATE_DIR:-}/backup-lib.mjs" "${REPO_DIR}/scripts/backup/backup-lib.mjs"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { BACKUP_LIB="$cand"; break; }
done
[ -n "$BACKUP_LIB" ] || { rstatus failed 1 "Restore failed" "The restore tool is missing from this install."; exit 1; }

# Decrypt to a working copy if it's an .age archive (cluster + new format).
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/cavecms-restore.XXXXXX")"
WORK_ARCHIVE="$ARCHIVE"
case "$ARCHIVE" in
  *.age)
    [ -n "$IDENTITY" ] && [ -f "$IDENTITY" ] || fail_validate "This backup is encrypted; an identity file is required to restore it."
    command -v age >/dev/null 2>&1 || fail_validate "This encrypted backup needs the 'age' tool, which isn't installed here."
    if ! age --decrypt -i "$IDENTITY" "$ARCHIVE" > "${SCRATCH}/archive.tar.gz" 2>>"${LOG_DIR}/restore-validate.log"; then
      fail_validate "We couldn't decrypt this backup with the provided key."
    fi
    WORK_ARCHIVE="${SCRATCH}/archive.tar.gz"
    ;;
esac

# Validate (manifest + checksums + zip-slip).
if ! node "$BACKUP_LIB" validate "$WORK_ARCHIVE" >>"${LOG_DIR}/restore-validate.log" 2>&1; then
  fail_validate "This file doesn't look like a valid CaveCMS backup."
fi

# Compat gate (downgrade / floor / migrator-encoding refuse; 0024 warn).
INSTALL_VERSION="${CAVECMS_RELEASE_VERSION:-}"
if [ -z "$INSTALL_VERSION" ]; then
  for pj in "${REPO_DIR}/package.json" "${REPO_DIR}/.next/standalone/package.json"; do
    [ -f "$pj" ] && INSTALL_VERSION=$(awk -F'"' '/"version":/ {print $4; exit}' "$pj") && break
  done
fi
[ -z "$INSTALL_VERSION" ] && INSTALL_VERSION="0.0.0"
INSTALL_FP=$(db_schema_fingerprint 2>/dev/null || echo "")
# compat exit code IS the refuse signal (0 = ok, 1 = refuse). Parse the JSON's
# reason/warnings with NODE (already present), NOT gawk's match($0,re,arr) which
# is a GNU-awk extension that silently fails on macOS/BSD awk → would drop the
# 0024 data-loss warning + the refuse reason on the laptop surface.
COMPAT_REFUSE=0
COMPAT_JSON=$(node "$BACKUP_LIB" compat "$WORK_ARCHIVE" --install-version "$INSTALL_VERSION" --install-fingerprint "$INSTALL_FP" 2>>"${LOG_DIR}/restore-validate.log") || COMPAT_REFUSE=1
COMPAT_REASON=$(printf '%s' "$COMPAT_JSON" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).reason||""))}catch{}})' 2>/dev/null || true)
COMPAT_WARN=$(printf '%s' "$COMPAT_JSON" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const w=JSON.parse(s).warnings||[];process.stdout.write(Array.isArray(w)?w.join(" "):"")}catch{}})' 2>/dev/null || true)
if [ "$COMPAT_REFUSE" = "1" ]; then
  rstatus failed 1 "Restore not possible" "${COMPAT_REASON:-This backup cannot be restored to this site.}"
  post_backup_audit_terminal restore_failed "$ARCHIVE_ID" "compat refuse"
  exit 1
fi

# ===========================================================================
# STEP 2 — pre-restore safety snapshot + maintenance ON (lock already held)
# ===========================================================================
CURRENT_STEP=2
rstatus restoring 2 "Safeguarding current data" "" "$COMPAT_WARN"

# Sweep stale uploads-root trash from a prior hard-crashed restore (the backup
# engine's prune only touches CAVECMS_BACKUP_DIR, not UPLOADS_ROOT).
find "$UPLOADS_ROOT" -maxdepth 1 -type d -name '.trash-*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true

# Disk pre-check on the UPLOADS filesystem: the safety uploads tar + the restored
# uploads extraction both land near UPLOADS_ROOT. Estimate ~2× current uploads
# size + margin vs free space; refuse before mutating if insufficient.
_UP_KB=$(du_kb "${UPLOADS_ROOT}/originals" "${UPLOADS_ROOT}/variants" "${UPLOADS_ROOT}/brochures-private")
if ! assert_disk_for "$UPLOADS_ROOT" "$(( _UP_KB * 22 / 10 + 51200 ))"; then
  rstatus failed 2 "Restore failed" "There isn't enough free disk space to restore safely."
  post_backup_audit_terminal restore_failed "$ARCHIVE_ID" "insufficient disk"
  exit 1
fi

SAFETY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cavecms-restore-safety.XXXXXX")"
if ! dump_database "${SAFETY_DIR}/db.sql.gz" >/dev/null; then
  rstatus failed 2 "Restore failed" "We couldn't safeguard your current data, so the restore was stopped."
  post_backup_audit_terminal restore_failed "$ARCHIVE_ID" "safety db snapshot failed"
  exit 1
fi
# Safety snapshot of current uploads (best-effort; rollback also keeps the
# moved-aside trash copy).
if [ -d "$UPLOADS_ROOT" ]; then
  _safety_subs=()
  for s in originals variants brochures-private; do
    [ -d "${UPLOADS_ROOT}/${s}" ] && _safety_subs+=("$s")
  done
  if [ "${#_safety_subs[@]}" -gt 0 ]; then
    ( cd "$UPLOADS_ROOT" && tar -czf "${SAFETY_DIR}/uploads.tar.gz" --exclude='.tmp' "${_safety_subs[@]}" 2>/dev/null ) || true
  fi
fi

post_maintenance_toggle true || true
MAINT_ON=1

# Extract the archive payloads into scratch.
if ! tar -xzf "$WORK_ARCHIVE" -C "$SCRATCH" database.sql.gz uploads.tar.gz 2>>"${LOG_DIR}/restore.log"; then
  fail_and_rollback 2 "Restore failed" "We couldn't read the backup contents."
fi

# ===========================================================================
# STEP 3 — restore DB (first DESTRUCTIVE step)
# ===========================================================================
CURRENT_STEP=3
rstatus restoring 3 "Restoring your content"
MUTATION_STARTED=1
# DROP all existing tables/views FIRST so an OLDER dump (which only DROP+CREATEs
# the tables it knows about) doesn't leave the install's NEWER tables behind —
# those would make the subsequent forward-migrate re-run their CREATE and fail.
if ! drop_all_tables; then
  fail_and_rollback 3 "Restore failed" "We couldn't prepare the database. Your previous data was put back."
fi
if ! restore_database "${SCRATCH}/database.sql.gz"; then
  fail_and_rollback 3 "Restore failed" "We couldn't restore your content. Your previous data was put back."
fi
# Post-load migrator-encoding guard — refuse if not drizzle-hash.
ENC=$(detect_migrator_encoding 2>/dev/null || echo "unknown")
if [ "$ENC" != "drizzle-hash" ]; then
  fail_and_rollback 3 "Restore failed" "This backup uses an incompatible format. Your previous data was put back."
fi

# ===========================================================================
# STEP 4 — restore uploads
# ===========================================================================
CURRENT_STEP=4
rstatus restoring 4 "Restoring your media"
UPLOADS_TRASH="${UPLOADS_ROOT}/.trash-$(date -u +%Y%m%d-%H%M%S).$$"
mkdir -p "$UPLOADS_TRASH"
for sub in originals variants brochures-private; do
  [ -d "${UPLOADS_ROOT}/${sub}" ] && mv "${UPLOADS_ROOT}/${sub}" "${UPLOADS_TRASH}/${sub}" 2>/dev/null || true
done
UPLOADS_MOVED=1
# `--no-same-owner` (portable on GNU + bsdtar) so a crafted archive can't set
# ownership on extract. The inner tar's member paths were already enumerated +
# rejected for symlink/hardlink/absolute/`..` entries by backup-lib.mjs
# validateArchive (run at step 1), so plain extraction here can't traverse out.
if ! tar --no-same-owner -xzf "${SCRATCH}/uploads.tar.gz" -C "$UPLOADS_ROOT" 2>>"${LOG_DIR}/restore.log"; then
  fail_and_rollback 4 "Restore failed" "We couldn't restore your media. Your previous files were put back."
fi
ensure_uploads_dirs

# ===========================================================================
# STEP 5 — forward-migrate
# ===========================================================================
CURRENT_STEP=5
rstatus restoring 5 "Bringing things up to date"
# Wall-clock guard so a migration that blocks on a held lock can't wedge the
# restore (and maintenance + the shared lock) forever. `timeout` is GNU/most-
# Linux; absent on stock macOS → run unguarded there (the laptop migrate is
# fast + the CLI path has its own 60-min spawnSync timeout).
_MIGRATE_TIMEOUT=""
command -v timeout >/dev/null 2>&1 && _MIGRATE_TIMEOUT="timeout 30m"
if ! CAVECMS_ALLOW_NONEMPTY_DB=1 $_MIGRATE_TIMEOUT node --env-file="$ENV_FILE" "${REPO_DIR}/scripts/install-migrate.mjs" >>"${LOG_DIR}/restore-migrate.log" 2>&1; then
  fail_and_rollback 5 "Restore failed" "We couldn't finish updating your data. Your previous data was put back."
fi
# Data is fully restored + migrated. From here a SIGTERM should NOT undo the
# restore (on_term writes restart_required instead of rolling back).
RESTORE_COMMITTED=1

# Optional env.production restore (--restore-env).
if [ "${CAVECMS_RESTORE_ENV:-0}" = "1" ]; then
  if tar -tzf "$WORK_ARCHIVE" env.production >/dev/null 2>&1; then
    tar -xzf "$WORK_ARCHIVE" -C "$(dirname "$ENV_FILE")" env.production 2>>"${LOG_DIR}/restore.log" || true
    [ -f "$(dirname "$ENV_FILE")/env.production" ] && chmod 600 "$(dirname "$ENV_FILE")/env.production" 2>/dev/null || true
  fi
fi

# ===========================================================================
# STEP 6 — restart (maintenance STAYS ON through verify — mirrors the updater)
# ===========================================================================
CURRENT_STEP=6
rstatus restarting 6 "Restarting your site"
restart_app

if [ "${CAVECMS_RESTART_MODE:-pm2}" = "laptop" ]; then
  # No service manager: the operator must restart the process manually to reset
  # DB connections/caches after the swap. Clear maintenance NOW so the site is
  # live once they restart (nothing else would turn it off from a terminal
  # restart_required state), then signal restart_required.
  post_maintenance_toggle false || true; MAINT_ON=0
  rstatus restart_required 7 "Restore complete — restart your CaveCMS process to finish" "" "$COMPAT_WARN"
  post_backup_audit_terminal restore_completed "$ARCHIVE_ID"
  rm -rf "$UPLOADS_TRASH" 2>/dev/null || true
  release_op_lock "$SHARED_LOCK_PATH"; LOCK_HELD=0
  rm -rf "$SCRATCH" "$SAFETY_DIR"; SCRATCH=""; SAFETY_DIR=""
  exit 0
fi

# ===========================================================================
# STEP 7 — verify (maintenance still ON → a failed verify rolls back behind a
# 503, not a broken public site). Only clear maintenance AFTER a green verify.
# ===========================================================================
CURRENT_STEP=7
rstatus restarting 7 "Verifying"
if ! verify_healthz 2 120; then
  fail_and_rollback 7 "Restore failed" "Your site didn't come back up cleanly, so the previous version was put back."
fi
post_maintenance_toggle false || true; MAINT_ON=0

rstatus completed 7 "Restore complete" "" "$COMPAT_WARN"
post_backup_audit_terminal restore_completed "$ARCHIVE_ID"
rm -rf "$UPLOADS_TRASH" 2>/dev/null || true
release_op_lock "$SHARED_LOCK_PATH"; LOCK_HELD=0
rm -rf "$SCRATCH" "$SAFETY_DIR"; SCRATCH=""; SAFETY_DIR=""
exit 0
