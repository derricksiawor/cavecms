#!/usr/bin/env bash
# scripts/lib/cavecms-backup-helpers.sh — shared helpers for the operator-
# facing backup + restore engine.
#
# Sourced (NEVER executed) by:
#   - scripts/cavecms-backup.sh
#   - scripts/cavecms-restore.sh
#
# MUST be sourced AFTER scripts/lib/cavecms-update-helpers.sh — it reuses
# these functions from there:
#   now_iso, rand_suffix, json_escape, _parse_database_url,
#   internal_base_url, acquire_lock_or_defer, release_lock
# and these env contracts: DATABASE_URL, INTERNAL_REVALIDATE_SECRET, LOG_DIR.
#
# Everything here is generalized from the update engine's primitives:
#   - write_phase_status  ← generalizes write_status (parameterized totalSteps,
#                            no fromSha/toSha, optional archiveLabel)
#   - dump_database       ← generalizes db_backup (caller path + full flags)
#   - restore_database    ← generalizes restore_db_backup (caller path)
#   - post_backup_audit_terminal ← generalizes post_audit_terminal (backups URL)
#   - disk_free_pct       ← portable df-based variant of disk-check.sh df_pct

# ---------------------------------------------------------------------------
# write_phase_status <status_path> <total_steps> <state> <step> <label> \
#                    [error] [log] [archiveLabel]
# Atomic JSON write via tmp + rename(2). Mirrors write_status's atomicity but
# omits the SHA fields and parameterizes totalSteps for the backup/restore
# step models.
# ---------------------------------------------------------------------------
write_phase_status() {
  local status_path="$1"
  local total="$2"
  local state="$3"
  local step="$4"
  local label="$5"
  local err="${6:-}"
  local log="${7:-}"
  local archive_label="${8:-}"

  local started="${PHASE_STARTED_AT:-$(now_iso)}"
  local tmp="${status_path}.tmp.$(rand_suffix)"
  local esc_label esc_err esc_log esc_archive
  esc_label=$(json_escape "$label")
  esc_err=$(json_escape "$err")
  esc_log=$(json_escape "$log")

  local archive_field=""
  if [ -n "$archive_label" ]; then
    esc_archive=$(json_escape "$archive_label")
    archive_field=$(printf ',\n  "archiveLabel": "%s"' "$esc_archive")
  fi

  cat > "$tmp" << EOF
{
  "state": "$state",
  "step": $step,
  "totalSteps": $total,
  "startedAt": "${started}",
  "updatedAt": "$(now_iso)",
  "stepLabel": "$esc_label",
  "error": "$esc_err",
  "log": "$esc_log"$archive_field
}
EOF
  chmod 0600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$status_path"
}

# ---------------------------------------------------------------------------
# _parse_db_url_portable <url> — parse mysql://user:pass@host:port/db into 5
# lines (host, port, user, pass, db). Prefers python3 (handles %-encoding),
# falls back to an awk parser so backup/restore don't HARD-fail on a host
# without python3 (the awk path handles URL-safe creds, the common case).
# ---------------------------------------------------------------------------
_parse_db_url_portable() {
  local db_url="$1"
  if command -v python3 >/dev/null 2>&1; then
    DATABASE_URL="$db_url" python3 -c '
import os, sys
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["DATABASE_URL"])
print(u.hostname or "127.0.0.1")
print(u.port or 3306)
print(unquote(u.username or ""))
print(unquote(u.password or ""))
print((u.path or "/").lstrip("/").split("?")[0])
' 2>/dev/null && return 0
  fi
  # awk fallback — no %-decoding (URL-safe creds only).
  printf '%s' "$db_url" | awk '{
    u=$0; sub(/^[a-zA-Z]+:\/\//,"",u)
    creds=""; rest=u
    n=index(u,"@"); if(n>0){creds=substr(u,1,n-1); rest=substr(u,n+1)}
    cu=creds; cp=""
    c=index(creds,":"); if(c>0){cu=substr(creds,1,c-1); cp=substr(creds,c+1)}
    s=index(rest,"/"); hp=rest; db=""
    if(s>0){hp=substr(rest,1,s-1); db=substr(rest,s+1)}
    q=index(db,"?"); if(q>0){db=substr(db,1,q-1)}
    host=hp; port="3306"
    p=index(hp,":"); if(p>0){host=substr(hp,1,p-1); port=substr(hp,p+1)}
    if(host=="")host="127.0.0.1"
    print host; print port; print cu; print cp; print db
  }'
}

# ---------------------------------------------------------------------------
# _backup_cred_file — write a mode-0600 mysql defaults-extra-file from
# DATABASE_URL. Echoes the path; caller rm's it. Password never hits argv.
# ---------------------------------------------------------------------------
_backup_cred_file() {
  local db_url="${DATABASE_URL:-}"
  [ -z "$db_url" ] && return 1
  local parsed
  parsed=$(_parse_db_url_portable "$db_url") || return 1
  [ -z "$parsed" ] && return 1
  local h p u pw n
  h=$(echo "$parsed" | awk 'NR==1'); p=$(echo "$parsed" | awk 'NR==2')
  u=$(echo "$parsed" | awk 'NR==3'); pw=$(echo "$parsed" | awk 'NR==4')
  n=$(echo "$parsed" | awk 'NR==5')
  [ -z "$n" ] && return 1
  local cf
  cf=$(mktemp "${TMPDIR:-/tmp}/cavecms-bkp-cred.XXXXXX") || return 1
  chmod 0600 "$cf"
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' "$h" "$p" "$u" "$pw" > "$cf"
  [ -s "$cf" ] || { rm -f "$cf"; return 1; }
  # Echo cred-file path and db name on two lines.
  printf '%s\n%s\n' "$cf" "$n"
}

# ---------------------------------------------------------------------------
# invalidate_all_sessions — bump tokens_valid_after = NOW for every user so
# every JWT session minted before this instant is rejected on the next request.
# Called after a RESTORE so the operator (and everyone) must re-authenticate
# against the RESTORED users table, instead of riding a pre-restore session
# that now points at a DIFFERENT account at the same user id (the "stuck in the
# old account" confusion). Best-effort: the data is already committed by the
# time we run, so a failure here must NOT fail the restore — it only means
# sessions aren't force-expired. Always returns 0; logs on failure.
# ---------------------------------------------------------------------------
invalidate_all_sessions() {
  command -v mysql >/dev/null 2>&1 || return 0
  local cred_db cf db
  cred_db=$(_backup_cred_file) || { echo "[cavecms-restore] invalidate_all_sessions: no DB creds" >&2; return 0; }
  cf=$(echo "$cred_db" | awk 'NR==1'); db=$(echo "$cred_db" | awk 'NR==2')
  mysql --defaults-extra-file="$cf" --connect-timeout=10 "$db" \
    -e "UPDATE users SET tokens_valid_after = NOW(3)" \
    >>"${LOG_DIR:-/tmp}/restore-db.log" 2>&1 \
    || echo "[cavecms-restore] invalidate_all_sessions: UPDATE failed (non-fatal)" >&2
  rm -f "$cf" 2>/dev/null || true
  return 0
}

# ---------------------------------------------------------------------------
# dump_database <out.sql.gz>
# Generalized db_backup: full mysqldump (schema + data + routines/triggers/
# events), single-transaction, gzip to the caller-supplied path. Echoes the
# path on success; empty + rc1 on failure.
# ---------------------------------------------------------------------------
dump_database() {
  local out="$1"
  command -v mysqldump >/dev/null 2>&1 || { echo ""; return 1; }
  local cred_db cf db
  cred_db=$(_backup_cred_file) || { echo ""; return 1; }
  cf=$(echo "$cred_db" | awk 'NR==1'); db=$(echo "$cred_db" | awk 'NR==2')

  local rc=0
  mysqldump --defaults-extra-file="$cf" \
    --single-transaction --quick --skip-lock-tables \
    --routines --triggers --events \
    "$db" 2>"${LOG_DIR:-/tmp}/backup-dump.log" | gzip > "$out" || rc=$?
  rm -f "$cf"
  if [ $rc -eq 0 ] && [ -s "$out" ]; then
    echo "$out"
  else
    rm -f "$out"; echo ""; return 1
  fi
}

# ---------------------------------------------------------------------------
# restore_database <in.sql.gz> — gunzip|mysql. (Cluster .age archives are
# decrypted to a plaintext working copy by the restore orchestrator BEFORE
# this is called, so there is no separate age-streaming path here.)
# ---------------------------------------------------------------------------
restore_database() {
  local dump="$1"
  [ -f "$dump" ] || return 1
  local cred_db cf db
  cred_db=$(_backup_cred_file) || return 1
  cf=$(echo "$cred_db" | awk 'NR==1'); db=$(echo "$cred_db" | awk 'NR==2')
  local rc=0
  gunzip -c "$dump" | mysql --defaults-extra-file="$cf" "$db" \
    2>>"${LOG_DIR:-/tmp}/restore-db.log" || rc=$?
  rm -f "$cf"
  return $rc
}

# drop_all_tables — DROP every table + view in the configured DB so a restore is
# a TRUE replacement, not additive. Without this, restoring an OLDER dump (which
# only DROP+CREATEs the tables it knows about) leaves the install's NEWER tables
# in place; the subsequent forward-migrate then re-runs their CREATE and fails.
# Runs AFTER the pre-restore safety snapshot + maintenance-on. NEVER drops the
# database itself (project rule) — only its tables, exactly as the dump's own
# `--add-drop-table` does, just comprehensively.
drop_all_tables() {
  local cred_db cf db
  cred_db=$(_backup_cred_file) || return 1
  cf=$(echo "$cred_db" | awk 'NR==1'); db=$(echo "$cred_db" | awk 'NR==2')
  local stmts rc=0
  stmts=$(mysql --defaults-extra-file="$cf" --connect-timeout=10 -BNe \
    "SELECT CONCAT('DROP ', IF(table_type='VIEW','VIEW','TABLE'), ' IF EXISTS \`', table_name, '\`;') \
     FROM information_schema.tables WHERE table_schema = DATABASE();" "$db" \
    2>>"${LOG_DIR:-/tmp}/restore-db.log") || rc=$?
  if [ $rc -eq 0 ] && [ -n "$stmts" ]; then
    { printf 'SET FOREIGN_KEY_CHECKS=0;\n%s\nSET FOREIGN_KEY_CHECKS=1;\n' "$stmts"; } \
      | mysql --defaults-extra-file="$cf" "$db" 2>>"${LOG_DIR:-/tmp}/restore-db.log" || rc=$?
  fi
  rm -f "$cf"
  return $rc
}

# ---------------------------------------------------------------------------
# Read-only DB probes used to build the manifest + post-load guards.
# _mysql_query runs an arbitrary read query reusing ONE cred-file.
# ---------------------------------------------------------------------------
_mysql_query() {
  local query="$1"
  local cred_db cf db
  cred_db=$(_backup_cred_file) || return 1
  cf=$(echo "$cred_db" | awk 'NR==1'); db=$(echo "$cred_db" | awk 'NR==2')
  local out rc=0
  out=$(mysql --defaults-extra-file="$cf" --connect-timeout=10 -BNe "$query" "$db" 2>/dev/null) || rc=$?
  rm -f "$cf"
  [ $rc -eq 0 ] || return 1
  printf '%s' "$out"
}

db_server_version() { _mysql_query "SELECT VERSION();"; }
db_schema_fingerprint() { _mysql_query "SELECT fingerprint FROM schema_fingerprint WHERE id=1;"; }
db_migration_count() { _mysql_query "SELECT COUNT(*) FROM \`__drizzle_migrations\`;"; }

# db_manifest_probe — fetch serverVersion, fingerprint, migrationCount, and the
# latest migration hash in ONE mysql round-trip (4 tab-separated columns on one
# row). Saves 3 extra connect+cred-file cycles per backup. Echoes:
#   <serverVersion>\t<fingerprint>\t<migrationCount>\t<latestHash>
db_manifest_probe() {
  _mysql_query "SELECT VERSION(), \
    COALESCE((SELECT fingerprint FROM schema_fingerprint WHERE id=1), ''), \
    (SELECT COUNT(*) FROM \`__drizzle_migrations\`), \
    COALESCE((SELECT hash FROM \`__drizzle_migrations\` ORDER BY id DESC LIMIT 1), '');"
}

# encoding_of_hash <hash> — classify a __drizzle_migrations.hash sample.
encoding_of_hash() {
  local sample="$1"
  if [ -z "$sample" ]; then echo "unknown"; return 0; fi
  if printf '%s' "$sample" | grep -Eq '^[0-9a-f]{64}$'; then echo "drizzle-hash"
  elif printf '%s' "$sample" | grep -Eq '\.sql$'; then echo "filename"
  else echo "unknown"; fi
}

# detect_migrator_encoding — drizzle-hash (sha256 hex) vs filename (*.sql).
detect_migrator_encoding() {
  local sample
  sample=$(_mysql_query "SELECT hash FROM \`__drizzle_migrations\` ORDER BY id DESC LIMIT 1;") || { echo "unknown"; return 0; }
  encoding_of_hash "$sample"
}

# ---------------------------------------------------------------------------
# Disk space — portable (df -P works on both macOS/BSD and Linux).
# disk_used_pct echoes the USED percent (0-100); df_avail_kb echoes available
# 1K-blocks. assert_disk_ok refuses at/over CAVECMS_DISK_HIGH_PCT (default 90);
# assert_disk_for refuses when free bytes < estimated need (the real guard).
# ---------------------------------------------------------------------------
disk_used_pct() {
  local path="$1"
  df -P "$path" 2>/dev/null | awk 'NR==2 { gsub(/%/,"",$5); print $5+0 }'
}

df_avail_kb() {
  # POSIX `df -Pk` → column 4 is available 1K-blocks on both BSD and GNU.
  df -Pk "$1" 2>/dev/null | awk 'NR==2 { print $4+0 }'
}

# du_kb <path...> — total apparent size in 1K-blocks (best-effort; 0 if du fails
# or the path is absent). Used to estimate how much a backup of UPLOADS will need.
du_kb() {
  local total=0 d sz
  for d in "$@"; do
    [ -d "$d" ] || continue
    sz=$(du -sk "$d" 2>/dev/null | awk 'NR==1{print $1+0}')
    [ -n "$sz" ] && total=$((total + sz))
  done
  printf '%s' "$total"
}

assert_disk_ok() {
  local path="$1"
  local high="${CAVECMS_DISK_HIGH_PCT:-90}"
  local used
  used=$(disk_used_pct "$path")
  if [ -z "$used" ]; then
    echo "[backup] WARN: could not read disk usage for ${path}; proceeding" >&2
    return 0
  fi
  if [ "$used" -ge "$high" ]; then
    echo "[backup] disk for ${path} is ${used}% full (>= ${high}%) — refusing to proceed" >&2
    return 1
  fi
  return 0
}

# assert_disk_for <path> <needed_kb> — refuse if available space on <path>'s FS
# is below <needed_kb> (already including any margin the caller wants). Falls
# back to assert_disk_ok's %-gate when df can't report available bytes.
assert_disk_for() {
  local path="$1" need_kb="$2"
  local avail
  avail=$(df_avail_kb "$path")
  if [ -z "$avail" ] || [ "$avail" -le 0 ]; then
    assert_disk_ok "$path"; return $?
  fi
  if [ "$avail" -lt "$need_kb" ]; then
    echo "[backup] not enough free space on ${path}'s filesystem: ${avail}K free, ~${need_kb}K needed — refusing" >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# post_backup_audit_terminal <action> <resourceId> [error]
# action: backup | backup_completed | backup_failed | restore |
#         restore_completed | restore_failed | restore_rolled_back
# Generalizes post_audit_terminal: posts to /api/internal/backups/audit-terminal
# with a backup-shaped body (no SHAs).
# ---------------------------------------------------------------------------
post_backup_audit_terminal() {
  local action="$1"
  local resource_id="$2"
  local err="${3:-}"
  [ -z "${INTERNAL_REVALIDATE_SECRET:-}" ] && return 0
  local base host url
  base=$(internal_base_url)
  url="${base}/api/internal/backups/audit-terminal"
  host="${base#http://}"; host="${host#https://}"

  local started_ms=0 now_ms=0 duration_ms=0
  if command -v python3 >/dev/null 2>&1; then
    if [ -n "${PHASE_STARTED_AT:-}" ]; then
      started_ms=$(PHASE_STARTED_AT="$PHASE_STARTED_AT" python3 -c '
import os
from datetime import datetime, timezone
try:
  dt = datetime.strptime(os.environ["PHASE_STARTED_AT"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
  print(int(dt.timestamp()*1000))
except Exception:
  print(0)' 2>/dev/null || echo 0)
    fi
    now_ms=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0)
  fi
  if [ "$started_ms" -gt 0 ] && [ "$now_ms" -gt "$started_ms" ]; then
    duration_ms=$((now_ms - started_ms))
  fi

  local esc_id esc_err
  esc_id=$(json_escape "$resource_id")
  esc_err=$(json_escape "$err")
  local body="{\"action\":\"${action}\",\"resourceId\":\"${esc_id}\",\"durationMs\":${duration_ms}"
  [ -n "$err" ] && body="${body},\"error\":\"${esc_err}\""
  body="${body}}"

  curl -fsS --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}" \
    -H "Host: ${host}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$url" >/dev/null 2>>"${LOG_DIR:-/tmp}/backups-audit.log" || \
    echo "[backup] audit-terminal POST ($action) failed (non-fatal)" >&2
}

# ---------------------------------------------------------------------------
# restart_app — surface-aware app restart, used by the RESTORE engine after
# data is restored. Self-contained copy of cavecms-update.sh's restart_app so
# the restore orchestrator doesn't depend on the updater's internals. Reads
# CAVECMS_RESTART_MODE (systemd|cpanel|pm2|laptop; default pm2), REPO_DIR,
# LOG_DIR, CAVECMS_SYSTEMD_UNIT, CAVECMS_PM2_APP_NAME, PM2_HOME.
# ---------------------------------------------------------------------------
restart_app() {
  mkdir -p "${LOG_DIR:-/tmp}" 2>/dev/null || true
  local mode="${CAVECMS_RESTART_MODE:-pm2}"
  _restart_log() { cat >> "${LOG_DIR:-/tmp}/restore-restart.log" 2>/dev/null || cat >/dev/null; }
  case "$mode" in
    systemd)
      local unit="${CAVECMS_SYSTEMD_UNIT:-cavecms.service}"
      if [ "$(id -u)" = "0" ]; then
        { echo "[cavecms-restore] restarting via systemd unit ${unit}"; systemctl restart "$unit" 2>&1 || echo "[cavecms-restore] systemctl restart exit non-zero — verifying via healthz"; } | _restart_log || true
      else
        { echo "[cavecms-restore] restarting via systemd unit ${unit} (sudo)"; sudo -n systemctl restart "$unit" 2>&1 || echo "[cavecms-restore] sudo systemctl restart failed — verifying via healthz"; } | _restart_log || true
      fi
      ;;
    cpanel)
      mkdir -p "${REPO_DIR}/tmp" 2>/dev/null || true
      touch "${REPO_DIR}/tmp/restart.txt" 2>/dev/null \
        && echo "[cavecms-restore] restarted via Passenger (tmp/restart.txt)" | _restart_log || true
      ;;
    laptop)
      echo "[cavecms-restore] laptop/dev surface — manual restart required." | _restart_log || true
      ;;
    pm2|*)
      local target="${CAVECMS_PM2_APP_NAME:-ecosystem.config.cjs}"
      { (cd "${REPO_DIR}" && pm2 reload "$target" --update-env 2>&1) || echo "[cavecms-restore] pm2 reload exit non-zero — verifying via healthz"; } | _restart_log || true
      ;;
  esac
}

# ---------------------------------------------------------------------------
# verify_healthz <consecutive> <deadline_secs>
# Poll HEALTHZ_URL until <consecutive> back-to-back "status":"ok" responses,
# or the deadline elapses. Restore does NOT change code, so there is no
# commit to match — a status:ok streak is the "app came back up" signal.
# Returns 0 on success, 1 on timeout.
# ---------------------------------------------------------------------------
verify_healthz() {
  local need="${1:-2}"
  local deadline_secs="${2:-90}"
  local url="${HEALTHZ_URL:-${CAVECMS_HEALTHZ_URL:-http://127.0.0.1:3040/healthz}}"
  # Seed with the cPanel public-healthz --resolve pin (empty on other
  # surfaces) so the restore's verify can reach a Passenger app on its own
  # public host instead of the dead 127.0.0.1 loopback — the fix for the
  # "good restore rolled back at Verifying" bug. The caller runs
  # compute_healthz_resolve (cavecms-update-helpers.sh) before us.
  local args=(${HEALTHZ_RESOLVE_ARGS[@]+"${HEALTHZ_RESOLVE_ARGS[@]}"})
  [ -n "${HEALTHZ_TOKEN:-}" ] && args+=(-H "Authorization: Bearer ${HEALTHZ_TOKEN}")
  local ok=0 start now
  start=$(date +%s)
  while :; do
    if curl -fsS --max-time 5 ${args[@]+"${args[@]}"} "$url" 2>/dev/null | grep -q '"status":"ok"'; then
      ok=$((ok + 1))
    else
      ok=0
    fi
    [ "$ok" -ge "$need" ] && return 0
    now=$(date +%s)
    [ $((now - start)) -ge "$deadline_secs" ] && return 1
    sleep 2
  done
}

# ---------------------------------------------------------------------------
# assert_allowed_status_path <path> — shared status-path allowlist (parity with
# lib/backups/statusPath.ts ensureAllowedStatusPath). /tmp + /var/folders are
# allowed ONLY when NODE_ENV != production (matching the TS gate); /var/lib/
# cavecms, $CAVECMS_STATE_DIR, and any */.cavecms-state/* path are always
# allowed. Returns 0 if allowed, 1 otherwise. Replaces the per-script
# duplicated case-statements (which previously allowed /tmp unconditionally).
# ---------------------------------------------------------------------------
assert_allowed_status_path() {
  local p="$1"
  case "$p" in
    /var/lib/cavecms/*) return 0 ;;
  esac
  if [ -n "${CAVECMS_STATE_DIR:-}" ]; then
    case "$p" in "$CAVECMS_STATE_DIR"/*) return 0 ;; esac
  fi
  case "$p" in */.cavecms-state/*) return 0 ;; esac
  if [ "${NODE_ENV:-}" != "production" ]; then
    case "$p" in /tmp/*|/var/folders/*) return 0 ;; esac
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Shared operation lock — EXISTENCE-based (O_EXCL create), matching the
# updater's lib/updates/statusFile.ts acquireUpdateLock / the apply route +
# CLI acquireCliLock. NOT flock: the updater holds NO flock, so a flock-based
# acquire would NOT exclude an in-flight update. The lock file is the same
# <update-status>.lock the updater uses, so backup / update / restore are
# mutually exclusive on one install.
#
# acquire_op_lock <lock_path>  → 0 on acquire (file created O_EXCL, PID
#   stamped), 1 if held by a LIVE holder. Reclaims a stale lock (holder PID
#   dead, or — on Linux — a recycled/foreign PID, or an unstamped lock older
#   than 15 min).
# ---------------------------------------------------------------------------
op_lock_is_stale() {
  local lock_path="$1"
  local pid
  pid=$(head -n1 "$lock_path" 2>/dev/null | tr -dc '0-9')
  if [ -n "$pid" ]; then
    if kill -0 "$pid" 2>/dev/null; then
      # Alive. On Linux, confirm it's one of OUR scripts (recycled-PID guard).
      if [ -r "/proc/$pid/cmdline" ]; then
        # The content-sync cutover holds this lock IN-PROCESS via the CaveCMS
        # standalone server (start-standalone.mjs) — recognise it so a live
        # cutover holder reads as held, not a recycled-PID stale lock.
        if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Eq 'cavecms-(update|backup|restore|watchdog)|start-standalone\.mjs'; then
          return 1   # ours + alive → genuinely held
        fi
        return 0     # alive but not ours → recycled PID → stale
      fi
      return 1       # no /proc (macOS) → conservatively treat as held
    fi
    return 0         # PID dead → stale
  fi
  # No PID stamped (malformed/older writer) → lock-file mtime backstop.
  local now mtime
  now=$(date +%s)
  mtime=$(stat -f %m "$lock_path" 2>/dev/null || stat -c %Y "$lock_path" 2>/dev/null || echo "$now")
  [ $((now - mtime)) -gt 900 ] && return 0
  return 1
}

acquire_op_lock() {
  local lock_path="$1"
  local attempt
  for attempt in 1 2; do
    # O_EXCL create via noclobber — atomic create-or-fail on bash (incl. 3.2).
    if ( set -o noclobber; printf '%s\n' "$$" > "$lock_path" ) 2>/dev/null; then
      return 0
    fi
    if [ "$attempt" = "1" ] && op_lock_is_stale "$lock_path"; then
      rm -f "$lock_path" 2>/dev/null || true
      continue
    fi
    return 1
  done
  return 1
}

release_op_lock() {
  rm -f "$1" 2>/dev/null || true
}
