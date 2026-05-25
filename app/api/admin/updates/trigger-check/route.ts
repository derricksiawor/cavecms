import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'

// POST /api/admin/updates/trigger-check — manually fire the update
// check + notify loop ON DEMAND, the same code path the in-process
// 12-hourly scheduler runs. Useful for:
//
//   - Operator wants to verify their notification email actually
//     fires (without waiting 12 hours)
//   - Support debugging "why didn't I get notified?"
//   - QA / Playwright walkthroughs
//
// Admin-only, CSRF-protected, rate-limited (each call burns a slot
// in the GitHub API budget). Idempotent against `lastNotifiedSha`
// stored in `settings.updates_state` — calling twice in a row for
// the same release sends ONE email, not two.

export const dynamic = 'force-dynamic'

interface RunResult {
  skipped?: 'dev' | 'check_failed'
  current?: string
  available?: string
  notified?: boolean
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  // Same import-boundary trick as instrumentation.ts — the
  // background scheduler module pulls nodemailer transitively, so
  // we keep it dynamically loaded.
  const mod = await import('@/lib/updates/backgroundScheduler')
  const result = (await mod.runUpdateCheck()) as RunResult

  if (result.skipped === 'check_failed') {
    throw new HttpError(502, 'check_failed')
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
})
