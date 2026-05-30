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
# ROLLBACK_MODE=1 → standalone rollback (no target SHA). Triggered by
# `cavecms-update.sh rollback`, used by the `cavecms rollback` CLI to
# restore the previous version from the most recent snapshot when the
# dashboard is unreachable. The snapshot to restore TO is resolved later
# (most-recent dir under SNAPSHOT_ROOT), so no SHA argument is required.
ROLLBACK_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --) shift; break ;;
    rollback) ROLLBACK_MODE=1; shift; break ;;
    -*) echo "[cavecms-update] unknown flag: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
if [ "$ROLLBACK_MODE" = "1" ]; then
  TARGET_SHA=""
else
  if [ $# -lt 1 ]; then
    echo "[cavecms-update] usage: cavecms-update.sh [--force] <target-sha> | rollback" >&2
    exit 2
  fi
  TARGET_SHA="$1"
  if [[ ! "$TARGET_SHA" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
    echo "[cavecms-update] invalid target SHA '$TARGET_SHA'" >&2
    exit 2
  fi
  TARGET_SHA="$(echo "$TARGET_SHA" | tr 'A-F' 'a-f')"
fi
# Allow CAVECMS_UPDATE_FORCE=1 env to set force without re-spawning the
# script — apply route sets this when it spawns the child, so an
# operator clicking "Re-run install" doesn't need a CLI flag.
if [ "${CAVECMS_UPDATE_FORCE:-0}" = "1" ]; then
  FORCE=1
fi

FROM_SHA="${CAVECMS_UPDATE_FROM:-unknown}"
# Status-path resolution:
#   1. CAVECMS_UPDATE_STATUS_PATH explicit override (legacy + tests)
#   2. CAVECMS_STATE_DIR/update-status.json — CLI-installed sites, owned
#      by the runtime user (no pm2-daemon-restart needed for groups)
#   3. /var/lib/cavecms/update-status.json — bare-metal deploys with
#      the cavecmsstate-group / 2770 system dir provisioned by setup
if [ -n "${CAVECMS_UPDATE_STATUS_PATH:-}" ]; then
  STATUS_PATH="$CAVECMS_UPDATE_STATUS_PATH"
elif [ -n "${CAVECMS_STATE_DIR:-}" ]; then
  STATUS_PATH="$CAVECMS_STATE_DIR/update-status.json"
else
  STATUS_PATH="/var/lib/cavecms/update-status.json"
fi
HEALTHZ_URL="${CAVECMS_HEALTHZ_URL:-http://127.0.0.1:3040/healthz}"
HEALTHZ_TOKEN="${HEALTHZ_TOKEN:-}"
REPO_DIR="${CAVECMS_REPO_DIR:-$(pwd)}"
LOG_DIR="${CAVECMS_LOG_DIR:-/var/log/cavecms}"
ENV_FILE="${CAVECMS_ENV_FILE:-/etc/cavecms/env.production}"
LOCK_PATH="${STATUS_PATH}.lock"

# Path allowlist — same guard as lib/updates/statusFile.ts. Refuse if
# operator points STATUS_PATH at /etc/cron.d/* or similar. CAVECMS_STATE_DIR
# (per-install runtime-state directory) is also accepted when set.
allowed=0
case "$STATUS_PATH" in
  /var/lib/cavecms/*|/tmp/*|/var/folders/*) allowed=1 ;;
esac
if [ "$allowed" = "0" ] && [ -n "${CAVECMS_STATE_DIR:-}" ]; then
  case "$STATUS_PATH" in
    "$CAVECMS_STATE_DIR"/*) allowed=1 ;;
  esac
fi
# Legacy-install fallback. When env.production was written by a
# pre-0.1.27 CLI it has neither CAVECMS_UPDATE_STATUS_PATH nor
# CAVECMS_STATE_DIR. The Node-side apply route (lib/updates/statusFile.ts
# getInstallStateDir) derives `<cwd>/.cavecms-state/update-status.json`
# from the install's own filesystem (owned by the runtime user by
# construction) and forwards the resolved path to us via
# CAVECMS_UPDATE_STATUS_PATH. Accept anything ending in
# `/.cavecms-state/...` so the script's allowlist matches the Node
# side's fallback. The path-traversal vector is still closed: the
# `.cavecms-state` literal anchors the match.
if [ "$allowed" = "0" ]; then
  case "$STATUS_PATH" in
    */.cavecms-state/*) allowed=1 ;;
  esac
fi
if [ "$allowed" = "0" ]; then
  echo "[cavecms-update] STATUS_PATH '$STATUS_PATH' not under allowed prefix" >&2
  exit 2
fi

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
# Shared helpers — write_status, snapshot_current_tree,
# restore_from_snapshot, prune_old_snapshots, post_maintenance_toggle,
# post_audit_terminal, db_backup, restore_db_backup, spawn_detached,
# internal_base_url, now_iso, rand_suffix, json_escape, read_status_state.
# All sourced from scripts/lib/cavecms-update-helpers.sh so the watchdog
# (scripts/cavecms-watchdog.sh) sees the same primitives.
# ---------------------------------------------------------------------------
HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=scripts/lib/cavecms-update-helpers.sh
. "${HELPERS_DIR}/cavecms-update-helpers.sh"

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
  # Disable errexit inside the trap so any failed command here can't
  # cause re-entry or silent abort. The trap MUST always reach the
  # lock cleanup at the bottom.
  set +e
  local current_state
  current_state=$(read_status_state)
  case "$current_state" in
    completed|failed|rolled_back)
      # Terminal state already written by the explicit step handlers
      # or rollback path — nothing to do here.
      ;;
    *)
      # Script exited (cleanly or not) without writing a terminal
      # state. That's either rc != 0 (an unhandled set -e failure)
      # OR rc == 0 with a step missing its terminal write — both
      # are bugs we need to flag rather than leave the UI spinning
      # forever on the last "restarting" / "updating" state.
      local step
      if [ "${CURRENT_STEP:-0}" -gt 0 ]; then step="$CURRENT_STEP"; else step=1; fi
      write_status "failed" "$step" "Something went wrong" "Your site is still online on the previous version. Try again in a moment." ""
      # Best-effort terminal audit — `declare -F` guard in case the
      # exit fires before the helper functions are loaded.
      if declare -F post_audit_terminal >/dev/null 2>&1; then
        post_audit_terminal failed "unexpected_exit_rc${rc}"
      fi
      ;;
  esac
  # Toggle maintenance OFF only if WE turned it on. Step 5 sets
  # CAVECMS_MAINT_TOGGLED_BY_US=1 right before its
  # `post_maintenance_toggle true` call. A preflight failure that
  # exits in step 1 must NOT clobber an operator-set
  # security_maintenance.enabled=true (e.g. they planned a
  # maintenance window and the update happened to fail loud). Only
  # touch the flag when this orchestrator is the one that set it.
  if [ "${CAVECMS_MAINT_TOGGLED_BY_US:-0}" = "1" ] \
    && declare -F post_maintenance_toggle >/dev/null 2>&1; then
    post_maintenance_toggle false
  fi
  rm -f "$LOCK_PATH" 2>/dev/null || true
}
on_signal() {
  set +e
  local sig="$1"
  local current_state
  current_state=$(read_status_state)
  case "$current_state" in
    completed|failed|rolled_back) ;;  # already terminal, don't overwrite
    *)
      write_status "failed" "${CURRENT_STEP:-1}" "Your update was interrupted" "Your previous version is still running. You can try again." ""
      if declare -F post_audit_terminal >/dev/null 2>&1; then
        post_audit_terminal failed "interrupted_by_signal_${sig}"
      fi
      ;;
  esac
  # Floor: only toggle maintenance off if WE turned it on (step 5
  # sets CAVECMS_MAINT_TOGGLED_BY_US=1). Release the lock and clear
  # the EXIT trap so it doesn't double-fire after our explicit exit.
  if [ "${CAVECMS_MAINT_TOGGLED_BY_US:-0}" = "1" ] \
    && declare -F post_maintenance_toggle >/dev/null 2>&1; then
    post_maintenance_toggle false
  fi
  rm -f "$LOCK_PATH" 2>/dev/null || true
  trap - EXIT
  exit 130
}
CURRENT_STEP=0
trap on_exit EXIT
trap 'on_signal SIGTERM' TERM

# Stamp our PID into the lock file the apply route opened. The apply
# route's child.pid is the outer bash that exec'd the double-fork
# nohup — it exits within milliseconds. The actual orchestrator
# (this process) is the orphan grandchild, and lockIsStale() needs
# OUR pid to do the kill(pid, 0) liveness check. Best-effort: if
# the write fails (read-only filesystem, etc.) the stale check
# falls back to the status-mtime heuristic.
if [ -f "$LOCK_PATH" ]; then
  echo "$$" > "$LOCK_PATH" 2>/dev/null || true
fi
# Ignore SIGINT and SIGHUP. Step 5 (pm2 reload) sends SIGINT to the
# managed Node process; on some platforms (macOS especially) the
# signal leaks to the orchestrator via the shared controlling
# terminal or process group despite the apply route's
# `detached: true` setsid. SIGHUP fires when the parent Node process
# exits during the reload. Both signals are NORMAL for the in-app
# update flow and must NOT abort the orchestrator — only an explicit
# SIGTERM from systemd / pm2 stop / operator kill should.
trap '' INT HUP

# ---------------------------------------------------------------------------
# restart_app — restart the running app using the install's service manager.
#
# CAVECMS_RESTART_MODE is forwarded by the CLI (systemd|cpanel|pm2|laptop)
# from its surface detection. When UNSET (dashboard apply route + bare-metal
# deploy.sh) it defaults to pm2, preserving the historical behaviour exactly.
# Used by BOTH forward step 5 and rollback_to_previous so every surface that
# the installer supports can actually reload — previously the orchestrator
# only ever did `pm2 reload`, so systemd (vps) / Passenger (cpanel) installs
# swapped files on disk but never restarted the live process.
# ---------------------------------------------------------------------------
# Extract the "commit" field from a /healthz?verbose=1 JSON body. python3
# preferred; awk fallback (same idiom as read_status_state) so the commit-match
# verify guard still works on hosts without python3 (e.g. minimal containers /
# bare macOS) instead of silently degrading to a status:ok-only check.
healthz_commit() {
  local body="$1"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get("commit", "") if isinstance(d, dict) else "")
except Exception:
    print("")
' 2>/dev/null || true
  else
    printf '%s' "$body" | awk -F'"' '{for(i=1;i<=NF;i++) if($i=="commit"){print $(i+2); exit}}' 2>/dev/null || true
  fi
}

restart_app() {
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  local mode="${CAVECMS_RESTART_MODE:-pm2}"
  # Append stdin to the reload log BEST-EFFORT — an unwritable LOG_DIR
  # (cpanel / laptop where /var/log/cavecms isn't provisioned, or a
  # restore that wiped an in-repo log dir) must NEVER block the actual
  # restart command. The restart runs UPSTREAM of this pipe, so its
  # execution is independent of whether the log write succeeds.
  _restart_log() { cat >> "${LOG_DIR}/pm2-reload.log" 2>/dev/null || cat >/dev/null; }
  case "$mode" in
    systemd)
      local unit="${CAVECMS_SYSTEMD_UNIT:-cavecms.service}"
      if [ "$(id -u)" = "0" ]; then
        { echo "[cavecms-update] restarting via systemd unit ${unit}"; systemctl restart "$unit" 2>&1 || echo "[cavecms-update] systemctl restart exit non-zero — verifying via healthz"; } | _restart_log || true
      else
        { echo "[cavecms-update] restarting via systemd unit ${unit} (sudo)"; sudo -n systemctl restart "$unit" 2>&1 || echo "[cavecms-update] 'sudo -n systemctl restart ${unit}' failed (need root or a sudoers entry) — verifying via healthz"; } | _restart_log || true
      fi
      ;;
    cpanel)
      mkdir -p "$REPO_DIR/tmp" 2>/dev/null || true
      if touch "$REPO_DIR/tmp/restart.txt" 2>/dev/null; then
        echo "[cavecms-update] restarted via Passenger (tmp/restart.txt)" | _restart_log || true
      else
        echo "[cavecms-update] couldn't touch ${REPO_DIR}/tmp/restart.txt" | _restart_log || true
      fi
      ;;
    laptop)
      echo "[cavecms-update] laptop/dev surface — no managed service to reload; restart the foreground CaveCMS process to load the changes." | _restart_log || true
      ;;
    pm2|*)
      local target="${CAVECMS_PM2_APP_NAME:-ecosystem.config.cjs}"
      if [ -n "${CAVECMS_PM2_APP_NAME:-}" ]; then
        if ! timeout 10s pm2 describe "$target" >/dev/null 2>&1; then
          echo "[cavecms-update] pm2 reload pre-check: app \"$target\" not registered (or pm2 daemon wedged) under PM2_HOME=\"${PM2_HOME:-<unset>}\"." | _restart_log || true
        fi
      fi
      { (cd "$REPO_DIR" && pm2 reload "$target" --update-env 2>&1) || echo "[cavecms-update] pm2 reload CLI exit non-zero (likely SIGINT'd by reload signal — verifying via healthz)"; } | _restart_log || true
      ;;
  esac
}

# Rollback helper — defined BEFORE the steps that call it so bash has
# registered the function in its table by the time we hit a failure.
#
# Snapshot-based: works uniformly in git AND tarball mode. The pre-
# destructive snapshot taken at the top of step 2 is the source of
# truth — git's history is a secondary sanity check (best-effort).
#
# The rollback verifies its own success via /healthz after pm2 reload.
# If the rollback ITSELF fails, we surface a distinct hard-failure
# state so the operator knows their site may be offline.
rollback_to_previous() {
  local prev="$1"
  local had_migration="${2:-0}"
  local backup_dump="${3:-}"
  echo "[cavecms-update] rolling back to $prev (had_migration=$had_migration, backup=$backup_dump)" >&2

  # Empty $prev is a sign something went wrong upstream (git rev-parse
  # returned nothing, snapshot was never taken). Refuse explicitly.
  if [ -z "$prev" ]; then
    write_status "failed" "${CURRENT_STEP:-1}" \
      "We couldn't determine your previous version" \
      "Automatic rollback can't run without a known previous version. Re-run \`npx create-cavecms\` to reinstall, or contact support." \
      ""
    post_maintenance_toggle false
    return 1
  fi

  # Pre-flight: if we ran a migration but don't have a usable schema
  # backup (SKIPPED or empty), rolling back code only would leave
  # schema ahead of code — the old app would 500 on missing columns.
  if [ "$had_migration" = "1" ]; then
    if [ -z "$backup_dump" ] || [ "$backup_dump" = "SKIPPED" ] || [ ! -f "$backup_dump" ]; then
      write_status "failed" "${CURRENT_STEP:-1}" "Your data was updated but the rest of the install failed" "Your site is on the new database structure but the new code couldn't be installed. Contact support — we have logs to recover from." ""
      post_maintenance_toggle false
      return 1
    fi
  fi

  # Snapshot-based restore. Works for git AND tarball mode — the
  # snapshot dir was populated BEFORE any destructive step in step 2.
  # If the snapshot is missing (older orchestrator, manual disk
  # cleanup), refuse cleanly with operator-actionable copy.
  local snap_dir="${SNAPSHOT_ROOT}/${prev}"
  if [ ! -d "$snap_dir" ]; then
    write_status "failed" "${CURRENT_STEP:-1}" \
      "We couldn't find a snapshot of your previous version" \
      "Automatic rollback needs a snapshot, but we couldn't find one. Re-run \`npx create-cavecms\` with the previous version (--version=X.Y.Z) to recover, or contact support." \
      ""
    post_maintenance_toggle false
    return 1
  fi

  if ! restore_from_snapshot "$prev"; then
    write_status "failed" "${CURRENT_STEP:-1}" "We tried to restore your previous version but couldn't" "Your site may be offline — contact support immediately." ""
    return 1
  fi

  # Best-effort: keep git's HEAD aligned with the restored file tree
  # in git mode so future operations (manual git ops, the next update's
  # preflight cleanliness check) see a consistent view. Failure here
  # doesn't fail the rollback — the on-disk files are the truth.
  if git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$REPO_DIR" reset --hard "$prev" >/dev/null 2>&1 || true
  fi

  # Restore the schema if a migration ran.
  if [ "$had_migration" = "1" ]; then
    if ! restore_db_backup "$backup_dump"; then
      write_status "failed" "${CURRENT_STEP:-1}" "We restored your previous version's files but couldn't restore your database" "Your site may be in a half-restored state — contact support immediately." ""
      return 1
    fi
  fi

  # Reinstall node_modules — git mode only.
  #
  # In git mode, node_modules is excluded from the snapshot (pnpm's CAS
  # makes copying them risky); we re-run `pnpm install --frozen-lockfile`
  # against the restored pnpm-lock.yaml. Fast no-op when the previous
  # lockfile matches what pnpm already cached.
  #
  # In tarball / CLI mode, node_modules ships INSIDE `.next/standalone/`
  # — which the snapshot DOES include — so the restore already gave us
  # back the dependency tree. Most CLI install hosts don't even have
  # pnpm on PATH; running pnpm install here would hard-fail the rollback.
  #
  # Gate on git-presence, NOT just the tarball URL: the standalone
  # `cavecms rollback` path calls rollback_to_previous WITHOUT
  # CAVECMS_UPDATE_TARBALL_URL set, so keying off that var alone would run
  # pnpm on every CLI install (no .git, no pnpm) and break the very
  # recovery this function performs. A real git-mode install has a .git
  # work-tree; a CLI/tarball install does not.
  if [ -z "${CAVECMS_UPDATE_TARBALL_URL:-}" ] && git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! (cd "$REPO_DIR" && pnpm install --frozen-lockfile >/dev/null 2>>"${LOG_DIR}/rollback-install.log"); then
      write_status "failed" "${CURRENT_STEP:-1}" "We restored your previous version's files but couldn't reinstall its dependencies" "Your site may be offline — contact support immediately." ""
      return 1
    fi
  fi

  # pm2 reload --update-env (inside restart_app) injects THIS orchestrator
  # shell's environment into the restarted process — NOT env.production on
  # disk. The orchestrator inherited the PRE-rollback CAVECMS_COMMIT (the
  # version we're rolling back FROM), so without re-exporting the rolled-
  # back values here the restarted process keeps reporting the old-new
  # commit and the commit-match verify below falsely fails a rollback that
  # actually succeeded (files + db + env file all restored). Mirror the
  # forward path's step-5 env export: pin CAVECMS_COMMIT to the restored
  # commit and CAVECMS_RELEASE_TS to what the restored env file carries.
  case "$prev" in
    from-*) : ;;  # first-install handle: no real commit to pin
    *) export CAVECMS_COMMIT="${prev:0:12}" ;;
  esac
  if [ -f "$ENV_FILE" ]; then
    local _restored_ts
    _restored_ts=$(awk '/^CAVECMS_RELEASE_TS=/{sub(/^CAVECMS_RELEASE_TS=/,"");print;exit}' "$ENV_FILE" 2>/dev/null || true)
    [ -n "$_restored_ts" ] && export CAVECMS_RELEASE_TS="$_restored_ts"
  fi

  # Restart the app via the install's service manager (systemd / pm2 /
  # Passenger / none-on-laptop). Exit code not fatal — the healthz verify
  # below is the canonical success signal.
  restart_app

  # Verify rollback health before claiming success. When HEALTHZ_TOKEN is
  # set we ALSO require the running commit to match the restored version —
  # so a surface where the restart silently no-ops (a foreground laptop
  # process, a wedged daemon, a missing sudoers entry) can NOT be reported
  # as a successful rollback while the old code is still live. Mirrors the
  # forward path's step-6 commit guard. `prev` is the snapshot SHA we
  # restored to; a `from-N` first-install handle has no real commit to match.
  local target_commit=""
  case "$prev" in
    from-*) target_commit="" ;;
    *) target_commit="${prev:0:12}" ;;
  esac
  # Laptop/dev surface has no managed service — restart_app intentionally
  # no-ops, so the foreground process still serves the OLD commit. Don't
  # require a commit match (the FILES are restored); the operator restarts
  # the foreground process to load the rolled-back code.
  if [ "${CAVECMS_RESTART_MODE:-pm2}" = "laptop" ]; then target_commit=""; fi
  local healthz_args=()
  if [ -n "$HEALTHZ_TOKEN" ]; then
    healthz_args=(-H "Authorization: Bearer $HEALTHZ_TOKEN")
  fi
  local success=0
  local i
  for i in $(seq 1 15); do
    sleep 2
    if curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "$HEALTHZ_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      if [ -n "$HEALTHZ_TOKEN" ] && [ -n "$target_commit" ]; then
        local verbose_response running_commit
        verbose_response=$(curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "${HEALTHZ_URL}?verbose=1" 2>/dev/null || true)
        running_commit=$(healthz_commit "$verbose_response")
        # Only reject on a confirmed mismatch; an unreadable/empty commit
        # (basic healthz, parse miss) falls back to the status:ok signal.
        if [ -n "$running_commit" ] && [ "$running_commit" != "$target_commit" ]; then
          success=0
          continue
        fi
      fi
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
  # Format-aware verification — match extract_tarball_atomic's
  # ZIP/tar.gz branching so the safety checks run against the actual
  # archive format. ZIP releases (CLI installs) use `unzip -l`;
  # tar.gz releases (bare-metal deploy.sh) use `tar -tzf`.
  local magic
  magic=$(od -An -t x1 -N 4 "$tarball" 2>/dev/null | tr -d ' ' | head -c 8)
  case "$magic" in
    504b0304|504b0506|504b0708)
      # ZIP. `unzip -l` lists the entries. Path-traversal check matches
      # the tar pattern; symlinks in ZIP need a different probe — use
      # `unzip -Z` (zipinfo) which reports symlinks with "l" in column 1.
      if unzip -l "$tarball" 2>/dev/null | awk 'NR>3 && NF>=4 {for(i=4;i<=NF;i++) print $i}' | grep -qE '(^|/)\.\.(/|$)|^/'; then
        return 1
      fi
      if unzip -Z "$tarball" 2>/dev/null | grep -qE '^[lL]'; then
        return 2
      fi
      ;;
    *)
      # tar.gz. Original logic.
      if tar -tzf "$tarball" 2>/dev/null | grep -qE '(^|/)\.\.(/|$)|^/' ; then
        return 1
      fi
      if tar -tvzf "$tarball" 2>/dev/null | grep -qE '^[lh]' ; then
        return 2
      fi
      ;;
  esac
  return 0
}

extract_tarball_atomic() {
  local tarball="$1"
  local dest="$2"   # REPO_DIR
  local extract_tmp
  extract_tmp=$(mktemp -d "${TMPDIR:-/tmp}/cavecms-extract-XXXXXX")
  # Format detection by magic bytes — release artifacts are ZIP
  # (matching the CLI's `npx create-cavecms` install path which uses
  # `unzip`); bare-metal deploy.sh's GitHub release tarballs are
  # `.tar.gz`. Both shapes route through this same orchestrator step.
  # `od -An -t x1 -N 4` is the portable 4-byte sniff.
  local magic
  magic=$(od -An -t x1 -N 4 "$tarball" 2>/dev/null | tr -d ' ' | head -c 8)
  local extract_ok=0
  case "$magic" in
    504b0304|504b0506|504b0708)
      # ZIP magic — use unzip (-q quiet, -o overwrite).
      if unzip -q -o "$tarball" -d "$extract_tmp" 2>>"${LOG_DIR}/tarball-extract.log"; then
        extract_ok=1
      fi
      ;;
    *)
      # gzip magic (1f 8b ...) or anything else — try tar+gzip.
      if tar -xzf "$tarball" --no-same-permissions --no-same-owner -C "$extract_tmp" 2>>"${LOG_DIR}/tarball-extract.log"; then
        extract_ok=1
      fi
      ;;
  esac
  if [ "$extract_ok" != "1" ]; then
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
  # Verify essential files exist in the extracted tree. CLI release
  # zips ship a pre-built standalone bundle WITHOUT pnpm-lock.yaml
  # (it's a source-tree file; the released artifact carries vendored
  # node_modules inside .next/standalone/ instead). Only require
  # package.json + the standalone server.js so both git-based and
  # CLI-based release shapes pass.
  if [ ! -f "$release_dir/package.json" ] || [ ! -f "$release_dir/.next/standalone/server.js" ]; then
    rm -rf "$extract_tmp"
    return 3
  fi
  # The set of paths we move aside for atomic rollback. `.next` is
  # included so a tarball-mode install replaces (not overlays) the
  # built bundle — leaving the old `.next/standalone/` in place would
  # mix stale build chunks with the new server.js and crash at boot.
  # `pnpm-lock.yaml` stays on the list as a no-op for CLI installs
  # (`-e` skips silently) and a real move for git-mode installs.
  local backup_suffix=".tarball-old.$$"
  local move_aside_paths='app components lib public scripts db tests middleware.ts next.config.ts package.json pnpm-lock.yaml tsconfig.json .next'
  for d in $move_aside_paths; do
    if [ -e "$dest/$d" ]; then
      mv "$dest/$d" "$dest/$d$backup_suffix" 2>/dev/null || true
    fi
  done
  # Copy from the extracted release root.
  if ! cp -a "$release_dir"/. "$dest"/ ; then
    # Best-effort restore on copy failure.
    for d in $move_aside_paths; do
      if [ -e "$dest/$d$backup_suffix" ] && [ ! -e "$dest/$d" ]; then
        mv "$dest/$d$backup_suffix" "$dest/$d" 2>/dev/null || true
      fi
    done
    rm -rf "$extract_tmp"
    return 4
  fi
  # Success — clean up the .tarball-old.$$ backups and the extract dir.
  for d in $move_aside_paths; do
    rm -rf "$dest/$d$backup_suffix" 2>/dev/null || true
  done
  rm -rf "$extract_tmp"
  return 0
}

# ---------------------------------------------------------------------------
# DRY RUN — used by Playwright + manual demos. Walks states on a timer.
# Skipped for rollback mode, which has its own dry-run branch below — an
# explicit `rollback` request must never be reported as a successful UPDATE.
# ---------------------------------------------------------------------------
if [ "${CAVECMS_UPDATE_DRY_RUN:-}" = "1" ] && [ "${ROLLBACK_MODE:-0}" != "1" ]; then
  write_status "preflight" 1 "Getting ready" "" ""; sleep 1
  CURRENT_STEP=2; write_status "updating" 2 "Downloading the new version" "" ""; sleep 1
  CURRENT_STEP=3; write_status "updating" 3 "Preparing your data" "" ""; sleep 1
  CURRENT_STEP=4; write_status "updating" 4 "Building your site" "" ""; sleep 1
  # Dry-run also exercises the maintenance toggle so a Playwright walk
  # can assert the 503 page renders mid-update.
  post_maintenance_toggle true
  CURRENT_STEP=5; write_status "restarting" 5 "Restarting" "" ""; sleep 1
  CURRENT_STEP=6; write_status "completed" 6 "Update successful — you're on the new version" "" ""
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
# Standalone rollback — `cavecms-update.sh rollback`
#
# Restores the previous version from the most recent snapshot under
# SNAPSHOT_ROOT (taken before the last update). Driven by `cavecms
# rollback` for shell-only recovery when the dashboard is unreachable.
# Code-only restore (had_migration=0): the snapshot tree — including its
# env.production carrying the prior CAVECMS_COMMIT — is the source of
# truth, and CaveCMS's expand-only migration model keeps the newer
# schema backward-compatible with the restored (older) code.
# ---------------------------------------------------------------------------
if [ "$ROLLBACK_MODE" = "1" ]; then
  CURRENT_STEP=1
  # Dry-run rollback (CAVECMS_UPDATE_DRY_RUN=1): report a rolled_back
  # terminal state without touching the tree. The top-of-file DRY_RUN block
  # is skipped for rollback mode so this branch owns the dry-run path.
  if [ "${CAVECMS_UPDATE_DRY_RUN:-}" = "1" ]; then
    write_status "restarting" 1 "Restoring your previous version" "" ""; sleep 1
    write_status "rolled_back" 1 "We put your site back on the previous version" "" ""
    if declare -F post_audit_terminal >/dev/null 2>&1; then
      post_audit_terminal rolled_back "manual_cli_rollback_dryrun"
    fi
    trap - EXIT TERM
    rm -f "$LOCK_PATH" 2>/dev/null || true
    exit 0
  fi
  # Select the snapshot to restore TO: the most-recent one under
  # SNAPSHOT_ROOT, EXCLUDING the currently-running commit. The exclusion
  # matters because `update --force` re-installs the SAME version and
  # snapshots it — without skipping it, rollback would "restore" the
  # current version (a misleading no-op) and shadow the genuinely-previous
  # snapshot. CUR_SHA is matched as a prefix either way (snapshot dirs can
  # be full 40-char SHAs while CAVECMS_COMMIT is the 12-char form).
  ROLLBACK_PREV=""
  CUR_SHA="${CAVECMS_COMMIT:-}"
  if [ -d "$SNAPSHOT_ROOT" ]; then
    if command -v python3 >/dev/null 2>&1; then
      ROLLBACK_PREV=$(SNAP_ROOT="$SNAPSHOT_ROOT" CUR_SHA="$CUR_SHA" python3 -c '
import os
root = os.environ["SNAP_ROOT"]
cur = os.environ.get("CUR_SHA", "")
best = None
best_mtime = -1.0
try:
    for name in os.listdir(root):
        full = os.path.join(root, name)
        if not (os.path.isdir(full) and not os.path.islink(full)):
            continue
        if cur and (name.startswith(cur) or cur.startswith(name)):
            continue
        try:
            m = os.stat(full).st_mtime
        except OSError:
            continue
        if m > best_mtime:
            best_mtime = m
            best = name
except Exception:
    pass
print(best or "")
' 2>/dev/null || true)
    else
      # Portable fallback (host without python3): newest dir by mtime via
      # `ls -td`, skipping symlinks (parity with the python3 branch's
      # is_link guard) and the current commit's snapshot.
      for _d in $(ls -td "$SNAPSHOT_ROOT"/*/ 2>/dev/null); do
        _dn="${_d%/}"                       # strip trailing slash so -L tests the link, not its target
        [ -L "$_dn" ] && continue           # skip symlinked snapshots
        [ -d "$_dn" ] || continue
        _name=$(basename "$_dn")
        if [ -n "$CUR_SHA" ]; then
          case "$_name" in "$CUR_SHA"*) continue ;; esac
          case "$CUR_SHA" in "$_name"*) continue ;; esac
        fi
        ROLLBACK_PREV="$_name"
        break
      done
    fi
  fi
  if [ -z "$ROLLBACK_PREV" ]; then
    write_status "failed" 1 "No previous version to roll back to" "We couldn't find a saved snapshot of an earlier version. If your site is broken, reinstall a known-good release: npx create-cavecms@latest --version=X.Y.Z" ""
    if declare -F post_audit_terminal >/dev/null 2>&1; then
      post_audit_terminal failed "rollback_no_snapshot"
    fi
    trap - EXIT TERM
    rm -f "$LOCK_PATH" 2>/dev/null || true
    exit 1
  fi
  if ! is_safe_snapshot_sha "$ROLLBACK_PREV"; then
    write_status "failed" 1 "Couldn't roll back safely" "The most recent snapshot has an unexpected name and was rejected. Contact support." ""
    trap - EXIT TERM
    rm -f "$LOCK_PATH" 2>/dev/null || true
    exit 1
  fi
  TARGET_SHA="$ROLLBACK_PREV"
  echo "[cavecms-update] standalone rollback → ${ROLLBACK_PREV}"
  write_status "restarting" 1 "Restoring your previous version" "" ""
  CAVECMS_MAINT_TOGGLED_BY_US=1
  # Best-effort maintenance flip — must NOT gate the actual restore. Under
  # `set -e` a bare non-zero return (loopback HTTP down + direct-DB fallback
  # unavailable — common when the app is broken, which is WHY we're rolling
  # back) would abort before rollback_to_previous ever runs.
  post_maintenance_toggle true || true
  if rollback_to_previous "$ROLLBACK_PREV" 0 ""; then
    write_status "rolled_back" 1 "We put your site back on the previous version" "" ""
    post_maintenance_toggle false || true
    CAVECMS_MAINT_TOGGLED_BY_US=0
    if declare -F post_audit_terminal >/dev/null 2>&1; then
      post_audit_terminal rolled_back "manual_cli_rollback"
    fi
    trap - EXIT TERM
    rm -f "$LOCK_PATH" 2>/dev/null || true
    echo "[cavecms-update] rollback complete → ${ROLLBACK_PREV}"
    exit 0
  else
    # rollback_to_previous wrote its own failed status. Ensure
    # maintenance is cleared so the operator isn't stuck on a 503, then
    # record the terminal audit. Best-effort (|| true) so a failed toggle
    # can't abort before the lock cleanup + correct exit code below.
    post_maintenance_toggle false || true
    CAVECMS_MAINT_TOGGLED_BY_US=0
    if declare -F post_audit_terminal >/dev/null 2>&1; then
      post_audit_terminal failed "manual_cli_rollback_failed"
    fi
    trap - EXIT TERM
    rm -f "$LOCK_PATH" 2>/dev/null || true
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 1 — preflight
# ---------------------------------------------------------------------------
CURRENT_STEP=1
write_status "preflight" 1 "Getting ready" "" ""

# Stale `.tarball-old.*` cleanup. The orchestrator's tarball-mode
# atomic swap creates `<file>.tarball-old.<pid>` aside-files (line
# tracking the move-aside). On an orchestrator that died after the
# move-aside but before the post-success cleanup, those files
# accumulate. Newer apply runs have a different PID, so they'd be
# left behind forever. Clean any that's older than 24h on startup.
find "$REPO_DIR" -maxdepth 2 -name '.tarball-old.*' -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
find "$REPO_DIR" -maxdepth 2 -name '*.tarball-old.*' -mtime +1 -exec rm -rf {} + 2>/dev/null || true

# Disk: need >= 500 MB free on the partition holding the repo. `-kP`
# is POSIX-portable (vs BSD `df`'s long-name line-wrap, which can
# make NR==2 yield the wrong row).
free_kb=$(df -kP "$REPO_DIR" | awk 'NR==2 {print $4}')
if [ -z "${free_kb:-}" ] || [ "$free_kb" -lt 512000 ]; then
  write_status "failed" 1 "Not enough free disk space" "Your server needs at least 500 MB of free space to install an update." ""
  exit 1
fi

# Memory: need >= 512 MB available. The `pnpm build` in step 4 spins up
# Next 15's compiler + a child V8 process whose default
# --max-old-space-size lands around 512 MB; on a 1 GB droplet with no
# free memory the build OOMs partway and `set -e` aborts mid-flight,
# leaving the snapshot the only restore path. Refuse here so the
# operator can free memory before we touch anything.
#
# /proc/meminfo exists on every Linux. macOS dev boxes don't have it —
# skip the check there since dev never hits the in-app update path
# anyway (CAVECMS_UPDATE_DRY_RUN handles dev demos).
if [ -r /proc/meminfo ]; then
  mem_avail_kb=$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo)
  if [ -n "${mem_avail_kb:-}" ] && [ "$mem_avail_kb" -lt 524288 ]; then
    write_status "failed" 1 "Not enough free memory" "Your server needs at least 512 MB of free memory to build an update. Try closing other programs on this server and try again." ""
    exit 1
  fi
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

# MariaDB version gate. The drizzle migrations + JSON column-defaults
# the CMS relies on require MariaDB >= 10.6. On an older server, the
# migration would fail partway with a confusing syntax error, leaving
# the schema in an inconsistent state (we already snapshotted, but
# the operator's experience is "the update broke my database").
# Refuse here instead, BEFORE we touch anything. Mirrors the same
# gate in scripts/preflight.sh (line 355-421) for the deploy.sh path.
#
# Optional: skip the check when DATABASE_URL isn't parseable (dev
# without a real DB connection) or mysql client isn't installed.
# In production both are present per #0.045's bootstrap rules.
if command -v mysql >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  db_creds=$(DATABASE_URL="$DATABASE_URL" python3 -c '
import os
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["DATABASE_URL"])
print(u.hostname or "127.0.0.1")
print(u.port or 3306)
print(unquote(u.username or ""))
print(unquote(u.password or ""))
print((u.path or "/").lstrip("/").split("?")[0])
' 2>/dev/null || true)
  if [ -n "$db_creds" ]; then
    db_host=$(echo "$db_creds" | awk 'NR==1')
    db_port=$(echo "$db_creds" | awk 'NR==2')
    db_user=$(echo "$db_creds" | awk 'NR==3')
    db_pass=$(echo "$db_creds" | awk 'NR==4')
    cred_file=$(mktemp "${TMPDIR:-/tmp}/cavecms-mysqlver-cred.XXXXXX")
    chmod 0600 "$cred_file"
    printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' \
      "$db_host" "$db_port" "$db_user" "$db_pass" > "$cred_file"
    version_line=$(mysql --defaults-extra-file="$cred_file" -BNe "SELECT VERSION();" 2>/dev/null || true)
    is_mariadb=$(mysql --defaults-extra-file="$cred_file" -BNe "SELECT @@version_comment;" 2>/dev/null || true)
    rm -f "$cred_file"
    # MariaDB version strings ALWAYS contain "MariaDB" in the VERSION()
    # output (e.g. "10.6.22-MariaDB-0ubuntu0.22.04.1", "11.4.2-MariaDB",
    # "10.11.6-MariaDB-1:10.11.6+maria~ubu2204"). Pure MySQL builds
    # never have that suffix. `@@version_comment` is unreliable as the
    # MariaDB-vs-MySQL signal — distro packages overwrite it with the
    # OS string (e.g. "Ubuntu 22.04"), so a healthy MariaDB on
    # Ubuntu would fail this gate. Check the VERSION() string instead,
    # which the server can't customise the way distros customise the
    # comment. Extract major.minor from the same string.
    db_major=$(echo "$version_line" | awk -F. '{print $1}')
    db_minor=$(echo "$version_line" | awk -F. '{print $2}')
    case "$version_line" in
      *MariaDB*|*mariadb*) ;;  # OK — proceed to version check
      *)
        echo "[cavecms-update] version_line=$version_line version_comment=$is_mariadb" >> "${LOG_DIR}/preflight.log" 2>/dev/null || true
        write_status "failed" 1 "Database isn't MariaDB" "CaveCMS requires MariaDB. Pure MySQL isn't supported. Ask your hosting provider to switch the database to MariaDB 10.6 or newer." ""
        exit 1
        ;;
    esac
    if [ -n "$db_major" ] && [ -n "$db_minor" ]; then
      if [ "$db_major" -lt 10 ] || { [ "$db_major" -eq 10 ] && [ "$db_minor" -lt 6 ]; }; then
        # Don't leak the full MariaDB build string into operator-
        # visible copy (e.g. `10.4.34-MariaDB-1:10.4.34+maria~deb10`).
        # Surface major.minor only; full string lives in the log.
        echo "[cavecms-update] full MariaDB version: $version_line" >> "${LOG_DIR}/preflight.log" 2>/dev/null || true
        write_status "failed" 1 "Your database needs to be upgraded" "CaveCMS needs MariaDB 10.6 or newer. Yours is ${db_major}.${db_minor}. Ask your hosting provider to upgrade before installing this update." ""
        exit 1
      fi
    fi
  fi
fi

# Git working-tree cleanliness: refuse to clobber operator-edited files.
# SKIPPED ENTIRELY in tarball mode — CLI-installed instances (npx
# create-cavecms) have no .git directory by design (the zip is the
# source of truth, not a git checkout). The tarball extract handles
# its own integrity via sha256, and rollback in tarball mode is
# handled by keeping the previous release dir on disk.
cd "$REPO_DIR"
if [ -z "${CAVECMS_UPDATE_TARBALL_URL:-}" ]; then
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    write_status "failed" 1 "Your install directory isn't a git repository" "In-app updates need either a git-cloned install or the static-manifest tarball mode. Contact support if you're not sure how your site was set up." ""
    exit 1
  fi
  # `db/schema-fingerprint.txt` is a derived artifact rewritten by
  # `pnpm db:fingerprint` at the end of every db:migrate run — it's
  # expected to be dirty after any prior update and isn't an
  # operator-edit concern. Exclude it from the cleanliness check so
  # the preflight doesn't refuse on its own bookkeeping.
  DIRTY=$(git status --porcelain --untracked-files=no 2>/dev/null | grep -v 'db/schema-fingerprint\.txt' || true)
  if [ -n "$DIRTY" ]; then
    write_status "failed" 1 "Your server has unsaved changes" "Someone edited the site files directly on the server. Commit, stash, or discard those changes before updating." ""
    exit 1
  fi
  # Discard any stray fingerprint mod so step 2's `git reset --hard` is
  # a true no-op when target === HEAD (which it is when we're already
  # on the version being installed).
  git checkout -- db/schema-fingerprint.txt 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Step 2 — fetch
#
# Two modes:
#   - Git-fetch (default): pull origin, verify target SHA exists,
#     reset --hard. Closes the TOCTOU where origin/main could advance
#     between the check and apply APIs.
#   - Tarball (when CAVECMS_UPDATE_TARBALL_URL is set): wget the tarball
#     (wget, not curl — Cloudflare Bot Fight Mode 403s curl/node by TLS
#     fingerprint), SHA256 verify, path-traversal + symlink check, atomic extract.
#     Requires a git repo as well (rollback uses `git reset --hard` on
#     the file modifications the tarball made; operators using tarball
#     without git need their own rollback mechanism — out of scope here).
# ---------------------------------------------------------------------------
CURRENT_STEP=2
write_status "updating" 2 "Downloading the new version" "" ""

# Capture the PREVIOUS_SHA for rollback. Snapshot mode means this is
# the on-disk identity we'll restore from — fall back to a deterministic
# "from-<epoch>" handle when neither git nor a meaningful FROM_SHA is
# available (very first install). The snapshot dir is named after this
# handle, and rollback looks it up the same way.
if git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  PREVIOUS_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
fi
if [ -z "${PREVIOUS_SHA:-}" ]; then
  if [ -n "${FROM_SHA:-}" ] && [ "$FROM_SHA" != "unknown" ]; then
    PREVIOUS_SHA="$FROM_SHA"
  else
    # Last-resort handle so a brand-new tarball install still has a
    # snapshot key. Operator can still recover via re-running the CLI
    # if this rolls back to a "from-<epoch>" snapshot.
    PREVIOUS_SHA="from-$(date -u +%s)"
  fi
fi

# Defence in depth: validate PREVIOUS_SHA shape before using it as a
# path component. is_safe_snapshot_sha lives in helpers; it accepts
# 7-64 hex chars OR `from-<digits>`. A non-hex / path-traversal value
# (`../../etc`) would let snapshot_current_tree's `rm -rf "$snap_dir"`
# escape SNAPSHOT_ROOT. The apply route already validates current.sha
# is hex (so FROM_SHA shouldn't carry traversal), but we re-check here
# in case PREVIOUS_SHA was derived from something else.
if ! is_safe_snapshot_sha "$PREVIOUS_SHA"; then
  write_status "failed" 2 "Couldn't identify your current version" "Internal: snapshot key is not a valid SHA. Contact support." ""
  post_audit_terminal failed "previous_sha_invalid"
  exit 1
fi

# Snapshot the current tree BEFORE any destructive step. Both modes
# (tarball overlay + git reset) clobber files in-place; the snapshot
# is the only thing that gives us a reliable restore path on either.
# Failure to snapshot is fatal — refusing to proceed is safer than
# running a destructive op with no escape hatch.
if ! snapshot_current_tree "$PREVIOUS_SHA" > /dev/null; then
  write_status "failed" 2 "Couldn't take a safety snapshot of your current version" "Your site is unchanged. Free up disk space (we need a few hundred MB), or install rsync if it isn't already." ""
  post_audit_terminal failed "snapshot_failed"
  exit 1
fi

if [ -n "${CAVECMS_UPDATE_TARBALL_URL:-}" ]; then
  # ──────── Tarball mode ────────
  TARBALL_TMP="${LOG_DIR}/release-${TARGET_SHA:0:12}.tar.gz.tmp.$(rand_suffix)"
  # Download via wget, NOT curl: the release host sits behind Cloudflare Bot
  # Fight Mode (Free plan — can't be scoped via WAF rules), which fingerprints
  # curl + node-fetch by their TLS handshake and 403s them from datacenter IPs
  # regardless of User-Agent. Only wget's fingerprint + a browser UA clears the
  # challenge (verified from an AWS VPS: wget+UA → 200, curl → 403). The
  # X-CaveCMS-Client header (ignored by CF's bot check) keeps the request
  # identifiable in origin logs.
  CAVECMS_RELEASE_UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  if ! wget -nv --tries=3 --timeout=300 --user-agent="$CAVECMS_RELEASE_UA" --header="X-CaveCMS-Client: CaveCMS-Updater" -O "$TARBALL_TMP" "$CAVECMS_UPDATE_TARBALL_URL" 2>>"${LOG_DIR}/tarball-download.log"; then
    rm -f "$TARBALL_TMP"
    write_status "failed" 2 "Couldn't download the new version" "We tried to fetch the release archive but the download failed. Check your server's internet access." ""
    post_audit_terminal failed "tarball_download_failed"
    exit 1
  fi
  # Empty/zero-byte response — wget can exit 0 yet leave an unusable
  # zero-byte file. Refuse explicitly.
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
  # Ed25519 signature verification — defends against a release-host
  # compromise where the attacker controls BOTH downloadUrl and sha256.
  # sha256 alone is integrity, not authenticity; the signature binds
  # the zip bytes to the publisher's private key, which only exists on
  # ~/.cavecms-release-private.pem.
  #
  # Both CAVECMS_UPDATE_TARBALL_SIGNATURE and CAVECMS_RELEASE_PUBKEY_PEM
  # are forwarded by the apply route (app/api/admin/updates/apply/
  # route.ts) — the pubkey comes from lib/updates/releasePubkey.ts so
  # the attacker-controlled host CANNOT influence which key we trust.
  # node is guaranteed available (we're inside the CaveCMS install
  # whose Node process spawned this script).
  if [ -n "${CAVECMS_UPDATE_TARBALL_SIGNATURE:-}" ] \
     && [ -n "${CAVECMS_RELEASE_PUBKEY_PEM:-}" ]; then
    if ! node -e '
      const fs = require("node:fs");
      const { createPublicKey, verify } = require("node:crypto");
      try {
        // CAVECMS_RELEASE_PUBKEY_PEM may carry MORE THAN ONE trusted
        // Ed25519 key, concatenated (each self-delimited by its
        // BEGIN/END markers). The apply route forwards the full
        // trusted-key list (lib/updates/releasePubkey.ts) so a future
        // key rotation can be verified by installs that trust both the
        // old and new key. Today it holds exactly one key. We try each
        // and pass if ANY verifies.
        const blob = process.env.CAVECMS_RELEASE_PUBKEY_PEM || "";
        const pems = blob.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) || [];
        if (pems.length === 0) {
          console.error("no trusted pubkey provided");
          process.exit(2);
        }
        const sig = Buffer.from(process.env.CAVECMS_UPDATE_TARBALL_SIGNATURE, "base64");
        const payload = fs.readFileSync(process.argv[1]);
        let ok = false;
        for (const pem of pems) {
          try {
            const pubkey = createPublicKey({ key: pem, format: "pem" });
            if (pubkey.asymmetricKeyType !== "ed25519") continue;
            if (verify(null, payload, pubkey, sig)) { ok = true; break; }
          } catch (e) { /* malformed key — try the next */ }
        }
        if (!ok) {
          console.error("ed25519 verify returned false for all trusted keys");
          process.exit(1);
        }
        process.exit(0);
      } catch (err) {
        console.error("ed25519 verify threw:", err && err.message ? err.message : String(err));
        process.exit(3);
      }
    ' "$TARBALL_TMP"; then
      rm -f "$TARBALL_TMP"
      write_status "failed" 2 "Couldn't verify the new version's signature" "The release archive is not signed by the expected publisher. Refusing to install. Contact support — this could indicate a tampered download." ""
      post_audit_terminal failed "tarball_signature_invalid"
      exit 1
    fi
  else
    # Both fields are required. Apply route's Zod schema rejects
    # missing signature, and we forward the pubkey from server code,
    # so reaching this branch means a misconfigured apply path or a
    # manually-invoked script with the env vars cleared.
    rm -f "$TARBALL_TMP"
    write_status "failed" 2 "Couldn't verify the new version's signature" "The release signature or trust anchor is missing. Re-run the update from the dashboard, or contact support." ""
    post_audit_terminal failed "tarball_signature_missing"
    exit 1
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
    # extract_tarball_atomic's mode-4 path (copy failed partway) can
    # leave a half-populated tree on disk. Its own in-function
    # restore only puts back the explicit allowlist of tracked dirs
    # it moved aside — any new file the tarball partially wrote in
    # (new admin routes, new migration files) remains. Use the
    # pre-destructive snapshot to restore deterministically.
    write_status "failed" 2 "Couldn't install the new version" "Your previous version is being restored. ($reason)" ""
    if rollback_to_previous "$PREVIOUS_SHA" 0 ""; then
      post_audit_terminal rolled_back "tarball_extract_${rc}"
    else
      post_audit_terminal failed "rollback_refused:tarball_extract_${rc}"
    fi
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
# Flip maintenance mode ON before Step 3 — destructive migrations
# (UPDATEs that rewrite content_blocks.data, DELETEs of orphan rows,
# etc.) must NOT run against live traffic. The toggle was previously
# inside Step 5, AFTER the migration had already mutated data while
# customers were hitting the app — a partial-write window we cannot
# audit. Now: maintenance ON → step 3 (migration + install) → step 4
# (build) → step 5 (pm2 reload) → step 6 (healthz verify) → toggle
# OFF. The CAVECMS_MAINT_TOGGLED_BY_US sentinel preserves the EXIT/
# SIGTERM trap behaviour (only flip back OFF if WE turned it on).
export CAVECMS_MAINT_TOGGLED_BY_US=1
post_maintenance_toggle true

# ---------------------------------------------------------------------------
# Step 3 — install + migrate (with pre-migration DB backup)
#
# Two flows, branched on whether we came from a tarball (CLI install)
# or a git fetch (bare-metal deploy.sh path):
#
#   - CLI / tarball: the release zip ships a pre-built standalone bundle
#     with vendored node_modules INSIDE `.next/standalone/`. No `pnpm`
#     install needed — and on most CLI installs, no `pnpm` binary is
#     even on the host. Migrations run via the same `install-migrate.mjs`
#     the CLI uses at fresh-install time (mysql2-based, journal-walking,
#     no Drizzle CLI dependency).
#
#   - Git fetch / bare-metal: the repo IS the source tree. `pnpm install
#     --frozen-lockfile` rebuilds node_modules from pnpm-lock.yaml,
#     `pnpm db:migrate` runs the Drizzle CLI.
#
# Detection: presence of CAVECMS_UPDATE_TARBALL_URL — the apply route
# sets it when shipping a release zip; the git-fetch path leaves it
# unset.
# ---------------------------------------------------------------------------
CURRENT_STEP=3
write_status "updating" 3 "Preparing your data" "" ""

if [ -z "${CAVECMS_UPDATE_TARBALL_URL:-}" ]; then
  # ──────── Git-fetch / bare-metal mode ────────
  if ! pnpm install --frozen-lockfile 2>&1 | tail -n 16 > "${LOG_DIR}/pnpm-install.log"; then
    write_status "failed" 3 "Couldn't prepare the new version" "Something went wrong while setting up. Your previous version is being restored." ""
    if rollback_to_previous "$PREVIOUS_SHA" 0 ""; then
      post_audit_terminal rolled_back "pnpm_install_failed"
    else
      post_audit_terminal failed "rollback_refused:pnpm_install_failed"
    fi
    exit 1
  fi
fi
# In tarball mode there's nothing to install — node_modules came with
# the tarball. Fall through to the shared db-backup + migrate block
# below, which itself branches between `pnpm db:migrate` (git mode) and
# `node scripts/install-migrate.mjs` (tarball mode).

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

# Expand/contract migration guard — mirrors scripts/preflight.sh's
# destructive-migration check. If any NEW migration file (added
# between PREVIOUS_SHA and TARGET_FULL) contains DROP / RENAME COLUMN /
# TRUNCATE / MODIFY VARCHAR / ALTER COLUMN DROP patterns, refuse
# unless CAVECMS_ALLOW_CONTRACT=1 is explicitly set. The default
# expand-only deployment model can't safely auto-rollback a
# destructive migration (the post-rollback code would 500 on the
# narrowed/dropped column with no restorable state).
if [ "$PREVIOUS_SHA" != "$TARGET_FULL" ] && [ -d "$REPO_DIR/db/migrations" ]; then
  destructive_patterns='DROP COLUMN|DROP TABLE|DROP DATABASE|DROP TRIGGER|DROP PROCEDURE|DROP FUNCTION|DROP VIEW|DROP EVENT|DROP USER|DROP PARTITION|DROP FOREIGN KEY|DROP PRIMARY KEY|DROP CONSTRAINT|TRUNCATE TABLE|RENAME COLUMN|CHANGE COLUMN|ALTER COLUMN DROP|MODIFY[[:space:]]+[a-zA-Z_]+[[:space:]]+VARCHAR'
  # Files added in TARGET_FULL that weren't in PREVIOUS_SHA. `--diff-filter=A`
  # selects added files only. Quietly skip if the diff fails (shallow
  # clone, etc.) — guard is best-effort.
  new_migrations=$(git -C "$REPO_DIR" diff --name-only --diff-filter=A "$PREVIOUS_SHA" "$TARGET_FULL" -- 'db/migrations/*.sql' 2>/dev/null || true)
  if [ -n "$new_migrations" ]; then
    destructive_hits=$(echo "$new_migrations" | while read -r m; do
      [ -f "$REPO_DIR/$m" ] && grep -EHl "$destructive_patterns" "$REPO_DIR/$m" 2>/dev/null
    done | head -3)
    if [ -n "$destructive_hits" ] && [ "${CAVECMS_ALLOW_CONTRACT:-0}" != "1" ]; then
      write_status "failed" 3 "This update changes your database in ways that can't be undone" "One or more migrations would drop, rename, or narrow columns. Auto-rollback can't reverse this safely. Set CAVECMS_ALLOW_CONTRACT=1 in your install's environment to acknowledge the data-loss risk and try again." ""
      post_audit_terminal failed "destructive_migration_refused"
      exit 1
    fi
  fi
fi

# db-migrate-with-lock refuses NODE_ENV=production without an explicit
# opt-in — the gate exists to stop someone running `pnpm db:migrate`
# by hand on the prod box. The in-app update flow IS a legitimate
# operator-initiated prod migration: an admin clicked Update Now,
# the apply route audit-logged it, the orchestrator took a fresh
# mysqldump in the step above. Pass CAVECMS_MIGRATE_OK=1 to clear
# the gate.
# Migration command branches the same way as the install above. In
# tarball mode (CLI install) the host has no pnpm + no Drizzle CLI;
# we run the bundled `scripts/install-migrate.mjs` (mysql2 + journal-
# walking, identical state-tracking to `pnpm db:migrate`). In git mode
# we keep the legacy Drizzle CLI path. CAVECMS_MIGRATE_OK clears the
# db-migrate-with-lock production-safety gate (operator-initiated, the
# apply route audit-logged the click already).
migrate_ok=1
if [ -n "${CAVECMS_UPDATE_TARBALL_URL:-}" ]; then
  if ! node --env-file="${ENV_FILE}" "${REPO_DIR}/scripts/install-migrate.mjs" 2>&1 | tail -n 32 > "${LOG_DIR}/install-migrate.log"; then
    migrate_ok=0
  fi
else
  if ! CAVECMS_MIGRATE_OK=1 pnpm db:migrate 2>&1 | tail -n 16 > "${LOG_DIR}/db-migrate.log"; then
    migrate_ok=0
  fi
fi
if [ "$migrate_ok" = "0" ]; then
  write_status "failed" 3 "Couldn't update your data" "Your previous version is being restored. No data was lost." ""
  if rollback_to_previous "$PREVIOUS_SHA" 0 "$BACKUP_DUMP"; then
    post_audit_terminal rolled_back "db_migrate_failed"
  else
    post_audit_terminal failed "rollback_refused:db_migrate_failed"
  fi
  exit 1
fi
HAD_MIGRATION=1

# ---------------------------------------------------------------------------
# Step 4 — build
#
# Two flows, branched on tarball vs git mode (same detection as step 3).
#
#   - Tarball / CLI mode: the release zip ALREADY contains a built
#     `.next/standalone/` tree — we extracted it intact in step 2.
#     There's nothing to build. Skip the pnpm build entirely; just
#     re-link the standalone bundle's static + public symlinks (the
#     tarball flattens these so we need to point them back at the
#     repo-level dirs).
#
#   - Git fetch / bare-metal mode: run `pnpm build` to produce a fresh
#     `.next/standalone/` from the new source. Force mode wipes `.next/`
#     first so an operator's "Re-run install" recovers from a corrupt
#     build cache.
# ---------------------------------------------------------------------------
CURRENT_STEP=4
write_status "updating" 4 "Building your site" "" ""

if [ -z "${CAVECMS_UPDATE_TARBALL_URL:-}" ]; then
  # ──────── Git-fetch mode: run pnpm build ────────
  if [ "$FORCE" = "1" ]; then
    rm -rf "$REPO_DIR/.next" 2>>"${LOG_DIR}/force-clean.log" || true
  fi
  # Three prebuild/postbuild gates need clearing for the in-app
  # update path:
  #   - dev-bootstrap.mjs port-check: CAVECMS_SKIP_PORT_CHECK=1 (pm2 IS
  #     on 3040 during the update — that's the whole point)
  #   - verify-route-collisions.ts (prebuild): CAVECMS_BUILD_OK=1
  #   - postbuild-check-slug-collisions.ts (postbuild): CAVECMS_BUILD_OK=1
  #
  # NODE_ENV stays at production. Overriding to development causes
  # Next.js's prerender step to import legacy pages-router `<Html>` and
  # the build fails on the /404 export with
  # "<Html> should not be imported outside of pages/_document".
  # CAVECMS_BUILD_OK is the same opt-in pattern as CAVECMS_MIGRATE_OK
  # for db-migrate-with-lock.
  if ! CAVECMS_SKIP_PORT_CHECK=1 CAVECMS_BUILD_OK=1 pnpm build 2>&1 | tail -n 16 > "${LOG_DIR}/build.log"; then
    write_status "failed" 4 "Couldn't build your site" "Your previous version is being restored." ""
    if rollback_to_previous "$PREVIOUS_SHA" "$HAD_MIGRATION" "$BACKUP_DUMP"; then
      post_audit_terminal rolled_back "build_failed"
    else
      post_audit_terminal failed "rollback_refused:build_failed"
    fi
    exit 1
  fi
fi
# In tarball mode the .next/standalone tree is already built — fall
# through to the standalone-static + public re-link below, which is
# needed in both modes.

# Re-link the standalone bundle's static assets. Next.js's
# `output: 'standalone'` mode emits a minimal server.js but does NOT
# copy `public/` or `.next/static/` into the standalone directory —
# they're expected to be supplied alongside (per Next docs:
# https://nextjs.org/docs/app/api-reference/config/next-config-js/output#automatically-copying-traced-files).
# scripts/deploy.sh's tarball path handles this by rsync; in the
# in-app updater's git path we re-create the two symlinks pm2
# serves from. Without them, every page is missing CSS + every icon
# returns 404 after the next reload.
ln -sfn "$REPO_DIR/public" "$REPO_DIR/.next/standalone/public" 2>>"${LOG_DIR}/build.log" || true
ln -sfn "$REPO_DIR/.next/static" "$REPO_DIR/.next/standalone/.next/static" 2>>"${LOG_DIR}/build.log" || true

# ---------------------------------------------------------------------------
# Step 5 — restart
# ---------------------------------------------------------------------------
CURRENT_STEP=5
write_status "restarting" 5 "Switching to the new version" "" ""

# Maintenance mode is already ON — flipped before Step 3 (see the
# block above Step 3). Customers have been seeing the branded 503
# throughout install + migrate + build; the pm2 reload below is the
# last operation before Step 6's healthz verify (success → toggle
# OFF) or the EXIT/SIGTERM trap (failure → also toggle OFF, since
# CAVECMS_MAINT_TOGGLED_BY_US sentinel marks the toggle as ours).

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

# Don't trust pm2 CLI's exit code. The pm2 CLI process is a child of
# the bash orchestrator and inherits the bash process group; when the
# OLD Node process receives SIGINT during reload, the kernel can
# deliver SIGINT to the whole group, killing the pm2 CLI mid-wait
# even though the pm2 daemon completes the reload successfully (new
# PID alive, healthz green). Bash's `trap '' INT` does NOT propagate
# to fork-exec'd children, so we can't shield pm2 CLI from the
# signal that way.
#
# Instead: capture the CLI's exit code but don't bail on it. Step 6's
# healthz poll is the canonical "did the reload work" signal — if the
# new process is healthy, the reload worked regardless of what pm2 CLI
# reported. If healthz fails step 6 will trigger rollback.
# Restart the app via the install's service manager (systemd / pm2 /
# Passenger / none-on-laptop). Truncate the reload log once so each apply
# run starts clean (restart_app appends its surface-specific diagnostics).
# Previously this was a hardcoded `pm2 reload`, which silently no-op'd on
# the systemd (vps) + Passenger (cpanel) surfaces; restart_app branches on
# CAVECMS_RESTART_MODE (forwarded by the CLI; unset → pm2 for the dashboard
# + bare-metal paths, unchanged).
mkdir -p "$LOG_DIR" 2>/dev/null || true
: > "${LOG_DIR}/pm2-reload.log" 2>/dev/null || true
restart_app

# ---------------------------------------------------------------------------
# Step 6 — verify
#
# Budget: 60 retries × 2s = 120s. Production Next 15 standalone reloads
# on small instances can take 60-90s for the first /healthz to return
# 200 (Next route compilation + DB pool warm-up). 30 retries was too
# tight per ops review.
# ---------------------------------------------------------------------------
CURRENT_STEP=6

# Laptop/dev surface has no managed service to reload — restart_app
# intentionally no-op'd, so the still-running foreground process serves the
# OLD commit and the commit-match verify below would never pass, falsely
# auto-rolling-back a build that installed fine. The files ARE in place; the
# operator restarts the foreground process to load them. Report success with
# that guidance instead of a misleading "didn't come up healthy" rollback.
if [ "${CAVECMS_RESTART_MODE:-pm2}" = "laptop" ]; then
  write_status "completed" 6 "Update installed — restart your CaveCMS process to load the new version" "" ""
  post_maintenance_toggle false
  if declare -F post_audit_terminal >/dev/null 2>&1; then
    post_audit_terminal completed "laptop_manual_restart_required"
  fi
  prune_old_snapshots || true
  trap - EXIT
  rm -f "$LOCK_PATH" 2>/dev/null || true
  echo "[cavecms-update] laptop update complete (manual restart required) → ${TARGET_FULL:0:12}"
  exit 0
fi

write_status "restarting" 6 "Verifying the new version" "" ""

# Defensive: disable set -e for the verify loop. The loop's curl can
# SIGPIPE when the pm2 reload is mid-flight (stdio fds to the
# parent's spawn log get re-pointed); under `set -eo pipefail` any
# SIGPIPE in a pipeline would terminate the script silently. The
# explicit if/grep handling here is the source of truth — set +e
# just stops the silent kill.
#
# Heartbeat write_status EVERY iteration. Without this the modal
# sees state=restarting / step=6 for the full 120s of the loop with
# NO progress signal — the user reads it as "stuck" even when the
# loop is making real progress. The stepLabel carries the
# iteration count + healthy-check count so the modal renders
# meaningful sub-text ("Verifying the new version — 1 of 3 healthy
# checks · attempt 17/60").
set +e
success=0
healthz_log="${LOG_DIR}/verify-loop.log"
echo "[verify] starting at $(now_iso) healthz=$HEALTHZ_URL target=${TARGET_FULL:0:12}" > "$healthz_log"
for i in $(seq 1 60); do
  sleep 2
  response=$(curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "$HEALTHZ_URL" 2>>"$healthz_log")
  rc=$?
  if [ $rc -eq 0 ] && echo "$response" | grep -q '"status":"ok"'; then
    # Commit-verification guard: when HEALTHZ_TOKEN is set the verbose
    # healthz response includes the running process's CAVECMS_COMMIT.
    # Confirm the new process is actually serving the target SHA — if
    # pm2 reload silently no-op'd (manifest unchanged) or the new env
    # didn't propagate, healthz still returns 200 from the OLD process
    # and step 6 would otherwise falsely declare success. Skip the
    # check when HEALTHZ_TOKEN is empty (the basic /healthz response
    # doesn't include `commit`, and we can't refuse on unauth data).
    if [ -n "$HEALTHZ_TOKEN" ]; then
      verbose_response=$(curl -fsS --max-time 5 ${healthz_args[@]+"${healthz_args[@]}"} "${HEALTHZ_URL}?verbose=1" 2>>"$healthz_log" || true)
      running_commit=$(echo "$verbose_response" | python3 -c '
import json,sys
try:
  d=json.loads(sys.stdin.read())
  print(d.get("commit","") if isinstance(d, dict) else "")
except Exception:
  print("")
' 2>/dev/null || true)
      if [ -n "$running_commit" ] && [ "$running_commit" != "${TARGET_FULL:0:12}" ]; then
        echo "[verify] iter=$i healthz=ok but commit=$running_commit != target=${TARGET_FULL:0:12} — refusing" >> "$healthz_log"
        success=0
        write_status "restarting" 6 "Verifying the new version (attempt ${i}/60 — running commit doesn't match yet)" "" ""
        continue
      fi
    fi
    success=$((success + 1))
    echo "[verify] iter=$i rc=0 ok success=$success" >> "$healthz_log"
    write_status "restarting" 6 "Verifying the new version — ${success}/3 healthy checks (attempt ${i}/60)" "" ""
    if [ $success -ge 3 ]; then
      break
    fi
  else
    echo "[verify] iter=$i rc=$rc body=${response:0:80}" >> "$healthz_log"
    success=0
    write_status "restarting" 6 "Verifying the new version (attempt ${i}/60)" "" ""
  fi
done
set -e

if [ $success -lt 3 ]; then
  write_status "rolled_back" 6 "We put your site back the way it was" "The new version didn't come up healthy, so we restored your previous version automatically." ""
  if rollback_to_previous "$PREVIOUS_SHA" "$HAD_MIGRATION" "$BACKUP_DUMP"; then
    post_maintenance_toggle false
    post_audit_terminal rolled_back "healthz_unhealthy_after_reload"
  else
    # Rollback refused (tarball mode) — leave the "failed" status that
    # rollback_to_previous wrote, and emit a matching audit row.
    post_audit_terminal failed "rollback_refused:healthz_unhealthy_after_reload"
  fi
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

# Compute watchdog window — the new version is presumed healthy now,
# but delayed crashes (memory leak triggered at the 4-min mark, a
# never-imported route compiling on first hit, etc.) can still take
# the site down without an immediate "build/restart broke it" signal.
# The watchdog will poll /healthz every 30s for 1 hour; on 3
# consecutive failures it acquires the update lock, restores from the
# pre-update snapshot, and writes a rolled_back terminal audit. The
# status file carries `watchdogUntil` so the UI can show the operator
# "we'll keep an eye on your site for the next hour".
WATCHDOG_DURATION_S=3600
# python3 ISO computation — `date -d "+N seconds"` (GNU) and
# `date -v "+NS"` (BSD) differ across hosts. Falling back to a busybox
# date silently yields empty string, blanking the UI banner. python3
# is already a hard dep for this script so it's the canonical path.
WATCHDOG_UNTIL=$(WATCHDOG_DURATION_S="$WATCHDOG_DURATION_S" python3 -c '
import os
from datetime import datetime, timezone, timedelta
delta = timedelta(seconds=int(os.environ["WATCHDOG_DURATION_S"]))
print((datetime.now(timezone.utc) + delta).strftime("%Y-%m-%dT%H:%M:%SZ"))
' 2>/dev/null || echo "")
export CAVECMS_STATUS_WATCHDOG_UNTIL="$WATCHDOG_UNTIL"

write_status "completed" 6 "Update successful — you're on the new version" "" ""
post_audit_terminal completed

# Prune old snapshots — keep the most recent N (default 3), drop the
# rest. Done AFTER terminal audit + status write so a prune failure
# can't mask the successful update.
prune_old_snapshots || true

# Spawn the post-completion watchdog (gap D close). Detached so it
# survives this orchestrator's exit AND the next pm2 reload. Failure
# to spawn is non-fatal — the update itself is already complete; the
# watchdog is a belt-and-suspenders guard against delayed crashes.
WATCHDOG_SCRIPT="$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")/cavecms-watchdog.sh"
if [ -f "$WATCHDOG_SCRIPT" ]; then
  # Pass identifying state through env so the watchdog can write the
  # same shape of status/audit rows the orchestrator did. STARTED_AT
  # is rewritten to "now" so the watchdog's durationMs calculation
  # measures its own runtime, not the original update's.
  export CAVECMS_WATCHDOG_FROM_SHA="$FROM_SHA"
  export CAVECMS_WATCHDOG_TO_SHA="$TARGET_SHA"
  export CAVECMS_WATCHDOG_PREVIOUS_SHA="$PREVIOUS_SHA"
  export CAVECMS_WATCHDOG_DURATION_S="$WATCHDOG_DURATION_S"
  export CAVECMS_WATCHDOG_HAD_MIGRATION="${HAD_MIGRATION:-0}"
  export CAVECMS_WATCHDOG_BACKUP_DUMP="${BACKUP_DUMP:-}"

  # Kick-off token — defence against a low-priv shell spawning the
  # watchdog script with attacker-controlled env (e.g. malicious
  # BACKUP_DUMP pointing at a planted SQL dump that would execute
  # via mysql on restore). We write a one-shot token file owned by
  # THIS process's uid + gid with mode 0600, hand the path + value
  # to the watchdog via env, and the watchdog verifies the token
  # contents + file ownership before doing any destructive op. A
  # malicious actor who can't read this orchestrator's process env
  # AND can't read the token file can't forge a watchdog kick-off.
  KICKOFF_TOKEN=""
  if command -v python3 >/dev/null 2>&1; then
    KICKOFF_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))' 2>/dev/null || echo "")
  fi
  if [ -z "$KICKOFF_TOKEN" ] && [ -r /dev/urandom ]; then
    KICKOFF_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n' 2>/dev/null || echo "")
  fi
  if [ -n "$KICKOFF_TOKEN" ]; then
    KICKOFF_TOKEN_FILE="$(dirname "$STATUS_PATH")/.watchdog-kickoff.token"
    # Write the token at mode 0600 BEFORE spawning. `set -C` (noclobber)
    # makes the redirect O_EXCL on bash 4.2+ Linux so an attacker
    # who pre-creates the path as a symlink to `/etc/cron.d/x` can't
    # redirect our write. rm + create pattern is also safe (we own
    # the parent dir) but the noclobber path is one fewer syscall
    # window for races.
    rm -f "$KICKOFF_TOKEN_FILE" 2>/dev/null || true
    ( set -C; umask 0177; printf '%s' "$KICKOFF_TOKEN" > "$KICKOFF_TOKEN_FILE" ) 2>/dev/null
    export CAVECMS_KICKOFF_TOKEN="$KICKOFF_TOKEN"
    export CAVECMS_KICKOFF_TOKEN_FILE="$KICKOFF_TOKEN_FILE"
  else
    echo "[cavecms-update] no kickoff token (python3 + /dev/urandom both unavailable); watchdog will refuse to start" >&2
    echo "[cavecms-update] $(now_iso) no kickoff token generated; watchdog will refuse" >> "${LOG_DIR}/watchdog-spawn.log"
  fi

  spawn_detached "$WATCHDOG_SCRIPT" || \
    echo "[cavecms-update] watchdog spawn failed (non-fatal)" >&2
else
  echo "[cavecms-update] watchdog script not found at $WATCHDOG_SCRIPT (skipping)" >&2
fi

exit 0
