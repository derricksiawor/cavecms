import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkStatusPollRate } from '@/lib/auth/cmsRateLimit'
import { listBackups } from '@/lib/backups/store'

// GET /api/admin/backups/list — admin-gated listing of local backups. Pure
// read. Returns humanised entries (no server paths) for the Settings page.
//
// Uses the status-poll bucket, not the general read bucket: the Settings page
// refreshes this list on every backup/restore completion, so during a burst of
// operations it is an operation-coupled read (same category as the progress
// poll) — and it's a cheap local-disk readdir returning only backup metadata
// (no PII, no table data), so it doesn't belong in the 120/min bucket sized for
// media-grid lazy-loading, which it would otherwise drain. (remote-list keeps
// the tighter general bucket — it hits the cloud provider API per call.)

export const dynamic = 'force-dynamic'

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkStatusPollRate(ctx.userId)
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
