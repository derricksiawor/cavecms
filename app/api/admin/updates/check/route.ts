import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'
import { checkLatestRelease } from '@/lib/updates/checkLatestRelease'

// POST /api/admin/updates/check — operator-triggered version check
// against the static release manifest at cavecms.derricksiawor.com/updates/latest.json
// (override with CAVECMS_RELEASE_MANIFEST_URL for forks).
//
// Marked POST (not GET) so it sits behind CSRF + mutation rate-limit
// — without rate-limiting + CSRF, a logged-in admin's browser could be
// coerced (via CSRF) to drain our outbound bandwidth budget remotely.
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

interface CheckResponse {
  current: { sha: string; ts: string | null }
  available: {
    sha: string
    ts: string
    changelog: string
    isSecurity: boolean
    version: string
    downloadUrl: string
    sha256: string
    // Ed25519 signature over the tarball bytes. The apply route's
    // Zod schema now REQUIRES this — `null` here means the manifest
    // entry is unsigned, which is a hard refusal (no in-app update
    // path for unsigned releases). UI surfaces this as "release not
    // verifiable, run npx create-cavecms@latest to recover".
    signature: string | null
    minPreviousVersion: string | null
  } | null
  // Coords for re-installing the CURRENTLY running version (Re-run
  // install recovery affordance). Populated when the running SHA
  // matches the latest manifest entry — the common up-to-date case
  // where `available` is null but the operator still needs known-good
  // tarball coords to recover from a broken local state.
  currentRelease: { downloadUrl: string; sha256: string; signature: string | null } | null
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const current = getCurrentVersion()
  let latest: Awaited<ReturnType<typeof checkLatestRelease>>
  try {
    latest = await checkLatestRelease()
  } catch (err) {
    // Distinguish the failure classes so the UI can render
    // operator-friendly copy:
    //   - manifest_not_found (HTTP 404 on the manifest URL)
    //     → "Couldn't find the release manifest — check
    //        CAVECMS_RELEASE_MANIFEST_URL"
    //   - manifest_unreachable / network class
    //     → "Couldn't reach the release server, try again later"
    //   - manifest_malformed_* / generic
    //     → "The release server returned bad data"
    //
    // We DON'T echo the upstream body verbatim — it may carry context
    // that doesn't belong in operator UI.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'manifest_not_found') {
      throw new HttpError(502, 'check_repo_not_found')
    }
    if (msg.startsWith('manifest_unreachable')) {
      throw new HttpError(502, 'check_unreachable')
    }
    throw new HttpError(502, 'check_failed')
  }

  // "Up to date" when the upstream SHA matches our running SHA.
  // Upstream returns full 40-char SHA; current.sha is whatever
  // `CAVECMS_COMMIT` is set to (typically 12-char short SHA).
  // `latest.sha.startsWith(current.sha)` correctly matches "abc1234"
  // against the long form. For dev (sha='dev') we always surface the
  // latest release so the operator can see what they would update to
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
          version: latest.version,
          downloadUrl: latest.downloadUrl,
          sha256: latest.sha256,
          signature: latest.signature ?? null,
          minPreviousVersion: latest.minPreviousVersion,
        },
    currentRelease: upToDate
      ? {
          downloadUrl: latest.downloadUrl,
          sha256: latest.sha256,
          signature: latest.signature ?? null,
        }
      : null,
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
