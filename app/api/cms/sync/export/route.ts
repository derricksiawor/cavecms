import { withError } from '@/lib/api/withError'
import { requireRole, requireScope } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { buildBundleContent, contentGraphOf } from '@/lib/sync/serializeLocal'
import { canonicalContentHash } from '@/lib/sync/contentHash'
import { BUNDLE_FORMAT_VERSION } from '@/lib/sync/bundleTypes'

// GET /api/cms/sync/export — the LOCAL install's content as a bundle source.
//
// Returns the serialized content (pages as block trees, posts, projects,
// settings) + media entries whose `files` carry the on-disk source URLs
// (/uploads/variants/* for images, /api/brochure/by-uuid/* for PDFs). The
// `cavecms push` CLI downloads those files to assemble the bundle tarball and
// stamps the manifest. The content hash is included so the CLI can set
// manifest.contentHash without recomputing.
//
// Read-only, token-reachable (admin|editor). This is invoked against the
// operator's LOCAL install, not prod.
export const GET = withError(async () => {
  const ctx = await requireRole(['admin', 'editor'])
  // Serializes the ENTIRE site content out — gate on sync:read so a token
  // without the sync grant can't exfiltrate it (cookie sessions no-op).
  requireScope(ctx, 'sync', 'read')
  checkReadRate(ctx.userId)

  const content = await buildBundleContent()
  const contentHash = canonicalContentHash(contentGraphOf(content))

  return new Response(
    JSON.stringify({
      formatVersion: BUNDLE_FORMAT_VERSION,
      contentHash,
      content,
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
