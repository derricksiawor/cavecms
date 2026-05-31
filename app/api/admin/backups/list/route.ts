import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { listBackups } from '@/lib/backups/store'

// GET /api/admin/backups/list — admin-gated listing of local backups. Pure
// read. Returns humanised entries (no server paths) for the Settings page.

export const dynamic = 'force-dynamic'

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const entries = listBackups().map((e) => ({
    file: e.file,
    sizeBytes: e.sizeBytes,
    createdAt: new Date(e.createdAtMs).toISOString(),
    encrypted: e.encrypted,
    version: e.version,
    includeEnv: e.includeEnv,
  }))
  return new Response(JSON.stringify({ backups: entries }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
