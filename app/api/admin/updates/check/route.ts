import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'
import { checkLatestRelease } from '@/lib/updates/checkLatestRelease'
import { findValidStaged } from '@/lib/updates/releaseCache'
import { getSetting } from '@/lib/cms/getSettings'

// POST /api/admin/updates/check — operator-triggered version check
// against the static release manifest at updates.cavecms.com/updates/latest.json
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
  // Background pre-stage state for the relevant target (the available
  // upgrade, when there is one). `staged` is non-null ONLY when the
  // verified artifact is present on disk RIGHT NOW (findValidStaged) — so a
  // GC'd / evicted artifact never shows as ready. `stageState` carries the
  // coarse machine state (downloading / staged / failed / ineligible) so
  // the UI can render a "downloading in the background…" hint while bytes
  // are still arriving. Both null when nothing is being staged for this
  // target (or auto-download is off).
  staged: { sha: string; sha256: string; version: string; stagedAt: string } | null
  stageState: 'downloading' | 'staged' | 'failed' | 'ineligible' | null
}

// Length-aware prefix match (12-char short SHA ↔ full 40-char) for matching
// the durable stagedSha against the relevant target.
function shaMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  if (a.length < 7 || b.length < 7) return false
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a]
  return longer.startsWith(shorter)
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

  // Background pre-stage surfacing. The relevant target is the available
  // upgrade (or the running version when up-to-date — where nothing is
  // normally staged). `staged` requires the verified artifact to exist on
  // disk RIGHT NOW; `stageState` reflects the durable record but only when
  // it pertains to this target (so a stale "downloading" for a superseded
  // release doesn't leak into the UI).
  const stagedTargetSha = upToDate ? current.sha : latest.sha
  let stagedBlock: CheckResponse['staged'] = null
  let stageStateOut: CheckResponse['stageState'] = null
  try {
    const updatesState = await getSetting('updates_state')
    const pertains = shaMatches(updatesState.stagedSha, stagedTargetSha)
    if (pertains && updatesState.stageState) {
      stageStateOut = updatesState.stageState
    }
    const stagedPath = findValidStaged({
      targetSha: stagedTargetSha,
      sha256: latest.sha256,
    })
    if (stagedPath) {
      stagedBlock = {
        sha: stagedTargetSha,
        sha256: latest.sha256,
        version: updatesState.stagedVersion ?? latest.version,
        stagedAt: updatesState.stagedAt ?? '',
      }
      // Disk-truth wins: if the artifact is present, the state IS staged
      // regardless of a lagging durable record.
      stageStateOut = 'staged'
    }
  } catch {
    // Best-effort — a settings read failure must not break the check.
  }

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
    staged: stagedBlock,
    stageState: stageStateOut,
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
