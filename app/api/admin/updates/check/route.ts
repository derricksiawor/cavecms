import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'
import { checkLatestRelease } from '@/lib/updates/checkLatestRelease'

// POST /api/admin/updates/check — operator-triggered version check
// against the configured upstream (GitHub: derricksiawor/cavecms by
// default; future cavecms.derricksiawor.com manifest will swap behind a provider
// interface).
//
// Marked POST (not GET) so it sits behind CSRF + mutation rate-limit
// — each call burns a slot in our GitHub-API rate budget (60 unauth
// /hr). Without rate-limiting + CSRF, a logged-in admin's browser
// could be coerced (via CSRF) to drain our budget remotely.
//
// The actual upstream fetch is cached for 5 minutes in
// lib/updates/checkLatestRelease.ts, so the banner + dashboard card
// + settings page all calling /check on mount cost ONE network
// request between them.
//
// NO audit_log row on /check — the call is browser-driven, fires on
// every admin page navigation, and a 50-row burst per session is
// noise that hides the actually-interesting `apply` audit rows. The
// apply route is the meaningful audit event.

export const dynamic = 'force-dynamic'

const REPO_OWNER = process.env.CAVECMS_REPO_OWNER ?? 'derricksiawor'
const REPO_NAME = process.env.CAVECMS_REPO_NAME ?? 'cavecms'

interface CheckResponse {
  current: { sha: string; ts: string | null }
  available: {
    sha: string
    ts: string
    changelog: string
    isSecurity: boolean
  } | null
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const current = getCurrentVersion()
  let latest: Awaited<ReturnType<typeof checkLatestRelease>>
  try {
    latest = await checkLatestRelease({ owner: REPO_OWNER, repo: REPO_NAME })
  } catch {
    // Bubble the structured error through withError. We DON'T echo
    // the GitHub-side error body verbatim — it may carry rate-limit
    // context tied to our IP that doesn't belong in operator-visible
    // copy.
    throw new HttpError(502, 'check_failed')
  }

  // "Up to date" when the upstream SHA matches our running SHA.
  // Comparison: upstream returns full 40-char SHA; current.sha is
  // whatever `CAVECMS_COMMIT` is set to (typically 12-char short SHA).
  // `latest.sha.startsWith(current.sha)` correctly matches "abc1234"
  // against the long form. For dev (sha='dev') we always surface the
  // latest commit so the operator can see what they would update to
  // once deployed — useful for screenshots + demos.
  const upToDate = current.sha !== 'dev' && latest.sha.startsWith(current.sha)

  const payload: CheckResponse = {
    current,
    available: upToDate
      ? null
      : {
          sha: latest.sha,
          ts: latest.ts,
          changelog: latest.changelog,
          isSecurity: latest.isSecurity,
        },
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
