#!/usr/bin/env bash
# scripts/cavecms-update.sh — operator-friendly self-update orchestrator.
#
# Invoked from app/api/admin/updates/apply/route.ts via a detached
# spawn. Writes progress to /var/lib/cavecms/update-status.json (or
# $CAVECMS_UPDATE_STATUS_PATH) so the live progress modal can poll.
#
# 6 steps:
#   1. preflight        — disk space, network, DB ping
#   2. fetch            — git fetch + verify target SHA on origin/main
#   3. install_migrate  — mysqldump backup + pnpm install + pnpm db:migrate
#   4. build            — pnpm build
#   5. restart          — pm2 reload + write deploy invariants to env file
#                         + pm2 save (so reboot picks up new CAVECMS_COMMIT)
#   6. verify           — poll /healthz; on failure roll back fully
#
# This script DOES NOT replace scripts/deploy.sh. deploy.sh handles
# CI-pushed tarball releases for the canonical production deploy path
# (atomic symlink, mysqldump backup, etc.). cavecms-update.sh is the
# in-app one-click path for operators running the simpler single-tree
# git deploy. Refuses to run on tarball-mode deployments.
#
# Dry-run mode (CAVECMS_UPDATE_DRY_RUN=1):
#   Walks the state machine on a timer without touching git/pnpm/pm2.
#   Used by Playwright + the manual operator demo.
#
# Usage:
#   /bin/bash scripts/cavecms-update.sh <target-sha>

set -euo pipefail
# `inherit_errexit` makes subshells inherit `errexit`. Bash 4.4+ only;
# macOS ships bash 3.2 (Apple GPLv2 freeze). Soft-enable so the dev-
# on-macOS path still runs while prod-on-Linux gets the stricter
# subshell semantics.
shopt -s inherit_errexit 2>/dev/null || true

# Hardened PATH — under systemd, the spawned shell may inherit a
# minimal PATH that excludes pm2/pnpm/corepack. Augment defensively.
HOME_DIR="${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${HOME_DIR}/.local/share/pnpm:${HOME_DIR}/.npm-global/bin:${PATH:-}"

# ---------------------------------------------------------------------------
# Arg validation
#
# Usage: cavecms-update.sh [--force] <target-sha>
#
# `--force` skips the "current SHA already matches HEAD" short-path and
# deletes `.next/` before rebuilding. Used by the admin UI's "Re-run
# install" button when the operator needs to recover from a corrupted
# build / stuck migration without bumping the version.
# ---------------------------------------------------------------------------
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --) shift; break ;;
    -*) echo "[cavecms-update] unknown flag: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
if [ $# -lt 1 ]; then
  echo "[cavecms-update] usage: cavecms-update.sh [--force] <target-sha>" >&2
  exit 2
fi
TARGET_SHA="$1"
if [[ ! "$TARGET_SHA" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
  echo "[cavecms-update] invalid target SHA '$TARGET_SHA'" >&2
  exit 2
fi
TARGET_SHA="$(echo "$TARGET_SHA" | tr 'A-F' 'a-f')"
# Allow CAVECMS_UPDATE_FORCE=1 env to set force without re-spawning the
# script — apply route sets this when it spawns the child, so an
# operator clicking "Re-run install" doesn't need a CLI flag.
if [ "${CAVECMS_UPDATE_FORCE:-0}" = "1" ]; then
  FORCE=1
fi

FROM_SHA="${CAVECMS_UPDATE_FROM:-unknown}"
STATUS_PATH="${CAVECMS_UPDATE_STATUS_PATH:-/var/lib/cavecms/update-status.json}"
HEALTHZ_URL="${CAVECMS_HEALTHZ_URL:-http://127.0.0.1:3040/healthz}"
HEALTHZ_TOKEN="${HEALTHZ_TOKEN:-}"
REPO_DIR="${CAVECMS_REPO_DIR:-$(pwd)}"
LOG_DIR="${CAVECMS_LOG_DIR:-/var/log/cavecms}"
ENV_FILE="${CAVECMS_ENV_FILE:-/etc/cavecms/env.production}"
LOCK_PATH="${STATUS_PATH}.lock"

# Path allowlist — same guard as lib/updates/statusFile.ts. Refuse if
# operator points STATUS_PATH at /etc/cron.d/* or similar.
case "$STATUS_PATH" in
  /var/lib/cavecms/*|/tmp/*|/var/folders/*) ;;
  *)
    echo "[cavecms-update] STATUS_PATH '$STATUS_PATH' not under allowed prefix" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$STATUS_PATH")"
# LOG_DIR writability probe — `mkdir -p` returns 0 when the path
# exists, even if we lack write permission on it (common when
# /var/log/cavecms is owned by root and we run as a non-root user).
# `touch` a sentinel to verify we can actually write before
# committing to LOG_DIR; fall back to /tmp if we can't.
mkdir -p "$LOG_DIR" 2>/dev/null || true
if ! ( touch "$LOG_DIR/.cavecms-write-probe" 2>/dev/null && rm -f "$LOG_DIR/.cavecms-write-probe" 2>/dev/null ); then
  LOG_DIR=/tmp
fi

# ---------------------------------------------------------------------------
# Status helpers — atomic JSON write via tmp + rename(2).
# ---------------------------------------------------------------------------
# Portable ISO-ish timestamp. macOS BSD `date` does not support %N
# (nanoseconds); GNU date does. We emit second-precision so the output
# is identical across both, and the dev-on-macOS / prod-on-Linux paths
# write byte-identical fields.
now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Portable random suffix — BSD/macOS `date +%s%N` emits a literal "%N".
# Use ${RANDOM} (bash builtin, both 3.2 and 5.x). $$.$RANDOM is unique
# enough for tmp filename collision avoidance under a single PID.
rand_suffix() { echo "$$.$RANDOM.$RANDOM"; }

# write_status <state> <step> <stepLabel> [error] [log]
write_status() {
  local state="$1"
  local step="$2"
  local label="$3"
  local err="${4:-}"
  local log="${5:-}"

  local tmp="${STATUS_PATH}.tmp.$(rand_suffix)"
  # JSON-escape strings. Prefer jq when available (handles every
  # control byte + non-ASCII correctly); else fall back to awk for
  # the common case (\\, ", \r, \n, \t). The inputs are our own copy
  # so the awk fallback's gap on bytes < 0x20 (apart from CR/LF/TAB)
  # is acceptable — we never write raw stderr into these fields.
  local esc_label esc_err esc_log
  if command -v jq >/dev/null 2>&1; then
    # jq -Rs . wraps the input in JSON quotes; we want only the
    # ESCAPED INNER content, so strip the surrounding quotes.
    esc_label=$(printf '%s' "$label" | jq -Rs . | awk '{print substr($0, 2, length($0)-2)}')
    esc_err=$(printf '%s' "$err" | jq -Rs . | awk '{print substr($0, 2, length($0)-2)}')
    esc_log=$(printf '%s' "$log" | jq -Rs . | awk '{print substr($0, 2, length($0)-2)}')
  else
    esc_label=$(printf '%s' "$label" | awk 'BEGIN{ORS=""} {gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\r/, ""); gsub(/\n/, "\\n"); gsub(/\t/, "\\t"); print}')
    esc_err=$(printf '%s' "$err" | awk 'BEGIN{ORS=""} {gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\r/, ""); gsub(/\n/, "\\n"); gsub(/\t/, "\\t"); print}')
    esc_log=$(printf '%s' "$log" | awk 'BEGIN{ORS=""} {gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\r/, ""); gsub(/\n/, "\\n"); gsub(/\t/, "\\t"); print}')
  fi

  cat > "$tmp" << EOF
{
  "state": "$state",
  "step": $step,
  "totalSteps": 6,
  "startedAt": "${STARTED_AT}",
  "updatedAt": "$(now_iso)",
  "fromSha": "$FROM_SHA",
  "toSha": "$TARGET_SHA",
  "stepLabel": "$esc_label",
  "error": "$esc_err",
  "log": "$esc_log"
}
EOF
  chmod 0600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$STATUS_PATH"
}

# Read the current state from the status file using python3 (portable
# JSON parse, no field-position guessing). Falls back to a coarse awk
# grep if python3 isn't available.
read_status_state() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
try:
  print(json.load(open(sys.argv[1])).get("state",""))
except Exception:
  print("")' "$STATUS_PATH" 2>/dev/null || true
  else
    awk -F'"' '/"state"[[:space:]]*:/ {for(i=1;i<=NF;i++) if ($i ~ /^state$/) {print $(i+2); exit}}' "$STATUS_PATH" 2>/dev/null || true
  fi
}

STARTED_AT="$(now_iso)"
# Export so the python3 subprocess in post_audit_terminal can read it
# via os.environ to compute durationMs.
export STARTED_AT

# Trap unexpected exits — if anything below fails outside the explicit
# step error handlers, we still flush a failed status so the modal
# doesn't spin forever. Also handle SIGTERM/SIGINT explicitly so an
# operator's kill or a pm2 reload kill doesn't leave the lock + an
# in-progress status orphaned.
on_exit() {
  local rc=$?
  if [ $rc -ne 0 ]; then
    local current_state
    current_state=$(read_status_state)
    case "$current_state" in
      completed|failed|rolled_back) ;;
      *)
        # Use bash arithmetic ternary safely.
        local step
        if [ "${CURRENT_STEP:-0}" -gt 0 ]; then step="$CURRENT_STEP"; else step=1; fi
        write_status "failed" "$step" "Something went wrong" "Your site is still online on the previous version. Try again in a moment." ""
        # Best-effort terminal audit — declare functions may not be
        # defined yet if the trap fires before the helpers are loaded.
        if declare -F post_audit_terminal >/dev/null 2>&1; then
          post_audit_terminal failed "unexpected_exit"
        fi
        ;;
    esac
  fi
  rm -f "$LOCK_PATH" 2>/dev/null || true
}
on_signal() {
  local sig="$1"
  write_status "failed" "${CURRENT_STEP:-1}" "Your update was interrupted" "Your previous version is still running. You can try again." ""
  if declare -F post_audit_terminal >/dev/null 2>&1; then
    post_audit_terminal failed "interrupted_by_signal"
  fi
  rm -f "$LOCK_PATH" 2>/dev/null || true
  trap - EXIT
  exit 130
}
CURRENT_STEP=0
trap on_exit EXIT
trap 'on_signal SIGTERM' TERM
trap 'on_signal SIGINT' INT

# Rollback helper — defined BEFORE the steps that call it so bash has
# registered the function in its table by the time we hit a failure.
#
# The rollback verifies its own success via /healthz after pm2 reload.
# If the rollback ITSELF fails, we surface a distinct hard-failure
# state so the operator knows their site may be offline.
rollback_to_previous() {
  local prev="$1"
  local had_migration="${2:-0}"
  local backup_dump="${3:-}"
  echo "[cavecms-update] rolling back to $prev (had_migration=$had_migration, backup=$backup_dump)" >&2

  # Pre-flight: if we ran a migration but don't have a usable schema
  # backup (SKIPPED or empty), rolling back code only would leave
  # schema ahead of code — the old app would 500 on missing columns.
  # Refuse instead, with copy that tells the operator their site is
  # on the new (partially-updated) version and what to do next.
  if [ "$had_migration" = "1" ]; then
    if [ -z "$backup_dump" ] || [ "$backup_dump" = "SKIPPED" ] || [ ! -f "$backup_dump" ]; then
      write_status "failed" "${CURRENT_STEP:-1}" "Your data was updated but the rest of the install failed" "Your site is on the new database structure but the new code couldn't be installed. Contact support — we have logs to recover from." ""
      return 1
    fi
  fi

  (
    cd "$REPO_DIR"
    # Restore code first.
    git reset --hard "$prev" || return 1
    # Restore the schema if a migration ran.
    if [ "$had_migration" = "1" ]; then
      restore_db_backup "$backup_dump" || return 1
    fi
    pnpm install --frozen-lockfile >/dev/null 2>&1 || return 1
    pnpm build >/dev/null 2>&1 || return 1
    pm2 reload ecosystem.config.cjs --update-env >/dev/null 2>&1 || return 1
  )
  local rc=$?
  if [ $rc -ne 0 ]; then
    write_status "failed" "${CURRENT_STEP:-1}" "We tried to restore your previous version but couldn't" "Your site may be offline — contact support immediately." ""
    return 1
  fi
  # Verify rollback health before claiming success.
  local healthz_args=()
  if [ -n "$HEALTHZ_TOKEN" ]; then
    healthz_args=(-H "Authorization: Bearer $HEALTHZ_TOKEN")
  fi
  local success=0
  local i
  for i in $(seq 1 15); do
    sleep 2
    if curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "$HEALTHZ_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      success=$((success + 1))
      [ $success -ge 2 ] && break
    fi
  done
  if [ $success -lt 2 ]; then
    write_status "failed" "${CURRENT_STEP:-1}" "We restored your previous version but it isn't responding" "Your site may be offline — contact support immediately." ""
    return 1
  fi
  return 0
}

# mysqldump the cavecms DB to $LOG_DIR/pre-update-<sha>.sql.gz.
#
# Returns one of three sentinels on stdout (so the caller can tell
# "we don't have a backup-net" from "we tried and failed"):
#   SKIPPED          — mysqldump/python3 not installed, OR no DATABASE_URL.
#                      Acceptable on dev / first-time-setup boxes.
#   <path/to/file>   — backup ran successfully; restore_db_backup
#                      can later restore from this path.
# A NON-zero exit code on stderr-empty stdout indicates an attempted-
# and-failed backup — caller MUST refuse to proceed past the migration
# step.
db_backup() {
  local sha="$1"
  local out="${LOG_DIR}/pre-update-${sha}.sql.gz"
  if ! command -v mysqldump >/dev/null 2>&1; then
    echo "SKIPPED"; return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIPPED"; return 0
  fi
  local db_url="${DATABASE_URL:-}"
  if [ -z "$db_url" ]; then echo "SKIPPED"; return 0; fi

  # Safe URL parse via python3 — handles URL-encoded passwords, raw
  # @/: in the credential portion, missing port, etc. Output is
  # newline-separated host\nport\nuser\npass\ndb.
  local parsed
  parsed=$(DATABASE_URL="$db_url" python3 -c '
import os, sys
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["DATABASE_URL"])
print(u.hostname or "127.0.0.1")
print(u.port or 3306)
print(unquote(u.username or ""))
print(unquote(u.password or ""))
print((u.path or "/").lstrip("/").split("?")[0])
') || { echo ""; return 1; }
  local db_host db_port db_user db_pass db_name
  # awk-based line picker (sed is banned per project conventions).
  db_host=$(echo "$parsed" | awk 'NR==1')
  db_port=$(echo "$parsed" | awk 'NR==2')
  db_user=$(echo "$parsed" | awk 'NR==3')
  db_pass=$(echo "$parsed" | awk 'NR==4')
  db_name=$(echo "$parsed" | awk 'NR==5')
  if [ -z "$db_name" ]; then echo ""; return 1; fi

  # Write credentials to a real temp file rather than a process-
  # substitution `<(...)` — MariaDB's mysqldump rejects /dev/fd/* paths
  # via `--defaults-extra-file=` ("unknown variable
  # 'defaults-extra-file=/dev/fd/63'"). Real file, mode 0600, cleaned
  # up after dump regardless of outcome.
  #
  # `--column-statistics=0` is a MySQL 8 flag MariaDB doesn't know
  # about — dropped. The flag was a no-op for MariaDB targets and a
  # hard error: "unknown variable 'column-statistics=0'".
  local cred_file
  cred_file=$(mktemp "${TMPDIR:-/tmp}/cavecms-mysqldump-cred.XXXXXX")
  chmod 0600 "$cred_file"
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' \
    "$db_host" "$db_port" "$db_user" "$db_pass" > "$cred_file"

  local dump_rc=0
  mysqldump --defaults-extra-file="$cred_file" \
    --single-transaction --skip-lock-tables \
    "$db_name" 2>"${LOG_DIR}/db-backup.log" | gzip > "$out" \
    || dump_rc=$?

  rm -f "$cred_file"

  if [ $dump_rc -eq 0 ] && [ -s "$out" ]; then
    echo "$out"
  else
    rm -f "$out"
    echo ""
    return 1
  fi
}

restore_db_backup() {
  local dump="$1"
  if [ ! -f "$dump" ]; then return 1; fi
  local db_url="${DATABASE_URL:-}"
  if [ -z "$db_url" ]; then return 1; fi
  if ! command -v python3 >/dev/null 2>&1; then return 1; fi

  local parsed
  parsed=$(DATABASE_URL="$db_url" python3 -c '
import os, sys
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["DATABASE_URL"])
print(u.hostname or "127.0.0.1")
print(u.port or 3306)
print(unquote(u.username or ""))
print(unquote(u.password or ""))
print((u.path or "/").lstrip("/").split("?")[0])
') || return 1
  local db_host db_port db_user db_pass db_name
  # awk-based line picker (sed is banned per project conventions).
  db_host=$(echo "$parsed" | awk 'NR==1')
  db_port=$(echo "$parsed" | awk 'NR==2')
  db_user=$(echo "$parsed" | awk 'NR==3')
  db_pass=$(echo "$parsed" | awk 'NR==4')
  db_name=$(echo "$parsed" | awk 'NR==5')
  if [ -z "$db_name" ]; then return 1; fi

  # Same MariaDB / process-substitution constraint as db_backup —
  # real temp file with creds, mode 0600, cleaned up regardless.
  local cred_file
  cred_file=$(mktemp "${TMPDIR:-/tmp}/cavecms-mysql-cred.XXXXXX")
  chmod 0600 "$cred_file"
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' \
    "$db_host" "$db_port" "$db_user" "$db_pass" > "$cred_file"

  local restore_rc=0
  gunzip -c "$dump" | mysql --defaults-extra-file="$cred_file" \
    "$db_name" 2>>"${LOG_DIR}/db-restore.log" \
    || restore_rc=$?

  rm -f "$cred_file"
  return $restore_rc
}

# ---------------------------------------------------------------------------
# Internal-endpoint helpers — POST to /api/internal/updates/* over
# loopback with the bearer token. Best-effort: if the secret isn't
# available (dev, first-time setup) or the endpoint is down, we log
# and continue. The update flow doesn't depend on these calls
# succeeding — they're for UX (maintenance page) and observability
# (audit history) only.
# ---------------------------------------------------------------------------
# Derive the loopback base URL from HEALTHZ_URL by stripping the trailing
# `/healthz` path. If HEALTHZ_URL is non-standard, fall back to the env
# var CAVECMS_INTERNAL_URL or the conventional 127.0.0.1:3040.
internal_base_url() {
  if [ -n "${CAVECMS_INTERNAL_URL:-}" ]; then
    printf '%s' "${CAVECMS_INTERNAL_URL%/}"
    return
  fi
  local base="${HEALTHZ_URL%/healthz}"
  base="${base%/}"
  if [ -n "$base" ]; then
    printf '%s' "$base"
  else
    printf '%s' "http://127.0.0.1:3040"
  fi
}

post_maintenance_toggle() {
  local enabled="$1"  # "true" or "false"
  if [ -z "${INTERNAL_REVALIDATE_SECRET:-}" ]; then
    echo "[cavecms-update] INTERNAL_REVALIDATE_SECRET unset — skipping maintenance toggle ($enabled)" >&2
    return 0
  fi
  local base
  base=$(internal_base_url)
  local url="${base}/api/internal/updates/maintenance"
  # Loopback Host header — the endpoint refuses non-127.0.0.1 hosts.
  local host="${base#http://}"
  host="${host#https://}"
  # `|| true` — best-effort. The flow continues even if the toggle
  # fails; the worst case is visitors see a connection-error instead
  # of the branded 503 for a few seconds during pm2 reload.
  curl -fsS --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}" \
    -H "Host: ${host}" \
    -H "Content-Type: application/json" \
    -d "{\"enabled\":${enabled}}" \
    "$url" >/dev/null 2>>"${LOG_DIR}/maintenance-toggle.log" || \
    echo "[cavecms-update] maintenance toggle ($enabled) failed (non-fatal)" >&2
}

# post_audit_terminal <action> [error]
#   action: completed | failed | rolled_back
#   error : optional error message (truncated to 500 chars by the API)
#
# Writes a terminal audit_log row so the Update History table on
# /admin/settings/updates can render the outcome alongside the
# apply row (written by the admin /apply route at kick-off).
post_audit_terminal() {
  local action="$1"
  local err="${2:-}"
  if [ -z "${INTERNAL_REVALIDATE_SECRET:-}" ]; then
    return 0
  fi
  local base
  base=$(internal_base_url)
  local url="${base}/api/internal/updates/audit-terminal"
  local host="${base#http://}"
  host="${host#https://}"
  local started_epoch
  if command -v python3 >/dev/null 2>&1; then
    started_epoch=$(python3 -c '
import os, sys
from datetime import datetime, timezone
try:
  print(int(datetime.fromisoformat(os.environ["STARTED_AT"].replace("Z","+00:00")).timestamp() * 1000))
except Exception:
  print(0)
' 2>/dev/null || echo 0)
  else
    started_epoch=0
  fi
  local now_epoch=0
  if command -v python3 >/dev/null 2>&1; then
    now_epoch=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0)
  fi
  local duration_ms=0
  if [ "$started_epoch" -gt 0 ] && [ "$now_epoch" -gt "$started_epoch" ]; then
    duration_ms=$((now_epoch - started_epoch))
  fi
  # JSON-escape the error string for embedding. Reuse jq if available;
  # else a minimal awk escape (same as write_status).
  local esc_err
  if command -v jq >/dev/null 2>&1; then
    esc_err=$(printf '%s' "$err" | jq -Rs . | awk '{print substr($0, 2, length($0)-2)}')
  else
    esc_err=$(printf '%s' "$err" | awk 'BEGIN{ORS=""} {gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\r/, ""); gsub(/\n/, "\\n"); gsub(/\t/, "\\t"); print}')
  fi
  local body
  if [ -n "$err" ]; then
    body=$(printf '{"action":"%s","fromSha":"%s","toSha":"%s","durationMs":%d,"error":"%s"}' \
      "$action" "$FROM_SHA" "$TARGET_SHA" "$duration_ms" "$esc_err")
  else
    body=$(printf '{"action":"%s","fromSha":"%s","toSha":"%s","durationMs":%d}' \
      "$action" "$FROM_SHA" "$TARGET_SHA" "$duration_ms")
  fi
  curl -fsS --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}" \
    -H "Host: ${host}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$url" >/dev/null 2>>"${LOG_DIR}/audit-terminal.log" || \
    echo "[cavecms-update] audit-terminal POST ($action) failed (non-fatal)" >&2
}

# ---------------------------------------------------------------------------
# Tarball-mode helpers — fetch + validate + extract a release tarball.
# Activated only when CAVECMS_UPDATE_TARBALL_URL is set; the default
# update path stays git-fetch-based.
# ---------------------------------------------------------------------------
#
# Validation runs BEFORE extraction so a hostile tarball can't escape
# its extraction dir via `../` paths or symlinks pointing outside the
# tree. Same defence pattern as ceymail-update.sh:475-605.
verify_tarball() {
  local tarball="$1"
  # Reject path traversal + absolute paths
  if tar -tzf "$tarball" 2>/dev/null | grep -qE '(^|/)\.\.(/|$)|^/' ; then
    return 1
  fi
  # Reject symlinks (`l`) and hardlinks (`h`) — a symlink pointing
  # outside the extraction dir would let the tarball write anywhere.
  if tar -tvzf "$tarball" 2>/dev/null | grep -qE '^[lh]' ; then
    return 2
  fi
  return 0
}

extract_tarball_atomic() {
  local tarball="$1"
  local dest="$2"   # REPO_DIR
  local extract_tmp
  extract_tmp=$(mktemp -d "${TMPDIR:-/tmp}/cavecms-extract-XXXXXX")
  if ! tar -xzf "$tarball" --no-same-permissions --no-same-owner -C "$extract_tmp" 2>>"${LOG_DIR}/tarball-extract.log" ; then
    rm -rf "$extract_tmp"
    return 1
  fi
  # Find the single top-level directory inside the tarball
  # (GitHub release tarballs ship with `cavecms-<sha>/` as the root).
  local release_dir
  release_dir=$(find "$extract_tmp" -mindepth 1 -maxdepth 1 -type d | head -1)
  if [ -z "$release_dir" ] || [ ! -f "$release_dir/package.json" ]; then
    rm -rf "$extract_tmp"
    return 2
  fi
  # Verify essential files exist in the extracted tree.
  if [ ! -f "$release_dir/package.json" ] || [ ! -f "$release_dir/pnpm-lock.yaml" ]; then
    rm -rf "$extract_tmp"
    return 3
  fi
  # Atomic swap: rename current REPO_DIR's tracked-content dirs aside
  # (so a step-3+ failure can restore them) then copy the new content
  # in. Keep `.git/` if it exists (operator may want it for diagnosis).
  local backup_suffix=".tarball-old.$$"
  for d in app components lib public scripts db tests middleware.ts next.config.ts package.json pnpm-lock.yaml tsconfig.json; do
    if [ -e "$dest/$d" ]; then
      mv "$dest/$d" "$dest/$d$backup_suffix" 2>/dev/null || true
    fi
  done
  # Copy from the extracted release root.
  if ! cp -a "$release_dir"/. "$dest"/ ; then
    # Best-effort restore on copy failure.
    for d in app components lib public scripts db tests middleware.ts next.config.ts package.json pnpm-lock.yaml tsconfig.json; do
      if [ -e "$dest/$d$backup_suffix" ] && [ ! -e "$dest/$d" ]; then
        mv "$dest/$d$backup_suffix" "$dest/$d" 2>/dev/null || true
      fi
    done
    rm -rf "$extract_tmp"
    return 4
  fi
  # Success — clean up the .tarball-old.$$ backups and the extract dir.
  for d in app components lib public scripts db tests middleware.ts next.config.ts package.json pnpm-lock.yaml tsconfig.json; do
    rm -rf "$dest/$d$backup_suffix" 2>/dev/null || true
  done
  rm -rf "$extract_tmp"
  return 0
}

# ---------------------------------------------------------------------------
# DRY RUN — used by Playwright + manual demos. Walks states on a timer.
# ---------------------------------------------------------------------------
if [ "${CAVECMS_UPDATE_DRY_RUN:-}" = "1" ]; then
  write_status "preflight" 1 "Getting ready" "" ""; sleep 1
  CURRENT_STEP=2; write_status "updating" 2 "Downloading the new version" "" ""; sleep 1
  CURRENT_STEP=3; write_status "updating" 3 "Preparing your data" "" ""; sleep 1
  CURRENT_STEP=4; write_status "updating" 4 "Building your site" "" ""; sleep 1
  # Dry-run also exercises the maintenance toggle so a Playwright walk
  # can assert the 503 page renders mid-update.
  post_maintenance_toggle true
  CURRENT_STEP=5; write_status "restarting" 5 "Restarting" "" ""; sleep 1
  CURRENT_STEP=6; write_status "completed" 6 "You're on the new version" "" ""
  post_maintenance_toggle false
  post_audit_terminal completed
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy-mode coexistence check
#
# scripts/deploy.sh uses an atomic-symlink layout at /opt/cavecms/current.
# cavecms-update.sh uses a single-tree git-pull layout. The two are
# mutually exclusive — running git-pull on a tarball-mode box would
# update the wrong tree and pm2 would keep serving the old build.
# Refuse loud with operator-friendly copy.
# ---------------------------------------------------------------------------
if [ -L /opt/cavecms/current ] && [ "${CAVECMS_FORCE_SINGLE_TREE:-0}" != "1" ]; then
  write_status "failed" 1 "This server uses the release-archive deploy path" "Your hosting setup uses the more advanced atomic-release deploy. In-app updates aren't supported here — your DevOps team needs to run the deploy script directly." ""
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1 — preflight
# ---------------------------------------------------------------------------
CURRENT_STEP=1
write_status "preflight" 1 "Getting ready" "" ""

# Disk: need >= 500 MB free on the partition holding the repo.
free_kb=$(df -k "$REPO_DIR" | awk 'NR==2 {print $4}')
if [ -z "${free_kb:-}" ] || [ "$free_kb" -lt 512000 ]; then
  write_status "failed" 1 "Not enough free disk space" "Your server needs at least 500 MB of free space to install an update." ""
  exit 1
fi

# Network: release server reachable.
RELEASE_PROBE_URL="${CAVECMS_RELEASE_PROBE_URL:-https://api.github.com/zen}"
if ! curl -fsS --max-time 10 -o /dev/null "$RELEASE_PROBE_URL"; then
  write_status "failed" 1 "Couldn't reach the CaveCMS release server" "Check that your server has internet access." ""
  exit 1
fi

# DB: healthz reports db_ping=ok before we touch anything.
healthz_args=()
if [ -n "$HEALTHZ_TOKEN" ]; then
  healthz_args=(-H "Authorization: Bearer $HEALTHZ_TOKEN")
fi
healthz_response=$(curl -fsS --max-time 10 ${healthz_args[@]+"${healthz_args[@]}"} "$HEALTHZ_URL" 2>/dev/null || echo "")
if [ -z "$healthz_response" ] || ! echo "$healthz_response" | grep -q '"status":"ok"'; then
  write_status "failed" 1 "Your site isn't responding properly" "We can't update right now — try again in a moment." ""
  exit 1
fi

# Git working-tree cleanliness: refuse to clobber operator-edited files.
cd "$REPO_DIR"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  write_status "failed" 1 "Your install directory isn't a git repository" "In-app updates need a git-cloned install. Contact support if you're not sure how your site was set up." ""
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  write_status "failed" 1 "Your server has unsaved changes" "Someone edited the site files directly on the server. Commit, stash, or discard those changes before updating." ""
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2 — fetch
#
# Two modes:
#   - Git-fetch (default): pull origin, verify target SHA exists,
#     reset --hard. Closes the TOCTOU where origin/main could advance
#     between the check and apply APIs.
#   - Tarball (when CAVECMS_UPDATE_TARBALL_URL is set): curl the tarball,
#     SHA256 verify, path-traversal + symlink check, atomic extract.
#     Requires a git repo as well (rollback uses `git reset --hard` on
#     the file modifications the tarball made; operators using tarball
#     without git need their own rollback mechanism — out of scope here).
# ---------------------------------------------------------------------------
CURRENT_STEP=2
write_status "updating" 2 "Downloading the new version" "" ""

# Save the previous version for rollback (works in both modes — the
# tarball overlay is tracked by git as file modifications).
PREVIOUS_SHA=$(git rev-parse HEAD)

if [ -n "${CAVECMS_UPDATE_TARBALL_URL:-}" ]; then
  # ──────── Tarball mode ────────
  TARBALL_TMP="${LOG_DIR}/release-${TARGET_SHA:0:12}.tar.gz.tmp.$(rand_suffix)"
  if ! curl -fsSL --max-time 300 -o "$TARBALL_TMP" "$CAVECMS_UPDATE_TARBALL_URL" 2>>"${LOG_DIR}/tarball-download.log"; then
    rm -f "$TARBALL_TMP"
    write_status "failed" 2 "Couldn't download the new version" "We tried to fetch the release archive but the download failed. Check your server's internet access." ""
    post_audit_terminal failed "tarball_download_failed"
    exit 1
  fi
  # Empty/zero-byte response — curl returns success but the tarball
  # is unusable. Refuse explicitly.
  if [ ! -s "$TARBALL_TMP" ]; then
    rm -f "$TARBALL_TMP"
    write_status "failed" 2 "The downloaded version is empty" "Something is wrong with the release server. Try again in a few minutes." ""
    post_audit_terminal failed "tarball_empty"
    exit 1
  fi
  # SHA256 verification (only when the operator provided an expected hash).
  if [ -n "${CAVECMS_UPDATE_TARBALL_SHA256:-}" ]; then
    expected_sha256=$(echo "$CAVECMS_UPDATE_TARBALL_SHA256" | tr 'A-F' 'a-f')
    if [[ ! "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]; then
      rm -f "$TARBALL_TMP"
      write_status "failed" 2 "Couldn't verify the new version's signature" "The release manifest is malformed. Contact support." ""
      post_audit_terminal failed "tarball_sha256_malformed"
      exit 1
    fi
    actual_sha256=""
    if command -v sha256sum >/dev/null 2>&1; then
      actual_sha256=$(sha256sum "$TARBALL_TMP" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual_sha256=$(shasum -a 256 "$TARBALL_TMP" | awk '{print $1}')
    fi
    if [ -z "$actual_sha256" ] || [ "$actual_sha256" != "$expected_sha256" ]; then
      rm -f "$TARBALL_TMP"
      write_status "failed" 2 "Couldn't verify the new version's signature" "The downloaded archive doesn't match the expected fingerprint. Contact support — this could indicate a tampered download." ""
      post_audit_terminal failed "tarball_sha256_mismatch"
      exit 1
    fi
  fi
  # Path-traversal + symlink/hardlink validation BEFORE extraction.
  if ! verify_tarball "$TARBALL_TMP"; then
    rc=$?
    rm -f "$TARBALL_TMP"
    case $rc in
      1) reason="contains path-traversal entries" ;;
      2) reason="contains symbolic or hard links" ;;
      *) reason="failed validation" ;;
    esac
    write_status "failed" 2 "The downloaded version isn't safe to install" "Archive $reason. Refusing to extract. Contact support." ""
    post_audit_terminal failed "tarball_validation_${rc}"
    exit 1
  fi
  if ! extract_tarball_atomic "$TARBALL_TMP" "$REPO_DIR"; then
    rc=$?
    rm -f "$TARBALL_TMP"
    case $rc in
      1) reason="extract failed" ;;
      2) reason="missing top-level directory" ;;
      3) reason="missing package.json or pnpm-lock.yaml" ;;
      4) reason="copy into install directory failed" ;;
      *) reason="unknown error" ;;
    esac
    write_status "failed" 2 "Couldn't install the new version" "We rolled back any partial changes. ($reason)" ""
    post_audit_terminal failed "tarball_extract_${rc}"
    exit 1
  fi
  rm -f "$TARBALL_TMP"
  # In tarball mode, TARGET_FULL is the operator-approved SHA. We
  # don't resolve it against git objects (the tarball provides the
  # tree directly).
  TARGET_FULL="$TARGET_SHA"
else
  # ──────── Git-fetch mode (default) ────────
  if ! git fetch origin --quiet; then
    write_status "failed" 2 "Couldn't download the new version" "Check that your server has internet access." ""
    post_audit_terminal failed "git_fetch_failed"
    exit 1
  fi

  # Verify the operator-approved TARGET_SHA exists in the freshly-fetched
  # objects. Resolve the TARGET_SHA directly (not origin/main) — this
  # closes the TOCTOU where origin/main could advance between the check
  # API and the apply API.
  if ! TARGET_FULL=$(git rev-parse "${TARGET_SHA}^{commit}" 2>/dev/null); then
    write_status "failed" 2 "The version you approved is no longer available" "Click 'Check for updates' again and retry." ""
    post_audit_terminal failed "git_target_not_found"
    exit 1
  fi

  # In force mode we may already be at TARGET_FULL — `git reset --hard`
  # is a no-op there, which is correct.
  if ! git reset --hard "$TARGET_FULL"; then
    write_status "failed" 2 "Couldn't switch to the new version" "Your site is unchanged. Try again or contact support." ""
    post_audit_terminal failed "git_reset_failed"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 3 — install + migrate (with pre-migration DB backup)
# ---------------------------------------------------------------------------
CURRENT_STEP=3
write_status "updating" 3 "Preparing your data" "" ""

if ! pnpm install --frozen-lockfile 2>&1 | tail -n 16 > "${LOG_DIR}/pnpm-install.log"; then
  write_status "failed" 3 "Couldn't prepare the new version" "Something went wrong while setting up. Your previous version is being restored." ""
  rollback_to_previous "$PREVIOUS_SHA" 0 ""
  post_audit_terminal rolled_back "pnpm_install_failed"
  exit 1
fi

# DB backup BEFORE migration so a forward-then-rollback flow can
# restore the previous schema cleanly. Three outcomes:
#   - "SKIPPED"  : mysqldump/python3/DATABASE_URL not available.
#                  Acceptable on dev — we proceed but mark the
#                  backup as unavailable.
#   - "<path>"   : backup written successfully.
#   - ""         : backup ATTEMPTED but failed. Refuse to continue
#                  (a post-step3 rollback would leave schema ahead
#                  of code without a way back).
BACKUP_DUMP=$(db_backup "${TARGET_FULL:0:12}") || BACKUP_DUMP=""
HAD_MIGRATION=0

if [ -z "$BACKUP_DUMP" ]; then
  write_status "failed" 3 "Couldn't take a safety backup of your data" "We tried to back up your data before updating but couldn't. Update halted — your site is unchanged. Contact support." ""
  post_audit_terminal failed "db_backup_failed"
  exit 1
fi

if ! pnpm db:migrate 2>&1 | tail -n 16 > "${LOG_DIR}/db-migrate.log"; then
  write_status "failed" 3 "Couldn't update your data" "Your previous version is being restored. No data was lost." ""
  rollback_to_previous "$PREVIOUS_SHA" 0 "$BACKUP_DUMP"
  post_audit_terminal rolled_back "db_migrate_failed"
  exit 1
fi
HAD_MIGRATION=1

# ---------------------------------------------------------------------------
# Step 4 — build
#
# Force mode: wipe .next/ before building. The "Re-run install" button
# in the admin UI exists precisely so an operator can recover from a
# corrupted build cache without bumping the version — without this
# rm -rf, the rebuild would reuse the corrupted cache and the install
# stays broken.
# ---------------------------------------------------------------------------
CURRENT_STEP=4
write_status "updating" 4 "Building your site" "" ""

if [ "$FORCE" = "1" ]; then
  rm -rf "$REPO_DIR/.next" 2>>"${LOG_DIR}/force-clean.log" || true
fi

if ! pnpm build 2>&1 | tail -n 16 > "${LOG_DIR}/build.log"; then
  write_status "failed" 4 "Couldn't build your site" "Your previous version is being restored." ""
  rollback_to_previous "$PREVIOUS_SHA" "$HAD_MIGRATION" "$BACKUP_DUMP"
  post_audit_terminal rolled_back "build_failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 5 — restart
# ---------------------------------------------------------------------------
CURRENT_STEP=5
write_status "restarting" 5 "Restarting" "" ""

# Flip security_maintenance.enabled=true BEFORE pm2 reload so visitors
# see the branded 503 page during the brief Next.js re-compile window
# (typically 30-90s on small instances). Best-effort — see the helper
# comments. If the toggle fails the update still proceeds; the worst
# case is visitors see a connection-error instead of the styled page.
post_maintenance_toggle true

# Write the new commit + ts to the env file so the new process picks
# them up. Atomic write via tmp + rename so a partial write can't
# leave the env file half-edited.
NEW_TS="$(now_iso)"
NEW_COMMIT="${TARGET_FULL:0:12}"
export CAVECMS_COMMIT="$NEW_COMMIT"
export CAVECMS_RELEASE_TS="$NEW_TS"

if [ -f "$ENV_FILE" ]; then
  ENV_TMP="${ENV_FILE}.tmp.$(rand_suffix)"
  awk -v c="$NEW_COMMIT" -v t="$NEW_TS" '
    /^CAVECMS_COMMIT=/ { print "CAVECMS_COMMIT=" c; seen_c=1; next }
    /^CAVECMS_RELEASE_TS=/ { print "CAVECMS_RELEASE_TS=" t; seen_t=1; next }
    { print }
    END {
      if (!seen_c) print "CAVECMS_COMMIT=" c
      if (!seen_t) print "CAVECMS_RELEASE_TS=" t
    }
  ' "$ENV_FILE" > "$ENV_TMP"
  chmod --reference="$ENV_FILE" "$ENV_TMP" 2>/dev/null || chmod 0640 "$ENV_TMP"
  mv -f "$ENV_TMP" "$ENV_FILE"
fi

if ! pm2 reload ecosystem.config.cjs --update-env 2>&1 | tail -n 16 > "${LOG_DIR}/pm2-reload.log"; then
  write_status "failed" 5 "Couldn't restart your site" "Your previous version is being restored." ""
  rollback_to_previous "$PREVIOUS_SHA" "$HAD_MIGRATION" "$BACKUP_DUMP"
  post_maintenance_toggle false
  post_audit_terminal rolled_back "pm2_reload_failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 6 — verify
#
# Budget: 60 retries × 2s = 120s. Production Next 15 standalone reloads
# on small instances can take 60-90s for the first /healthz to return
# 200 (Next route compilation + DB pool warm-up). 30 retries was too
# tight per ops review.
# ---------------------------------------------------------------------------
CURRENT_STEP=6
write_status "restarting" 6 "Making sure everything works" "" ""

success=0
for i in $(seq 1 60); do
  sleep 2
  if curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "$HEALTHZ_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    success=$((success + 1))
    if [ $success -ge 3 ]; then
      break
    fi
  else
    success=0
  fi
done

if [ $success -lt 3 ]; then
  write_status "rolled_back" 6 "We put your site back the way it was" "The new version didn't come up healthy, so we restored your previous version automatically." ""
  rollback_to_previous "$PREVIOUS_SHA" "$HAD_MIGRATION" "$BACKUP_DUMP"
  post_maintenance_toggle false
  post_audit_terminal rolled_back "healthz_unhealthy_after_reload"
  exit 1
fi

# Persist the new pm2 process list so `pm2 resurrect` on host reboot
# picks up the new CAVECMS_COMMIT/CAVECMS_RELEASE_TS instead of the previous
# snapshot. Without this, a reboot reverts the visible version (the
# code on disk is new, but /healthz reports the old commit).
pm2 save 2>&1 | tail -n 16 > "${LOG_DIR}/pm2-save.log" || true

# Flip maintenance OFF — visitors resume normal routing. Order
# matters: turn it off AFTER healthz confirms the new version is
# healthy, so we don't expose a half-loaded build.
post_maintenance_toggle false

write_status "completed" 6 "You're on the new version" "" ""
post_audit_terminal completed
exit 0
