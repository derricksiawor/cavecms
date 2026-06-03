import { isLoopbackInternalRequest, jsonInternal } from '@/lib/api/internalAuth'

// POST /api/internal/backups/trigger-scheduled — internal-callable scheduler
// tick. Backs the systemd timer (scripts/systemd/cavecms-backup-run.timer) so a
// scheduled backup still fires when no admin tab is open and the in-process
// setInterval died with the last Node restart. Same work as the in-process
// tick: runBackupTickIfDue(). Idempotent + re-entrant-safe via
// backups_state.lastScheduledBackupAt + the shared op lock.
//
// Loopback + bearer auth via the shared helper. No CSRF, no admin role — the
// loopback gate is the whole authorization model.

export const dynamic = 'force-dynamic'

function logEvent(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const out = JSON.stringify({ level, route: 'api/internal/backups/trigger-scheduled', msg, ...extra })
  if (level === 'error') console.error(out)
  else console.log(out)
}

export async function POST(req: Request): Promise<Response> {
  if (!isLoopbackInternalRequest(req)) {
    logEvent('warn', 'unauthorized')
    return jsonInternal({ error: 'unauthorized' }, 401)
  }
  try {
    const mod = await import('@/lib/backups/scheduler')
    await mod.runBackupTickIfDue()
    logEvent('info', 'completed')
    return jsonInternal({ ok: true }, 200)
  } catch (err) {
    logEvent('error', 'unhandled', { err: err instanceof Error ? err.message : String(err) })
    return jsonInternal({ error: 'internal_error' }, 500)
  }
}
