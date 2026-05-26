#!/usr/bin/env bash
# scripts/install-systemd.sh — installs every cavecms-*.service /
# cavecms-*.timer under /etc/systemd/system, reloads the systemd daemon,
# and enables the timer units for boot-persistence. Called by
# setup.sh on first provision; safe to re-run when units are edited.
#
# Timers are both `enable`d (boot-persistence) AND `start`ed
# (immediate activation) — see the per-timer loop body for the
# rationale on each call. The `start` is idempotent on already-
# active timers, and each timer's underlying service has an
# ExecCondition= check on `/opt/cavecms/current/scripts/<script>.sh`
# existing — before the first deploy.sh run, ExecCondition fails
# and the service exits 0 (a "skipped" run is not a failure). This
# lets us activate timers immediately without spamming OnFailure
# alerts until the release artifact lands.

set -euo pipefail
IFS=$'\n\t'
# shellcheck disable=SC2154  # rc + BASH_COMMAND assigned inside the trap string.
trap 'rc=$?; echo "[install-systemd.sh] FAIL (rc=$rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -d -o root -g root -m 755 /etc/systemd/system

# Copy every unit + timer file from the bundled systemd/ directory.
for f in "$HERE/systemd"/*.service "$HERE/systemd"/*.timer; do
  [ -f "$f" ] || continue
  install -m 644 "$f" "/etc/systemd/system/$(basename "$f")"
done

systemctl daemon-reload

# `enable` installs the boot-time symlink so the timer survives reboots.
# `start` (further down in this loop) activates the timer immediately
# so we don't have to wait for a reboot or for deploy.sh's first-deploy
# `systemctl start 'cavecms-*.timer'` to fire. Both calls are idempotent.
for t in \
  cavecms-db-backup \
  cavecms-uploads-backup \
  cavecms-restore-drill \
  cavecms-cron-purge \
  cavecms-cron-crm-retry \
  cavecms-disk-check \
  cavecms-media-verify \
  cavecms-static-prune \
  cavecms-updates-check \
; do
  systemctl enable "${t}.timer"
  # try-restart applies any OnCalendar edits from this re-run to a
  # timer that's already active. No-op when the timer is inactive.
  systemctl try-restart "${t}.timer" 2>/dev/null || true
  # `start` activates a never-started timer (e.g., a new timer added
  # in a cluster-3 upgrade to a post-first-deploy box where deploy.sh's
  # initial `systemctl start 'cavecms-*.timer'` already fired without
  # picking up the new unit name). No-op when the timer is already
  # active. ExecCondition on the underlying service still gates
  # pre-first-deploy ticks so this won't spam OnFailure alerts.
  systemctl start "${t}.timer" 2>/dev/null || true
done

echo "[install-systemd.sh] OK — timers installed, enabled, and started (ExecCondition gates ticks until first deploy.sh lands the release artifact)."
