import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { withError } from '@/lib/api/withError'
import { requireRole, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { readJsonBody } from '@/lib/api/jsonBody'
import { runCutover } from '@/lib/sync/cutover'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'

export const runtime = 'nodejs'

// The drift baseline is NOT accepted here — it comes from the immutable staged
// record (set at stage time from the bundle manifest), so a direct caller can't
// null it to skip drift. Only `force` (explicit overwrite) is a request opt.
const Body = z.object({
  stageId: z.string().min(1),
  force: z.boolean().optional(),
})

// POST /api/cms/sync/cutover — atomic content cutover from a staged push.
// Synchronous: the transaction is the atomicity guarantee, the content backup
// is the only multi-second step. Drift is refused unless `force`.
export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  // Wholesale content replacement — gate on sync:write (cookie sessions no-op).
  requireScope(ctx, 'sync', 'write')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = Body.parse(await readJsonBody(req))
  const out = await runCutover({ stageId: body.stageId, force: body.force }, { userId: ctx.userId, tokenId: ctx.tokenId })

  // A cutover wholesale-REPLACES every page + post + the 8 push settings and
  // upserts projects — so the public site's caches are now stale across the
  // board. Bust them HERE, synchronously, inside the route's request context
  // (Next 15 requires revalidateTag/revalidatePath to run in-context — a
  // deferred microtask silently no-ops; mirrors app/api/admin/settings PATCH).
  //   - revalidatePath('/', 'layout'): drops the entire rendered route tree —
  //     covers statically-cached system pages (/about, /privacy, …) AND the
  //     deleted old slugs' routes, which now 404. Same hammer the
  //     install-template "wholesale content installed" path uses.
  //   - settings tag: the layout header/footer/branding/SEO + recaptcha config
  //     read through getSettings()'s unstable_cache('settings'), which would
  //     otherwise serve the PRIOR site's chrome for up to its 60s revalidate
  //     window after the push — the operator pushes, reloads, and sees stale
  //     branding (looks broken). This was the gap the live customer-journey
  //     walk surfaced.
  //   - home/index/sitemap/robots tags: the blog index, projects index +
  //     featured carousel, sitemap, and robots are content-driven data caches
  //     whose membership changed wholesale.
  // Best-effort: the swap already committed; a revalidation hiccup must not
  // turn a successful cutover into a reported failure (safeRevalidate already
  // swallows + enqueues a retry; revalidatePath is wrapped defensively).
  if (out.ok) {
    try {
      revalidatePath('/', 'layout')
    } catch {
      /* outside-context no-op is acceptable — the tag busts below + the 60s
         revalidate floor still converge the cache */
    }
    await safeRevalidate([
      tag.settings,
      tag.home,
      tag.pagesIndex,
      tag.postsIndex,
      tag.projectsIndex,
      tag.featuredProjects,
      tag.sitemap,
      tag.robots,
    ]).catch(() => undefined)
  }

  const status = out.ok
    ? 200
    : out.reason === 'stage_not_found'
      ? 404
      : out.reason === 'busy' || out.reason === 'drift_detected'
        ? 409
        : 500

  // Return only the artifact BASENAME (not the absolute server path) so the
  // success response doesn't leak the prod filesystem layout to the client.
  const safe = out.ok
    ? { ...out, backupArtifact: out.backupArtifact.split('/').pop() }
    : out
  return new Response(JSON.stringify(safe), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}, { timeoutMs: 600_000 }) // content backup + atomic swap can exceed the 15s default on a large site
