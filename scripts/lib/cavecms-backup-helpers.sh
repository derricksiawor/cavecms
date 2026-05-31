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
# _backup_cred_file — write a mode-0600 mysql defaults-extra-file from
# DATABASE_URL. Echoes the path; caller rm's it. Password never hits argv.
# ---------------------------------------------------------------------------
_backup_cred_file() {
  local db_url="${DATABASE_URL:-}"
  [ -z "$db_url" ] && return 1
  command -v python3 >/dev/null 2>&1 || return 1
  local parsed
  parsed=$(_parse_database_url "$db_url") || return 1
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
# restore_database <in.sql.gz>   /   restore_database_age <in.sql.age> <id>
# gunzip|mysql (and age-decrypt|gunzip|mysql for cluster-format interop).
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

restore_database_age() {
  local enc="$1" identity="$2"
  [ -f "$enc" ] || return 1
  command -v age >/dev/null 2>&1 || return 1
  local cred_db cf db
  cred_db=$(_backup_cred_file) || return 1
  cf=$(echo "$cred_db" | awk 'NR==1'); db=$(echo "$cred_db" | awk 'NR==2')
  local rc=0
  age --decrypt -i "$identity" "$enc" | gunzip | mysql --defaults-extra-file="$cf" "$db" \
    2>>"${LOG_DIR:-/tmp}/restore-db.log" || rc=$?
  rm -f "$cf"
  return $rc
}

# ---------------------------------------------------------------------------
# Read-only DB probes used to build the manifest + post-load guards.
# ---------------------------------------------------------------------------
_mysql_scalar() {
  local query="$1"
  local cred_db cf db
  cred_db=$(_backup_cred_file) || return 1
  cf=$(echo "$cred_db" | awk 'NR==1'); db=$(echo "$cred_db" | awk 'NR==2')
  local val rc=0
  val=$(mysql --defaults-extra-file="$cf" --connect-timeout=10 -BNe "$query" "$db" 2>/dev/null) || rc=$?
  rm -f "$cf"
  [ $rc -eq 0 ] || return 1
  printf '%s' "$val"
}

db_server_version() { _mysql_scalar "SELECT VERSION();"; }
db_schema_fingerprint() { _mysql_scalar "SELECT fingerprint FROM schema_fingerprint WHERE id=1;"; }
db_migration_count() { _mysql_scalar "SELECT COUNT(*) FROM \`__drizzle_migrations\`;"; }

# detect_migrator_encoding — drizzle-hash (sha256 hex) vs filename (*.sql).
detect_migrator_encoding() {
  local sample
  sample=$(_mysql_scalar "SELECT hash FROM \`__drizzle_migrations\` ORDER BY id DESC LIMIT 1;") || { echo "unknown"; return 0; }
  if [ -z "$sample" ]; then echo "unknown"; return 0; fi
  if printf '%s' "$sample" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "drizzle-hash"
  elif printf '%s' "$sample" | grep -Eq '\.sql$'; then
    echo "filename"
  else
    echo "unknown"
  fi
}

# ---------------------------------------------------------------------------
# Disk space — portable (df -P works on both macOS/BSD and Linux).
# disk_free_pct echoes the USED percent (0-100). assert_disk_ok refuses if the
# target FS is at/over CAVECMS_DISK_HIGH_PCT (default 90).
# ---------------------------------------------------------------------------
disk_used_pct() {
  local path="$1"
  df -P "$path" 2>/dev/null | awk 'NR==2 { gsub(/%/,"",$5); print $5+0 }'
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
