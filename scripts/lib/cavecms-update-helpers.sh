#!/usr/bin/env bash
# scripts/lib/cavecms-update-helpers.sh — shared helpers for the
# in-app update orchestrator + post-completion watchdog.
#
# Sourced by:
#   - scripts/cavecms-update.sh (orchestrator)
#   - scripts/cavecms-watchdog.sh (post-completion guard)
#
# Contains anything BOTH need to do identically:
#   - Atomic JSON status writes (write_status / read_status_state)
#   - Tree snapshots (snapshot_current_tree / restore_from_snapshot /
#     prune_old_snapshots) — the closes-gap-C primitive
#   - Internal endpoint POSTs (post_maintenance_toggle /
#     post_audit_terminal)
#   - Detach-mechanism dispatch (spawn_detached)
#   - DB backup + restore (db_backup / restore_db_backup)
#   - Portable timestamp + random suffix
#
# This file is sourced, NEVER executed. Every helper assumes the caller
# has already set STATUS_PATH, LOG_DIR, REPO_DIR, HEALTHZ_URL,
# FROM_SHA, TARGET_SHA, STARTED_AT (for the audit duration calc).
# Variables that are caller-specific (CURRENT_STEP, PREVIOUS_SHA,
# BACKUP_DUMP, HAD_MIGRATION) live in the caller.

# ---------------------------------------------------------------------------
# Time + random helpers — portable across BSD/macOS (no %N) and GNU.
# ---------------------------------------------------------------------------
now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
rand_suffix() { echo "$$.$RANDOM.$RANDOM"; }

# ---------------------------------------------------------------------------
# JSON-escape a single value for embedding inside `"..."` JSON strings.
# Prefers jq when available, falls back to awk for the common subset.
# ---------------------------------------------------------------------------
json_escape() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs . | awk '{print substr($0, 2, length($0)-2)}'
  else
    # awk fallback. Strips raw control bytes < 0x20 except CR/LF/TAB
    # (which are escaped to \\r, \\n, \\t). NUL is explicitly removed
    # so it can't terminate the embedded JSON value early on the
    # receiving end's parser (NUL is valid JSON-string content but
    # several parsers refuse it).
    printf '%s' "$1" | awk 'BEGIN{ORS=""} {
      gsub(/\\/, "\\\\");
      gsub(/"/, "\\\"");
      gsub(/\r/, "");
      gsub(/\n/, "\\n");
      gsub(/\t/, "\\t");
      gsub(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/, "");
      print
    }'
  fi
}

# ---------------------------------------------------------------------------
# Snapshot-SHA shape gate. PREVIOUS_SHA flows into a directory name
# (`${SNAPSHOT_ROOT}/${sha}`) used by `rm -rf` (overwrite-existing
# branch) and `rsync ... --delete` (restore branch). A non-hex value
# like `../../etc` would let the rm/rsync escape SNAPSHOT_ROOT.
#
# Accept: 7-64 hex chars (git SHAs) OR `from-<digits>` (the first-
# install fallback handle the orchestrator generates when neither
# git history nor a meaningful CAVECMS_COMMIT exists yet).
# ---------------------------------------------------------------------------
is_safe_snapshot_sha() {
  case "$1" in
    "")
      return 1 ;;
    from-*[!0-9]*)
      # Reject "from-" prefix with anything but digits after it.
      return 1 ;;
    from-*)
      return 0 ;;
    *)
      # 7-64 hex only.
      [[ "$1" =~ ^[0-9a-fA-F]{7,64}$ ]] && return 0
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# write_status <state> <step> <stepLabel> [error] [log]
# Atomic JSON write via tmp + rename(2). Honours optional
# CAVECMS_STATUS_WATCHDOG_UNTIL — when set, the field is appended so the
# modal can render "we'll keep an eye on your site for the next hour"
# copy alongside a completed update.
# ---------------------------------------------------------------------------
write_status() {
  local state="$1"
  local step="$2"
  local label="$3"
  local err="${4:-}"
  local log="${5:-}"

  local tmp="${STATUS_PATH}.tmp.$(rand_suffix)"
  local esc_label esc_err esc_log
  esc_label=$(json_escape "$label")
  esc_err=$(json_escape "$err")
  esc_log=$(json_escape "$log")

  # Optional watchdogUntil field. Caller sets this when finishing a
  # successful update (orchestrator) and unsets it when the watchdog
  # period elapses or the watchdog detects a rollback condition.
  local watchdog_field=""
  if [ -n "${CAVECMS_STATUS_WATCHDOG_UNTIL:-}" ]; then
    watchdog_field=$(printf ',\n  "watchdogUntil": "%s"' "${CAVECMS_STATUS_WATCHDOG_UNTIL}")
  fi

  cat > "$tmp" << EOF
{
  "state": "$state",
  "step": $step,
  "totalSteps": 6,
  "startedAt": "${STARTED_AT}",
  "updatedAt": "$(now_iso)",
  "fromSha": "${FROM_SHA}",
  "toSha": "${TARGET_SHA}",
  "stepLabel": "$esc_label",
  "error": "$esc_err",
  "log": "$esc_log"$watchdog_field
}
EOF
  chmod 0600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$STATUS_PATH"
}

# Read the current "state" field from the status file. Best-effort.
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

# ---------------------------------------------------------------------------
# Tree snapshots — the primitive that makes rollback work uniformly in
# git AND tarball mode. Snapshot the current payload to
# /var/lib/cavecms/snapshots/<sha>/ BEFORE any destructive operation.
# Excludes: node_modules (rebuilt by pnpm install on restore), .git
# (kept in place by the destructive ops), .next/cache (rebuilt by
# next), snapshots/ itself (would recurse infinitely), in-flight tmp
# directories.
# ---------------------------------------------------------------------------
SNAPSHOT_ROOT="${CAVECMS_SNAPSHOT_ROOT:-/var/lib/cavecms/snapshots}"

snapshot_current_tree() {
  local sha="$1"
  if ! is_safe_snapshot_sha "$sha"; then
    echo "[snapshot] refusing — sha '${sha}' is not a safe hex/from-N value" >&2
    return 1
  fi
  # Refuse if rsync is missing — the tar fallback was removed because
  # it didn't support `--delete` semantics on restore (a partial new
  # version would leave files behind on rollback). Refusing here is
  # safer than degrading; install rsync is a one-liner on every
  # supported host (`apt install rsync` / `dnf install rsync` / etc).
  if ! command -v rsync >/dev/null 2>&1; then
    echo "[snapshot] rsync required but not installed" >&2
    return 1
  fi
  local snap_dir="${SNAPSHOT_ROOT}/${sha}"
  # Predictable mode for SNAPSHOT_ROOT (umask-independent) so a
  # restrictive operator umask doesn't leave the dir 0700 and break
  # cross-user reads at restore time.
  local prev_umask
  prev_umask=$(umask)
  umask 0027
  mkdir -p "$SNAPSHOT_ROOT"
  # If an older snapshot for this same SHA exists (re-run install
  # against the same version), drop it. Otherwise rsync would merge
  # the old contents with the new ones and obscure what was actually
  # live at this moment.
  if [ -e "$snap_dir" ]; then
    rm -rf "$snap_dir"
    if [ -e "$snap_dir" ]; then
      umask "$prev_umask"
      echo "[snapshot] failed to clear pre-existing dir '${snap_dir}'" >&2
      return 1
    fi
  fi
  mkdir -p "$snap_dir"

  local snap_log="${LOG_DIR}/snapshot.log"
  echo "[snapshot] $(now_iso) creating ${snap_dir}" > "$snap_log"

  # rsync `--delete` over destination, exclude:
  #   - node_modules / .git / .next/cache : excluded by design (large,
  #     reconstructable, OR managed separately)
  #   - snapshots : would recurse infinitely (we're snapshotting INTO
  #     a child of REPO_DIR if SNAPSHOT_ROOT is under REPO_DIR — it
  #     isn't by default but operators can override)
  #   - .tarball-old.* / *.tmp.* : in-flight backup files from a
  #     previous orchestrator's tarball-mode swap
  #   - public/uploads : OPERATOR CONTENT. Files uploaded between the
  #     snapshot and a rollback (potentially 1+ hour later via the
  #     watchdog) MUST survive — otherwise we'd silently delete
  #     legitimate user uploads on rollback. Same rule for any other
  #     persistent user-content dir; add new excludes when adding new
  #     content surfaces.
  if ! rsync -a --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.next/cache' \
    --exclude='snapshots' \
    --exclude='.tarball-old.*' \
    --exclude='*.tmp.*' \
    --exclude='public/uploads' \
    --exclude='public/media' \
    "$REPO_DIR/" "$snap_dir/" 2>>"$snap_log"; then
    echo "[snapshot] rsync failed" >> "$snap_log"
    rm -rf "$snap_dir"
    umask "$prev_umask"
    return 1
  fi

  umask "$prev_umask"
  echo "[snapshot] complete at $(now_iso)" >> "$snap_log"
  printf '%s' "$snap_dir"
  return 0
}

# Restore the current tree from a snapshot. Used by both the
# orchestrator's rollback path AND the watchdog's post-completion
# rollback path. Caller must have already toggled maintenance ON.
#
# Strategy: rsync from snapshot back over REPO_DIR with --delete so any
# files added by the failed update get removed (snapshot is the source
# of truth for what should exist). Excludes the same paths as snapshot
# creation (don't trample node_modules or .git).
restore_from_snapshot() {
  local sha="$1"
  if ! is_safe_snapshot_sha "$sha"; then
    echo "[restore] refusing — sha '${sha}' is not a safe hex/from-N value" >&2
    return 1
  fi
  local snap_dir="${SNAPSHOT_ROOT}/${sha}"
  if [ ! -d "$snap_dir" ]; then
    echo "[restore] snapshot not found at ${snap_dir}" >&2
    return 2
  fi
  if ! command -v rsync >/dev/null 2>&1; then
    # Tar fallback was removed: it can't replicate rsync's `--delete`
    # semantics, which would let new-version files (added admin
    # routes, new migration files, etc.) survive a "restore" and
    # leave the operator on a half-rolled-back tree silently.
    echo "[restore] rsync required but not installed — refusing rollback" >&2
    return 4
  fi

  local restore_log="${LOG_DIR}/restore.log"
  echo "[restore] $(now_iso) restoring from ${snap_dir}" > "$restore_log"

  # Same exclude set as snapshot_current_tree — must match exactly so
  # the rsync source's exclusion of `public/uploads` (snapshot didn't
  # contain it) plus the rsync destination's exclusion of
  # `public/uploads` (--delete doesn't touch it) leave operator
  # uploads intact across the restore. Likewise public/media.
  if ! rsync -a --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.next/cache' \
    --exclude='snapshots' \
    --exclude='public/uploads' \
    --exclude='public/media' \
    "$snap_dir/" "$REPO_DIR/" 2>>"$restore_log"; then
    echo "[restore] rsync failed" >> "$restore_log"
    return 3
  fi

  echo "[restore] complete at $(now_iso)" >> "$restore_log"
  return 0
}

# Keep the most recent N snapshots (default 3), drop the rest.
# Called at the end of a successful update so we don't accumulate
# snapshots forever on long-lived installs.
prune_old_snapshots() {
  local keep="${CAVECMS_SNAPSHOT_KEEP:-3}"
  if [ ! -d "$SNAPSHOT_ROOT" ]; then return 0; fi
  # Portable enumeration by mtime, descending. Python3 (already a
  # hard dep) handles BSD + GNU + busybox identically. The `ls -1td
  # <glob>/` form used previously breaks on busybox ls and on multi-
  # line-wrap-on-long-name edge cases.
  local to_delete
  if command -v python3 >/dev/null 2>&1; then
    to_delete=$(SNAPSHOT_ROOT_ARG="$SNAPSHOT_ROOT" SNAPSHOT_KEEP_ARG="$keep" python3 -c '
import os, sys
root = os.environ["SNAPSHOT_ROOT_ARG"]
keep = int(os.environ["SNAPSHOT_KEEP_ARG"])
try:
    entries = []
    for name in os.listdir(root):
        full = os.path.join(root, name)
        if os.path.isdir(full) and not os.path.islink(full):
            try:
                entries.append((os.stat(full).st_mtime, full))
            except OSError:
                continue
    entries.sort(reverse=True)
    for _, path in entries[keep:]:
        print(path)
except Exception:
    pass
' 2>/dev/null || true)
  else
    # GNU find fallback (Linux without python3). BSD/macOS find lacks
    # `-printf` so this only reaches a sensible result on Linux —
    # acceptable as a last-resort path; python3 is the canonical one.
    to_delete=$(find "$SNAPSHOT_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn \
      | awk -v keep="$keep" 'NR > keep { $1 = ""; sub(/^ /, ""); print }')
  fi
  # Delete enumerated paths, but ONLY when they live under
  # SNAPSHOT_ROOT (defence against a buggy enumerator yielding
  # arbitrary paths). Empty list → loop no-ops cleanly.
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    case "$d" in
      "$SNAPSHOT_ROOT"/*) rm -rf "$d" 2>/dev/null || true ;;
    esac
  done <<< "$to_delete"
}

# ---------------------------------------------------------------------------
# Internal endpoint helpers — POST over loopback with the bearer token.
# Best-effort: missing secret or down endpoint logs and continues.
# ---------------------------------------------------------------------------
internal_base_url() {
  # Loopback-only enforcement. The internal endpoints accept a
  # bearer (INTERNAL_REVALIDATE_SECRET). If CAVECMS_INTERNAL_URL or
  # HEALTHZ_URL were ever pointed at a non-loopback host (env
  # tampering, settings injection, deploy script bug), every
  # maintenance toggle + audit-terminal POST would exfiltrate the
  # bearer to a remote endpoint. The endpoint also does its own
  # `isLoopbackInternalRequest` check on Host, but the secret is
  # already in the wire by then. Refuse anything that doesn't
  # resolve to 127.0.0.1 / localhost / [::1] CLIENT-side, BEFORE
  # we curl with the bearer attached.
  local candidate
  if [ -n "${CAVECMS_INTERNAL_URL:-}" ]; then
    candidate="${CAVECMS_INTERNAL_URL%/}"
  else
    candidate="${HEALTHZ_URL%/healthz}"
    candidate="${candidate%/}"
  fi
  [ -z "$candidate" ] && candidate="http://127.0.0.1:3040"
  case "$candidate" in
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|"http://[::1]"|"http://[::1]:"*)
      printf '%s' "$candidate"
      ;;
    *)
      # Non-loopback — silently fall back to the canonical default
      # rather than refuse outright. The internal endpoint will
      # accept the loopback request, and maintenance/audit functions
      # remain best-effort.
      printf '%s' "http://127.0.0.1:3040"
      ;;
  esac
}

post_maintenance_toggle() {
  local enabled="$1"
  if [ -z "${INTERNAL_REVALIDATE_SECRET:-}" ]; then
    return 0
  fi
  local base host url
  base=$(internal_base_url)
  url="${base}/api/internal/updates/maintenance"
  host="${base#http://}"
  host="${host#https://}"
  if curl -fsS --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}" \
    -H "Host: ${host}" \
    -H "Content-Type: application/json" \
    -d "{\"enabled\":${enabled}}" \
    "$url" >/dev/null 2>>"${LOG_DIR}/maintenance-toggle.log"; then
    return 0
  fi
  echo "[helpers] maintenance HTTP toggle ($enabled) failed; trying direct DB fallback" >&2
  # Direct-DB fallback. Most-impactful failure mode: the Next.js
  # process is itself unhealthy (the watchdog just confirmed it with
  # 15 failed healthz checks), so the loopback HTTP toggle 502s. If
  # we leave maintenance.enabled=true (set just before pm2 reload)
  # visitors see a 503 forever — the worst possible UX outcome of an
  # auto-rollback. Update the settings row directly via mysql so the
  # next middleware cache miss (3s TTL) reads the corrected value.
  _direct_db_maintenance_toggle "$enabled"
}

# Direct-DB maintenance toggle — last-resort path used when the
# loopback HTTP endpoint isn't reachable (Next.js down mid-failed-
# rollback). MERGE behaviour: read the current JSON, override only
# the `enabled` field, write back. Preserves operator-set
# `message` and `bypassIps` so an emergency toggle doesn't clobber
# planned-maintenance copy.
_direct_db_maintenance_toggle() {
  local enabled="$1"
  if [ -z "${DATABASE_URL:-}" ]; then return 1; fi
  if ! command -v mysql >/dev/null 2>&1; then return 1; fi
  if ! command -v python3 >/dev/null 2>&1; then return 1; fi

  local parsed
  parsed=$(_parse_database_url "$DATABASE_URL") || return 1
  local db_host db_port db_user db_pass db_name
  db_host=$(echo "$parsed" | awk 'NR==1')
  db_port=$(echo "$parsed" | awk 'NR==2')
  db_user=$(echo "$parsed" | awk 'NR==3')
  db_pass=$(echo "$parsed" | awk 'NR==4')
  db_name=$(echo "$parsed" | awk 'NR==5')
  if [ -z "$db_name" ]; then return 1; fi

  local cred_file
  cred_file=$(mktemp "${TMPDIR:-/tmp}/cavecms-maint-cred.XXXXXX")
  chmod 0600 "$cred_file"
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' \
    "$db_host" "$db_port" "$db_user" "$db_pass" > "$cred_file"
  # Verify the cred file actually got written. On a read-only `/tmp`
  # the printf above silently produces an empty file and mysql then
  # auths with no creds, prompting interactively (and hanging) or
  # failing in unhelpful ways. Bail fast.
  if [ ! -s "$cred_file" ]; then
    rm -f "$cred_file"
    return 1
  fi

  # Read existing JSON value, merge `enabled`, write back. Use python3
  # for the JSON manipulation so we don't string-mash JSON in awk.
  # `--connect-timeout=5` bounds the mysql probe — if the DB is also
  # part of what broke (network partition, mariadb-server stopped),
  # we want to fail fast, not hang the rollback for 60s+.
  local current_json
  current_json=$(mysql --defaults-extra-file="$cred_file" --connect-timeout=5 -BNe \
    "SELECT value FROM settings WHERE \`key\`='security_maintenance' LIMIT 1;" \
    "$db_name" 2>>"${LOG_DIR}/maintenance-toggle.log" || true)

  local merged_json
  merged_json=$(CAVECMS_NEW_ENABLED="$enabled" python3 -c '
import os, json, sys
raw = sys.stdin.read().strip()
try:
  data = json.loads(raw) if raw else {}
except Exception:
  data = {}
data["enabled"] = (os.environ["CAVECMS_NEW_ENABLED"] == "true")
print(json.dumps(data))
' <<< "$current_json" 2>>"${LOG_DIR}/maintenance-toggle.log" || true)

  if [ -z "$merged_json" ]; then
    rm -f "$cred_file"
    return 1
  fi

  # UPSERT via INSERT ... ON DUPLICATE KEY UPDATE so a brand-new
  # install with no row yet still gets the flag. version bump matches
  # what the HTTP path does. SQL-string-literal-escape both `\` and
  # `'` in the JSON value — MySQL's default mode interprets `\` in
  # string literals (decoding `\n` to newline, `\\` to `\`, etc.),
  # so if we only escape quotes a JSON like `{"message":"hi\\nthere"}`
  # decodes to literal newline on the round-trip and corrupts the
  # operator's planned-maintenance message. awk handles both
  # substitutions in one pass — `sed` is banned per project rules.
  # Order matters: backslashes FIRST (otherwise the doubled quotes'
  # backslashes get re-escaped).
  local sql_escaped_json
  sql_escaped_json=$(printf '%s' "$merged_json" | awk 'BEGIN{ORS=""} {
    gsub(/\\/, "\\\\");
    gsub(/'\''/, "'\'''\''");
    print
  }')
  local rc=0
  mysql --defaults-extra-file="$cred_file" --connect-timeout=5 "$db_name" << SQL >>"${LOG_DIR}/maintenance-toggle.log" 2>&1 || rc=$?
INSERT INTO settings (\`key\`, value, version, updated_by)
VALUES ('security_maintenance', '${sql_escaped_json}', 1, NULL)
ON DUPLICATE KEY UPDATE value=VALUES(value), version=version+1;
SQL
  rm -f "$cred_file"
  if [ $rc -ne 0 ]; then
    echo "[helpers] direct-DB maintenance toggle ($enabled) also failed" >&2
    return 1
  fi
  echo "[helpers] direct-DB maintenance toggle ($enabled) ok" >&2
  return 0
}

# post_audit_terminal <action> [error] [reason]
#   action: completed | failed | rolled_back
#   error : optional human-readable error (truncated to 500 chars by API)
#   reason: optional machine-readable cause (e.g. post_completion_watchdog)
#           stored in diff.reason — the UI uses it to render a variant
#           ("Rolled back automatically by the post-update guard")
post_audit_terminal() {
  local action="$1"
  local err="${2:-}"
  local reason="${3:-}"
  if [ -z "${INTERNAL_REVALIDATE_SECRET:-}" ]; then
    return 0
  fi
  local base host url
  base=$(internal_base_url)
  url="${base}/api/internal/updates/audit-terminal"
  host="${base#http://}"
  host="${host#https://}"

  local started_epoch=0 now_epoch=0 duration_ms=0
  if command -v python3 >/dev/null 2>&1; then
    # `strptime` is portable to Python 3.6 (RHEL 8 default).
    # `datetime.fromisoformat` requires 3.7+ — when invoked on
    # RHEL 8 it raised ValueError and the audit row's durationMs
    # silently became 0 (always-zero history rows). The format
    # below matches write_status's `now_iso` output exactly.
    started_epoch=$(python3 -c '
import os
from datetime import datetime, timezone
try:
  dt = datetime.strptime(os.environ["STARTED_AT"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
  print(int(dt.timestamp() * 1000))
except Exception:
  print(0)
' 2>/dev/null || echo 0)
    now_epoch=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0)
  fi
  if [ "$started_epoch" -gt 0 ] && [ "$now_epoch" -gt "$started_epoch" ]; then
    duration_ms=$((now_epoch - started_epoch))
  fi

  local esc_err esc_reason
  esc_err=$(json_escape "$err")
  esc_reason=$(json_escape "$reason")

  # Build the JSON body. Fields with empty values are omitted so the
  # Zod schema on the receiving end doesn't reject (its `error` field
  # is optional but enforces max length even on empty strings).
  local body="{\"action\":\"${action}\",\"fromSha\":\"${FROM_SHA}\",\"toSha\":\"${TARGET_SHA}\",\"durationMs\":${duration_ms}"
  if [ -n "$err" ]; then
    body="${body},\"error\":\"${esc_err}\""
  fi
  if [ -n "$reason" ]; then
    body="${body},\"reason\":\"${esc_reason}\""
  fi
  body="${body}}"

  curl -fsS --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}" \
    -H "Host: ${host}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$url" >/dev/null 2>>"${LOG_DIR}/audit-terminal.log" || \
    echo "[helpers] audit-terminal POST ($action) failed (non-fatal)" >&2
}

# ---------------------------------------------------------------------------
# DB backup + restore — parse DATABASE_URL via python3, write a temp
# defaults-extra-file at mode 0600, mysqldump | gzip the schema + data.
# Returns sentinel strings on stdout the caller can branch on.
# ---------------------------------------------------------------------------
_parse_database_url() {
  local db_url="$1"
  if ! command -v python3 >/dev/null 2>&1; then return 1; fi
  DATABASE_URL="$db_url" python3 -c '
import os, sys
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["DATABASE_URL"])
print(u.hostname or "127.0.0.1")
print(u.port or 3306)
print(unquote(u.username or ""))
print(unquote(u.password or ""))
print((u.path or "/").lstrip("/").split("?")[0])
'
}

db_backup() {
  local sha="$1"
  local out="${LOG_DIR}/pre-update-${sha}.sql.gz"
  if ! command -v mysqldump >/dev/null 2>&1; then echo "SKIPPED"; return 0; fi
  if ! command -v python3 >/dev/null 2>&1; then echo "SKIPPED"; return 0; fi
  local db_url="${DATABASE_URL:-}"
  if [ -z "$db_url" ]; then echo "SKIPPED"; return 0; fi

  local parsed
  parsed=$(_parse_database_url "$db_url") || { echo ""; return 1; }
  local db_host db_port db_user db_pass db_name
  db_host=$(echo "$parsed" | awk 'NR==1')
  db_port=$(echo "$parsed" | awk 'NR==2')
  db_user=$(echo "$parsed" | awk 'NR==3')
  db_pass=$(echo "$parsed" | awk 'NR==4')
  db_name=$(echo "$parsed" | awk 'NR==5')
  if [ -z "$db_name" ]; then echo ""; return 1; fi

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
  parsed=$(_parse_database_url "$db_url") || return 1
  local db_host db_port db_user db_pass db_name
  db_host=$(echo "$parsed" | awk 'NR==1')
  db_port=$(echo "$parsed" | awk 'NR==2')
  db_user=$(echo "$parsed" | awk 'NR==3')
  db_pass=$(echo "$parsed" | awk 'NR==4')
  db_name=$(echo "$parsed" | awk 'NR==5')
  if [ -z "$db_name" ]; then return 1; fi

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
# Non-blocking exclusive lock acquisition. Used by the watchdog when
# entering its rollback path; the orchestrator uses the apply-route's
# O_EXCL openSync instead (cross-language compatibility).
#
# Strategy preference:
#   1. `flock -n -x` (util-linux + most BSDs) — atomic, kernel-backed,
#      released automatically on fd close. Most reliable across bash
#      versions and surface-fs types.
#   2. `set -C` (noclobber) redirect — atomic on bash 4.2+ Linux, but
#      non-atomic on bash 3.2 and some BSDs (uses O_CREAT|O_TRUNC then
#      stat-check, race window). Last-resort fallback.
#
# Args: <lock-path>
# Side effect on success: opens fd 9 on the lock file (caller must
# release via `exec 9>&-`). PID stamped into the lock file's contents
# so lockIsStale's PID-liveness check in lib/updates/statusFile.ts
# can probe `kill(pid, 0)` on it.
# Returns: 0 on acquisition, 1 if the lock is already held.
# ---------------------------------------------------------------------------
acquire_lock_or_defer() {
  local lock_path="$1"
  if command -v flock >/dev/null 2>&1; then
    # `9>` opens for write (creates if missing) on fd 9, truncating
    # the file on open. flock -n -x takes a non-blocking exclusive
    # lock on that fd. If another process holds the lock, flock
    # exits non-zero and we leave the file unmodified (just close fd
    # 9 — the lock file may remain, but the lock itself isn't held).
    exec 9>"$lock_path" 2>/dev/null || return 1
    if ! flock -n -x 9 2>/dev/null; then
      exec 9>&- 2>/dev/null || true
      return 1
    fi
    # Stamp our PID through the locked fd so lockIsStale (TS side,
    # lib/updates/statusFile.ts) and ad-hoc inspection see who holds
    # it. Writing through fd 9 (which was opened with truncation)
    # avoids the truncate-then-write race that a separate `: >` then
    # `printf > "$lock_path"` pair would have.
    printf '%s\n' "$$" >&9
    return 0
  fi
  # set -C fallback. Bash redirect with noclobber uses O_CREAT|O_EXCL
  # on bash 4.2+ Linux (atomic); on older shells the semantics are
  # weaker but still close to atomic.
  if ( set -C; printf '%s\n' "$$" > "$lock_path" ) 2>/dev/null; then
    return 0
  fi
  return 1
}

release_lock() {
  local lock_path="$1"
  # Close fd 9 if we held the flock; ignore if it wasn't open.
  exec 9>&- 2>/dev/null || true
  rm -f "$lock_path" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Detach-mechanism dispatch — for spawning a detached child that
# survives a pm2 reload of the parent Next.js process. Mechanism is
# chosen by the apply route (TS side) and passed in via
# CAVECMS_DETACH_MECHANISM; this helper trusts that selection so both
# orchestrator + watchdog use the same one.
#
# Mechanisms (strongest → weakest):
#   systemd-run-user : runs in a fresh systemd user scope — fully
#                      escapes the parent's cgroup; SIGTERM to the
#                      parent cgroup cannot reach this process.
#   setsid-nohup     : new session via setsid + signal-ignore via
#                      nohup. No cgroup escape, but typically enough
#                      to survive pm2's kill-tree walk because the
#                      child is no longer in the parent's pgroup.
#   nohup-only       : last-resort POSIX baseline. Survives terminal
#                      hangup but may still be killed by pm2 if pm2
#                      walks descendant PIDs explicitly.
#
# Args: <script_path> [args...]
# Detaches and returns immediately. Stdout/stderr go to LOG_DIR.
# ---------------------------------------------------------------------------
spawn_detached() {
  local script="$1"
  shift
  local mechanism="${CAVECMS_DETACH_MECHANISM:-auto}"
  if [ "$mechanism" = "auto" ]; then
    if command -v systemd-run >/dev/null 2>&1 \
      && [ -n "${XDG_RUNTIME_DIR:-}" ] \
      && [ -S "${XDG_RUNTIME_DIR}/bus" ]; then
      mechanism="systemd-run-user"
    elif command -v setsid >/dev/null 2>&1; then
      mechanism="setsid-nohup"
    else
      mechanism="nohup-only"
    fi
  fi

  local spawn_log="${LOG_DIR}/watchdog-spawn.log"
  echo "[spawn-detached] $(now_iso) mechanism=${mechanism} script=${script}" >> "$spawn_log"

  # Constrain unit name to a safe character set even if rand_suffix
  # is ever changed to return weirder values. systemd-run accepts a
  # restricted unit-name character set; tr -cd guards against future
  # rand_suffix regressions.
  local unit_name
  unit_name="cavecms-watchdog-$(rand_suffix | tr -cd 'A-Za-z0-9-')"

  _spawn_systemd_run_user() {
    # Forward the env the orchestrator + watchdog actually need.
    # `--setenv=NAME` (bare, copy-from-caller) requires systemd 249+
    # (RHEL 9, Ubuntu 22.04+). On systemd 239 (RHEL 8 / CentOS 8) and
    # 245 (Ubuntu 20.04) the bare form sets the var to empty string,
    # which blanks PM2_HOME / DATABASE_URL / INTERNAL_REVALIDATE_SECRET
    # inside the scope and breaks the orchestrator. Use the explicit
    # `--setenv=NAME=VALUE` form, supported since systemd 209 — works
    # on every host we support.
    local setenv_args=()
    local v val
    for v in \
      PATH HOME USER LOGNAME LANG LC_ALL TZ NODE_ENV \
      PM2_HOME DATABASE_URL DATABASE_MIGRATOR_URL \
      INTERNAL_REVALIDATE_SECRET HEALTHZ_TOKEN HEALTHZ_URL \
      XDG_RUNTIME_DIR \
      CAVECMS_REPO_DIR CAVECMS_LOG_DIR CAVECMS_INTERNAL_URL \
      CAVECMS_UPDATE_STATUS_PATH CAVECMS_DETACH_MECHANISM \
      CAVECMS_HEALTHZ_URL CAVECMS_SNAPSHOT_ROOT CAVECMS_SNAPSHOT_KEEP \
      CAVECMS_MAINT_TOGGLED_BY_US CAVECMS_STATUS_WATCHDOG_UNTIL \
      CAVECMS_WATCHDOG_FROM_SHA CAVECMS_WATCHDOG_TO_SHA \
      CAVECMS_WATCHDOG_PREVIOUS_SHA CAVECMS_WATCHDOG_DURATION_S \
      CAVECMS_WATCHDOG_INTERVAL_S CAVECMS_WATCHDOG_FAIL_THRESHOLD \
      CAVECMS_WATCHDOG_HAD_MIGRATION CAVECMS_WATCHDOG_BACKUP_DUMP \
      CAVECMS_KICKOFF_TOKEN CAVECMS_KICKOFF_TOKEN_FILE; do
      val="${!v:-}"
      if [ -n "$val" ]; then
        setenv_args+=("--setenv=${v}=${val}")
      fi
    done
    systemd-run --user --scope --no-block --quiet --collect \
      --unit="${unit_name}" \
      "${setenv_args[@]}" \
      -- /bin/bash "$script" "$@" \
      </dev/null >>"$spawn_log" 2>&1
  }

  _spawn_setsid_nohup() {
    ( setsid nohup /bin/bash "$script" "$@" \
        </dev/null >>"$spawn_log" 2>&1 & disown ) \
      </dev/null >/dev/null 2>&1 &
  }

  _spawn_nohup_only() {
    ( nohup /bin/bash "$script" "$@" \
        </dev/null >>"$spawn_log" 2>&1 & disown ) \
      </dev/null >/dev/null 2>&1 &
  }

  # Try the chosen mechanism, fall through to weaker ones on failure
  # (e.g. systemd-run-user is selected but user systemd died between
  # apply time and orchestrator end-of-update an hour later).
  case "$mechanism" in
    systemd-run-user)
      if _spawn_systemd_run_user "$@"; then return 0; fi
      echo "[spawn-detached] systemd-run-user failed; falling back to setsid-nohup" >> "$spawn_log"
      if command -v setsid >/dev/null 2>&1; then
        _spawn_setsid_nohup
        return 0
      fi
      _spawn_nohup_only
      ;;
    setsid-nohup)
      if command -v setsid >/dev/null 2>&1; then
        _spawn_setsid_nohup
      else
        _spawn_nohup_only
      fi
      ;;
    *)
      _spawn_nohup_only
      ;;
  esac
}
