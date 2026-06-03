import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { withError } from '@/lib/api/withError'
import { requireRole, requireScope, HttpError } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { db } from '@/db/client'
import { PATHS } from '@/lib/media/storage'

export const runtime = 'nodejs'

// GET /api/cms/sync/media/pdf/[uuid] — token-reachable PDF source for the sync
// bundle. The public brochure route (/api/brochure/[token]) is lead-gated and
// not under /api/cms, so a bearer-token CLI can't use it; this endpoint serves
// the raw PDF (by filename_uuid) to an admin/editor token for pull/push.
export const GET = withError<{ params: Promise<{ uuid: string }> }>(async (_req, { params }) => {
  const ctx = await requireRole(['admin', 'editor'])
  // Serves a raw PDF by uuid to the bundle puller — gate on sync:read so a
  // non-sync token can't exfiltrate private PDFs (cookie sessions no-op).
  requireScope(ctx, 'sync', 'read')
  checkReadRate(ctx.userId)

  const { uuid } = await params
  // filename_uuid is a v4 UUID (36 chars) — reject anything else before any FS
  // access (defence against path traversal via the route param).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new HttpError(400, 'bad_uuid')
  }

  const [rows] = (await db.execute(sql`
    SELECT mime_type FROM media WHERE filename_uuid = ${uuid}
  `)) as unknown as [Array<{ mime_type: string }>]
  if (!rows[0] || rows[0].mime_type !== 'application/pdf') {
    throw new HttpError(404, 'not_found')
  }

  const file = path.join(PATHS.brochures, `${uuid}.pdf`)
  if (!existsSync(file)) throw new HttpError(404, 'not_found')

  return new Response(new Uint8Array(readFileSync(file)), {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'cache-control': 'private, no-store' },
  })
})
