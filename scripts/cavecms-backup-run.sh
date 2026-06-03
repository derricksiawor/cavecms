#!/usr/bin/env bash
# scripts/cavecms-backup-run.sh — systemd-timer-invoked scheduled-backup tick.
#
# Fires hourly (see scripts/systemd/cavecms-backup-run.timer). POSTs to the
# loopback /api/internal/backups/trigger-scheduled endpoint, which runs the same
# lib/backups/scheduler.runBackupTickIfDue() code path as the in-process
# setInterval in instrumentation.ts. Two layers on purpose:
#
#   - In-process setInterval: covers a Next.js process that survives the
#     window (and non-systemd hosts / laptops).
#   - Systemd timer (this): covers boot + Node restarts during the window so a
#     box that pm2-reloads just before the scheduled hour still backs up.
#
# The endpoint is a no-op unless a backup is actually DUE (schedule + hour) and
# no other op holds the shared lock, and it claims the occurrence before
# spawning — so the in-process tick + this timer can't double-fire.
#
# Auth: Bearer INTERNAL_REVALIDATE_SECRET (loaded via /etc/cavecms/env.production
# by the .service unit). Loopback-only.

set -euo pipefail

if [ -z "${INTERNAL_REVALIDATE_SECRET:-}" ]; then
  echo "[cavecms-backup-run] INTERNAL_REVALIDATE_SECRET not set — refusing" >&2
  exit 1
fi

PORT="${PORT:-3040}"
URL="http://127.0.0.1:${PORT}/api/internal/backups/trigger-scheduled"

if ! response=$(curl \
    -fsS \
    --max-time 60 \
    -X POST \
    -H "Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}" \
    -H "Host: 127.0.0.1:${PORT}" \
    -H "Content-Type: application/json" \
    "$URL" 2>&1); then
  echo "[cavecms-backup-run] curl failed: $response" >&2
  exit 1
fi

echo "[cavecms-backup-run] ok: $response"
exit 0
