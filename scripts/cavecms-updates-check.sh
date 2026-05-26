#!/usr/bin/env bash
# scripts/cavecms-updates-check.sh — systemd-timer-invoked update probe.
#
# Fires every 12 hours (see scripts/systemd/cavecms-updates-check.timer).
# POSTs to the loopback /api/internal/updates/trigger-check endpoint,
# which runs the same `lib/updates/backgroundScheduler.runUpdateCheck()`
# code path as the in-process setInterval scheduler in
# instrumentation.ts. Two layers of redundancy on purpose:
#
#   - In-process setInterval: covers long-running admin tabs / a
#     Next.js process that survives 12+ hours. Catches the case where
#     systemd isn't available (dev / non-systemd hosts).
#
#   - Systemd timer (this): covers boot + intervals + Node restarts
#     during the 12h window. A box that pm2-reloads at 11:30 won't
#     fire its in-process check before 23:30; the systemd timer
#     catches the missed slot.
#
# Idempotent against `settings.updates_state.lastNotifiedSha` — calling
# twice in a row for the same release sends ONE email, not two.
#
# Auth: Bearer INTERNAL_REVALIDATE_SECRET (loaded via
# /etc/cavecms/env.production by the .service unit). Loopback-only —
# the endpoint refuses non-127.0.0.1 hosts even with a valid bearer.

set -euo pipefail

if [ -z "${INTERNAL_REVALIDATE_SECRET:-}" ]; then
  echo "[cavecms-updates-check] INTERNAL_REVALIDATE_SECRET not set — refusing" >&2
  exit 1
fi

PORT="${PORT:-3040}"
URL="http://127.0.0.1:${PORT}/api/internal/updates/trigger-check"

# `-fsS --max-time 60` — fail on HTTP non-2xx, silent transfer, surface
# errors only on stderr, hard 60s ceiling. Long enough for a GitHub
# API roundtrip + mailer send; well below the unit's TimeoutStartSec.
# `-X POST` — the endpoint only accepts POST.
# `-H "Host: 127.0.0.1:${PORT}"` — explicit loopback Host header so
# the endpoint's loopback gate passes even if Node's HTTP server is
# bound to a non-loopback alias.
# We pipe stderr through `logger -t` so failures show up under the
# unit's journalctl stream + OnFailure handlers fire.
if ! response=$(curl \
    -fsS \
    --max-time 60 \
    -X POST \
    -H "Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}" \
    -H "Host: 127.0.0.1:${PORT}" \
    -H "Content-Type: application/json" \
    "$URL" 2>&1); then
  echo "[cavecms-updates-check] curl failed: $response" >&2
  exit 1
fi

# Log the result on the journal — useful for "why didn't I get
# notified" debugging without dropping operator into log files.
echo "[cavecms-updates-check] ok: $response"
exit 0
