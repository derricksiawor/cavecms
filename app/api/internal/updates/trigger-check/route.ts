import { isLoopbackInternalRequest, jsonInternal } from '@/lib/api/internalAuth'

// POST /api/internal/updates/trigger-check — internal-callable variant
// of the admin-gated trigger-check endpoint. Backs the systemd timer
// (scripts/systemd/cavecms-updates-check.timer) so updates surface even
// when no admin browser tab is open and the in-process setInterval
// scheduler died with the last Node restart.
//
// Same body of work as `app/api/admin/updates/trigger-check`:
// dynamically import the backgroundScheduler module (so the nodemailer
// transitive doesn't reach the edge runtime), call `runUpdateCheck()`,
// return the result. Idempotent against `settings.updates_state.lastNotifiedSha`
// so a 12-hourly timer + an in-process tab calling simultaneously can't
// send two emails for the same release.
//
// Loopback + bearer auth via the shared helper. No CSRF (bearer-authed,
// not cookie-authed). No admin role check (the helper's loopback gate
// is the entire authorization model — only callers who already have
// shell + the secret can reach this).

export const dynamic = 'force-dynamic'

interface RunResult {
  skipped?: 'dev' | 'check_failed'
  current?: string
  available?: string
  notified?: boolean
}

function logEvent(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  const out = JSON.stringify({
    level,
    route: 'api/internal/updates/trigger-check',
    msg,
    ...extra,
  })
  if (level === 'error') console.error(out)
  else console.log(out)
}

export async function POST(req: Request): Promise<Response> {
  if (!isLoopbackInternalRequest(req)) {
    logEvent('warn', 'unauthorized')
    return jsonInternal({ error: 'unauthorized' }, 401)
  }

  try {
    // Dynamic import keeps the nodemailer transitive out of the
    // edge runtime — same pattern as instrumentation.ts and the
    // sibling admin trigger-check route.
    const mod = await import('@/lib/updates/backgroundScheduler')
    const result = (await mod.runUpdateCheck()) as RunResult

    if (result.skipped === 'check_failed') {
      logEvent('warn', 'check_failed')
      return jsonInternal({ error: 'check_failed' }, 502)
    }

    logEvent('info', 'completed', {
      skipped: result.skipped ?? null,
      notified: result.notified ?? false,
    })
    return jsonInternal(result, 200)
  } catch (err) {
    logEvent('error', 'unhandled', {
      err: err instanceof Error ? err.message : String(err),
    })
    return jsonInternal({ error: 'internal_error' }, 500)
  }
}
