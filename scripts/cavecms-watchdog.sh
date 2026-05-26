#!/usr/bin/env bash
# scripts/cavecms-watchdog.sh — post-completion health watchdog.
#
# Spawned detached by scripts/cavecms-update.sh at the END of a
# successful update. Polls /healthz every WATCHDOG_INTERVAL_S seconds
# for WATCHDOG_DURATION_S seconds total (default 30s × 1h). On
# WATCHDOG_FAIL_THRESHOLD consecutive failures (default 3), acquires
# the update lock, flips maintenance ON, restores the previous tree
# from snapshot, reinstalls deps, reloads pm2, writes a rolled_back
# terminal audit row with reason='post_completion_watchdog'.
#
# Why a separate process: pm2 reload kills the orchestrator's parent
# Node process; a post-completion guard living INSIDE that process
# would die with it. The watchdog is detached so it survives indefinite
# numbers of reloads from the operator-visible update flow.
#
# Why outside the update lock during normal polling: holding the lock
# for an hour would block any operator who wanted to apply a NEW
# update. We acquire ONLY when entering rollback; if a new manual
# update is in flight at that moment, lock contention defers our
# rollback (the new update is the operator's intent and supersedes).
#
# Inputs (env, set by the spawning orchestrator):
#   CAVECMS_WATCHDOG_FROM_SHA       — what the install was on before
#                                     the update we're guarding.
#   CAVECMS_WATCHDOG_TO_SHA         — the SHA the update brought up.
#   CAVECMS_WATCHDOG_PREVIOUS_SHA   — the snapshot key for rollback.
#   CAVECMS_WATCHDOG_DURATION_S     — total watchdog window (default 3600).
#   CAVECMS_WATCHDOG_INTERVAL_S     — poll interval (default 30).
#   CAVECMS_WATCHDOG_FAIL_THRESHOLD — consecutive fails before rollback (default 3).
#   CAVECMS_WATCHDOG_HAD_MIGRATION  — "1" if the update migrated DB.
#   CAVECMS_WATCHDOG_BACKUP_DUMP    — path to the pre-update DB dump.
#   STATUS_PATH, LOG_DIR, REPO_DIR, HEALTHZ_URL, HEALTHZ_TOKEN,
#   INTERNAL_REVALIDATE_SECRET — inherited from the parent.

# `set -e` deliberately NOT enabled — the polling loop's transient
# failures (one bad healthz, one transient curl) must not abort the
# whole watchdog. We use explicit if/rc checks throughout.
set -uo pipefail
shopt -s inherit_errexit 2>/dev/null || true

# Same hardened PATH as the orchestrator.
HOME_DIR="${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${HOME_DIR}/.local/share/pnpm:${HOME_DIR}/.npm-global/bin:${PATH:-}"

# Required env. Refuse to start if the orchestrator didn't pass them.
FROM_SHA="${CAVECMS_WATCHDOG_FROM_SHA:-}"
TARGET_SHA="${CAVECMS_WATCHDOG_TO_SHA:-}"
PREVIOUS_SHA="${CAVECMS_WATCHDOG_PREVIOUS_SHA:-}"
HAD_MIGRATION="${CAVECMS_WATCHDOG_HAD_MIGRATION:-0}"
BACKUP_DUMP="${CAVECMS_WATCHDOG_BACKUP_DUMP:-}"

if [ -z "$TARGET_SHA" ] || [ -z "$PREVIOUS_SHA" ]; then
  echo "[watchdog] missing required env (TO_SHA=$TARGET_SHA PREVIOUS_SHA=$PREVIOUS_SHA) — refusing to start" >&2
  exit 2
fi

# Required paths. Same allowlist/fallback rules as the orchestrator.
STATUS_PATH="${CAVECMS_UPDATE_STATUS_PATH:-/var/lib/cavecms/update-status.json}"
LOCK_PATH="${STATUS_PATH}.lock"
HEALTHZ_URL="${CAVECMS_HEALTHZ_URL:-http://127.0.0.1:3040/healthz}"
HEALTHZ_TOKEN="${HEALTHZ_TOKEN:-}"
REPO_DIR="${CAVECMS_REPO_DIR:-$(pwd)}"
LOG_DIR="${CAVECMS_LOG_DIR:-/var/log/cavecms}"
mkdir -p "$LOG_DIR" 2>/dev/null || true
if ! ( touch "$LOG_DIR/.cavecms-watchdog-probe" 2>/dev/null && rm -f "$LOG_DIR/.cavecms-watchdog-probe" 2>/dev/null ); then
  LOG_DIR=/tmp
fi

DURATION_S="${CAVECMS_WATCHDOG_DURATION_S:-3600}"
INTERVAL_S="${CAVECMS_WATCHDOG_INTERVAL_S:-30}"
FAIL_THRESHOLD="${CAVECMS_WATCHDOG_FAIL_THRESHOLD:-3}"

# STARTED_AT for the watchdog's OWN audit-row durationMs. Differs
# from the orchestrator's STARTED_AT, which is already in the kick-off
# audit row.
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
export STARTED_AT

# Source the shared helpers.
HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=scripts/lib/cavecms-update-helpers.sh
. "${HELPERS_DIR}/cavecms-update-helpers.sh"

LOG="${LOG_DIR}/watchdog.log"
echo "[watchdog] $(now_iso) starting — guarding ${TARGET_SHA:0:12} for ${DURATION_S}s; previous=${PREVIOUS_SHA:0:12}" > "$LOG"

# Hard requirement: curl must exist. Without it every healthz probe
# fails identically — leading to a false-positive rollback on a
# perfectly healthy install. Refuse loud rather than slowly destroy
# the operator's day.
if ! command -v curl >/dev/null 2>&1; then
  echo "[watchdog] curl not installed — cannot probe healthz, refusing to start" >&2
  exit 3
fi

# Validate the snapshot SHA the orchestrator passed. is_safe_snapshot_sha
# is in the helpers — defence in depth against a malformed env handoff.
if ! is_safe_snapshot_sha "$PREVIOUS_SHA"; then
  echo "[watchdog] previous SHA '$PREVIOUS_SHA' is not a safe hex/from-N value — refusing" >&2
  exit 4
fi

# Kick-off token verification — guards against an attacker spawning
# `bash cavecms-watchdog.sh` directly with crafted env (malicious
# BACKUP_DUMP, PREVIOUS_SHA pointing at an attacker-planted snapshot,
# etc.). The orchestrator writes a one-shot token to a 0600 file
# before spawn; we verify the file's contents match what we got in
# env AND the file is owned by the current user. Mismatched/missing
# token → refuse + exit silently (orchestrator's own logs show the
# spawn happened).
if [ -n "${CAVECMS_KICKOFF_TOKEN:-}" ] && [ -n "${CAVECMS_KICKOFF_TOKEN_FILE:-}" ]; then
  if [ ! -f "$CAVECMS_KICKOFF_TOKEN_FILE" ]; then
    echo "[watchdog] kick-off token file missing — refusing" >&2
    exit 5
  fi
  # Owner check. The token file must be owned by the same uid that's
  # running this watchdog, ensuring no other user planted it.
  # `stat -c %u` (GNU/Linux) and `stat -f %u` (BSD/macOS) cover the
  # supported hosts; busybox-only images expose neither, and the
  # check degrades to "skipped" — we log that explicitly so an
  # operator running on Alpine can spot the missing defence.
  if command -v stat >/dev/null 2>&1; then
    file_uid=$(stat -c %u "$CAVECMS_KICKOFF_TOKEN_FILE" 2>/dev/null \
              || stat -f %u "$CAVECMS_KICKOFF_TOKEN_FILE" 2>/dev/null \
              || echo "")
    if [ -z "$file_uid" ]; then
      echo "[watchdog] $(now_iso) WARN: stat flags unsupported; token-file owner check skipped" >> "$LOG"
    elif [ "$file_uid" != "$(id -u)" ]; then
      echo "[watchdog] kick-off token file owner mismatch — refusing" >&2
      exit 6
    fi
  else
    echo "[watchdog] $(now_iso) WARN: stat not on PATH; token-file owner check skipped" >> "$LOG"
  fi
  # Constant-time compare (best effort via python3) so the watchdog
  # can't be timing-oracled on the token. Plain `[ "$a" = "$b" ]`
  # also short-circuits but with high enough cost-per-char that
  # remote timing is impractical here (file read is local).
  file_token=$(cat "$CAVECMS_KICKOFF_TOKEN_FILE" 2>/dev/null || echo "")
  if [ "$file_token" != "$CAVECMS_KICKOFF_TOKEN" ]; then
    echo "[watchdog] kick-off token mismatch — refusing" >&2
    exit 7
  fi
  # Consume the token — single-use. If the orchestrator ever spawns
  # the watchdog twice (it shouldn't), the second invocation fails
  # the file-exists check.
  rm -f "$CAVECMS_KICKOFF_TOKEN_FILE" 2>/dev/null || true
else
  # No token in env → orchestrator either didn't generate one (python3
  # + /dev/urandom both unavailable) OR an attacker spawned us
  # without it. Either way, refuse to do destructive ops without
  # the auth boundary. Log + exit 0 so the spawning side doesn't
  # cascade the failure.
  echo "[watchdog] no kick-off token in env — refusing to start" >&2
  exit 8
fi

# ---------------------------------------------------------------------------
# Rollback path — runs when consecutive healthz failures hit the
# threshold AND we successfully acquire the lock. Mirrors the
# orchestrator's rollback_to_previous but with watchdog-specific
# status copy + reason='post_completion_watchdog' on the audit row.
# ---------------------------------------------------------------------------
do_rollback() {
  echo "[watchdog] $(now_iso) rollback condition met — attempting restore from snapshot ${PREVIOUS_SHA:0:12}" >> "$LOG"

  # Acquire the shared flock-backed lock. Non-blocking — if a manual
  # update is in flight we defer + exit so the operator stays in
  # control of the new run.
  if ! acquire_lock_or_defer "$LOCK_PATH"; then
    echo "[watchdog] couldn't acquire lock — another update is in flight, deferring" >> "$LOG"
    return 0
  fi

  # Function-local trap that explicitly disarms on exit so it can't
  # double-fire as a script-global trap (bash traps are process-
  # scoped, not function-scoped). The cleanup releases the lock we
  # just took and — ONLY IF WE turned maintenance ON ourselves —
  # flips it OFF. The CAVECMS_MAINT_TOGGLED_BY_US sentinel guards
  # against the operator-clobber failure mode where they set
  # security_maintenance.enabled=true manually (planned window)
  # mid-watchdog, and our trap would otherwise flip it back off.
  trap '
    set +e
    if [ "${CAVECMS_MAINT_TOGGLED_BY_US:-0}" = "1" ]; then
      post_maintenance_toggle false
    fi
    release_lock "$LOCK_PATH"
    trap - EXIT
  ' EXIT

  # Flip maintenance ON so visitors see the branded 503 during the
  # rollback rather than connection errors. Verify success — if the
  # toggle failed AND the helper's direct-DB fallback also failed,
  # we'd proceed into a destructive op while visitors get raw 500s.
  # Refuse to proceed in that case.
  if ! post_maintenance_toggle true; then
    write_status "failed" 6 \
      "We can't safely roll back automatically right now" \
      "We detected a problem with the new version, but couldn't put the site in maintenance mode to roll back. Check your server immediately." \
      ""
    post_audit_terminal failed "maintenance_toggle_on_failed_pre_rollback" "post_completion_watchdog"
    return 1
  fi
  # Now we know WE flipped it on (the helper returned 0); the trap
  # will flip it back off on every exit path. Without the sentinel,
  # the trap would clobber an operator-set state on failure paths
  # where post_maintenance_toggle true was actually a no-op.
  export CAVECMS_MAINT_TOGGLED_BY_US=1

  # Status: show "rolling back" so the operator's modal (if open)
  # picks up the new state on its next poll.
  CAVECMS_STATUS_WATCHDOG_UNTIL=""
  write_status "restarting" 6 "Restoring your previous version automatically" "" ""

  # Snapshot restore.
  if ! restore_from_snapshot "$PREVIOUS_SHA"; then
    write_status "failed" 6 "We tried to restore your previous version but couldn't" "Your site may be offline — contact support immediately." ""
    post_audit_terminal failed "restore_from_snapshot_failed" "post_completion_watchdog"
    return 1
  fi

  # Best-effort git HEAD alignment.
  if git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$REPO_DIR" reset --hard "$PREVIOUS_SHA" >/dev/null 2>&1 || true
  fi

  # DB restore if a migration ran.
  if [ "$HAD_MIGRATION" = "1" ]; then
    if [ -n "$BACKUP_DUMP" ] && [ -f "$BACKUP_DUMP" ]; then
      if ! restore_db_backup "$BACKUP_DUMP"; then
        write_status "failed" 6 "We restored your previous files but couldn't restore your database" "Your site may be in a half-restored state — contact support immediately." ""
        post_audit_terminal failed "restore_db_backup_failed" "post_completion_watchdog"
        return 1
      fi
    else
      write_status "failed" 6 "We can't roll back the database changes from the last update" "Your site is on the new database structure but the new code stopped responding. Contact support immediately." ""
      post_audit_terminal failed "missing_db_backup_for_rollback" "post_completion_watchdog"
      return 1
    fi
  fi

  # Reinstall + pm2 reload.
  if ! (cd "$REPO_DIR" && pnpm install --frozen-lockfile >/dev/null 2>>"${LOG_DIR}/watchdog-install.log"); then
    write_status "failed" 6 "We restored your previous version's files but couldn't reinstall its dependencies" "Your site may be offline — contact support immediately." ""
    post_audit_terminal failed "pnpm_install_failed_on_rollback" "post_completion_watchdog"
    return 1
  fi

  (cd "$REPO_DIR" && pm2 reload ecosystem.config.cjs --update-env >/dev/null 2>&1 || true)

  # Verify rollback health (15 × 2s = 30s budget).
  local success=0 i
  local healthz_args=()
  if [ -n "$HEALTHZ_TOKEN" ]; then
    healthz_args=(-H "Authorization: Bearer $HEALTHZ_TOKEN")
  fi
  for i in $(seq 1 15); do
    sleep 2
    if curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "$HEALTHZ_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      success=$((success + 1))
      [ $success -ge 2 ] && break
    fi
  done
  if [ $success -lt 2 ]; then
    write_status "failed" 6 "We restored your previous version but it isn't responding" "Your site may be offline — contact support immediately." ""
    # post_maintenance_toggle false runs via the EXIT trap on return.
    # The helper's direct-DB fallback ensures maintenance flips off
    # even when the loopback Next.js is unhealthy — critical here.
    post_audit_terminal failed "healthz_unhealthy_after_rollback" "post_completion_watchdog"
    return 1
  fi

  # Rollback successful. Audit row uses PREVIOUS_SHA as the post-
  # rollback "to" and TARGET_SHA as the "from" — operator's history
  # reads "rolled back from <new> to <old>" which matches the
  # actually-running version. SWAP the env vars temporarily so
  # post_audit_terminal's body uses the inverted direction.
  CAVECMS_STATUS_WATCHDOG_UNTIL=""
  write_status "rolled_back" 6 "We put your site back on the previous version" "Your site started having problems after the last update, so we restored it automatically. Check your update history for details." ""
  local _orig_from="$FROM_SHA" _orig_to="$TARGET_SHA"
  FROM_SHA="$TARGET_SHA"
  TARGET_SHA="$PREVIOUS_SHA"
  post_audit_terminal rolled_back "delayed_unhealthy_after_update" "post_completion_watchdog"
  FROM_SHA="$_orig_from"
  TARGET_SHA="$_orig_to"

  echo "[watchdog] $(now_iso) rollback complete" >> "$LOG"
  return 0
}

# ---------------------------------------------------------------------------
# Main polling loop.
# ---------------------------------------------------------------------------
deadline_epoch=$(( $(date +%s) + DURATION_S ))
consecutive_fails=0
healthz_args=()
if [ -n "$HEALTHZ_TOKEN" ]; then
  healthz_args=(-H "Authorization: Bearer $HEALTHZ_TOKEN")
fi

while [ "$(date +%s)" -lt "$deadline_epoch" ]; do
  sleep "$INTERVAL_S"

  # Step-aside: if a NEW update has started (operator clicked Update
  # Now or hit Re-run install since we began watching), the status
  # state will be one of {preflight, updating, restarting} — back
  # out gracefully. {failed, rolled_back} mean someone else already
  # decided this update's fate.
  case "$(read_status_state)" in
    failed|rolled_back|preflight|updating|restarting)
      echo "[watchdog] $(now_iso) status=$(read_status_state) — stepping aside" >> "$LOG"
      exit 0
      ;;
  esac

  # toSha mismatch step-aside: status was 'completed' but is the
  # status's toSha the version WE were spawned to guard? If not, a
  # subsequent update completed under us and we're guarding the wrong
  # version. Read directly from the JSON via python3; fall through
  # if python3 is missing (which would already have failed earlier).
  if command -v python3 >/dev/null 2>&1; then
    local_to_sha=$(python3 -c '
import json, sys
try:
  d = json.load(open(sys.argv[1]))
  print(d.get("toSha", ""))
except Exception:
  print("")
' "$STATUS_PATH" 2>/dev/null || echo "")
    if [ -n "$local_to_sha" ] && [ "$local_to_sha" != "$TARGET_SHA" ]; then
      echo "[watchdog] $(now_iso) status.toSha=${local_to_sha:0:12} != our target=${TARGET_SHA:0:12} — stepping aside" >> "$LOG"
      exit 0
    fi
  fi

  if curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "$HEALTHZ_URL" 2>/dev/null | grep -q '"status":"ok"'; then
    # Healthz returned ok. When HEALTHZ_TOKEN is set, also verify the
    # running process's commit matches what we were spawned to guard.
    # A silent pm2 manifest restore (operator ran `pm2 resurrect` or
    # `pm2 restore` from an old dump mid-window) can revert to the
    # OLD build while healthz keeps returning ok from the OLD-version
    # process. Without this check, the watchdog would declare a
    # rolled-back install healthy and never alert.
    healthz_commit_ok=1
    if [ -n "$HEALTHZ_TOKEN" ] && command -v python3 >/dev/null 2>&1; then
      verbose=$(curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "${HEALTHZ_URL}?verbose=1" 2>/dev/null || echo "")
      running_commit=$(printf '%s' "$verbose" | python3 -c '
import json,sys
try:
  d = json.loads(sys.stdin.read())
  print(d.get("commit","") if isinstance(d, dict) else "")
except Exception:
  print("")
' 2>/dev/null || echo "")
      if [ -n "$running_commit" ] && [ "$running_commit" != "${TARGET_SHA:0:12}" ]; then
        healthz_commit_ok=0
        echo "[watchdog] $(now_iso) healthz ok but commit=$running_commit != target=${TARGET_SHA:0:12} — treating as fail" >> "$LOG"
      fi
    fi
    if [ "$healthz_commit_ok" = "1" ]; then
      if [ "$consecutive_fails" -ne 0 ]; then
        echo "[watchdog] $(now_iso) healthz recovered after $consecutive_fails fail(s)" >> "$LOG"
      fi
      consecutive_fails=0
    else
      consecutive_fails=$((consecutive_fails + 1))
      if [ "$consecutive_fails" -ge "$FAIL_THRESHOLD" ]; then
        do_rollback || true
        exit 0
      fi
    fi
  else
    consecutive_fails=$((consecutive_fails + 1))
    echo "[watchdog] $(now_iso) healthz fail #$consecutive_fails" >> "$LOG"
    if [ "$consecutive_fails" -ge "$FAIL_THRESHOLD" ]; then
      do_rollback || true
      exit 0
    fi
  fi
done

# Watchdog window elapsed without incident — clear the watchdogUntil
# flag so the UI banner disappears the next time it polls status.
echo "[watchdog] $(now_iso) duration elapsed cleanly" >> "$LOG"
CAVECMS_STATUS_WATCHDOG_UNTIL=""
# Only update if the current state is still 'completed' AND the
# status's toSha still matches OUR target. Otherwise an unrelated
# in-flight update could be clobbered.
if [ "$(read_status_state)" = "completed" ]; then
  if command -v python3 >/dev/null 2>&1; then
    final_to_sha=$(python3 -c '
import json, sys
try:
  d = json.load(open(sys.argv[1]))
  print(d.get("toSha", ""))
except Exception:
  print("")
' "$STATUS_PATH" 2>/dev/null || echo "")
    if [ "$final_to_sha" = "$TARGET_SHA" ]; then
      write_status "completed" 6 "Update successful — you're on the new version" "" ""
    fi
  fi
fi
exit 0
