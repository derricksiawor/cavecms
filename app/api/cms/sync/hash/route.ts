import { withError } from '@/lib/api/withError'
import { requireRole, requireScope } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { buildBundleContent, contentGraphOf } from '@/lib/sync/serializeLocal'
import { canonicalContentHash } from '@/lib/sync/contentHash'

// GET /api/cms/sync/hash — the live content-graph hash + counts.
//
// Read-only. The `cavecms pull` CLI reads this to record the drift baseline,
// and the cutover orchestrator reads it again at swap time to detect whether
// prod changed since the operator pulled. Token-reachable (admin|editor) via
// the existing /api/cms/* allowlist; no live writes.
export const GET = withError(async () => {
  const ctx = await requireRole(['admin', 'editor'])
  // Exposes the full content hash + counts cross-instance — gate on sync:read.
  requireScope(ctx, 'sync', 'read')
  checkReadRate(ctx.userId)

  const content = await buildBundleContent()
  const contentHash = canonicalContentHash(contentGraphOf(content))

  return new Response(
    JSON.stringify({
      contentHash,
      counts: {
        pages: content.pages.length,
        posts: content.posts.length,
        projects: content.projects.length,
        media: content.media.length,
        settings: Object.keys(content.settings).length,
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
}, { timeoutMs: 600_000 }) // buildBundleContent over a large site can exceed the 15s default
