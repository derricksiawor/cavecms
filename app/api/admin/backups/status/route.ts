import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkStatusPollRate } from '@/lib/auth/cmsRateLimit'
import {
  readBackupStatus,
  isBackupStale,
  isBackupStaleTerminal,
  readRestoreStatus,
  isRestoreStale,
  isRestoreStaleTerminal,
} from '@/lib/backups/statusFile'
import { BACKUP_TOTAL_STEPS, RESTORE_TOTAL_STEPS } from '@/lib/backups/constants'

// GET /api/admin/backups/status?kind=backup|restore — admin-gated read of the
// live backup/restore status file. The progress modals poll this. Pure read,
// no CSRF. Mirrors updates/status semantics (stale-in-progress → synthetic
// failed; stale-terminal → idle).

export const dynamic = 'force-dynamic'

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  checkStatusPollRate(ctx.userId)

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') === 'restore' ? 'restore' : 'backup'
  const now = new Date().toISOString()

  let payload: unknown
  if (kind === 'restore') {
    const s = readRestoreStatus()
    if (!s || isRestoreStaleTerminal(s)) {
      payload = { state: 'idle', step: 0, totalSteps: RESTORE_TOTAL_STEPS, startedAt: now, updatedAt: now }
    } else if (isRestoreStale(s)) {
      payload = { ...s, state: 'failed', error: 'restore process timed out (no progress in 15 min)' }
    } else {
      payload = s
    }
  } else {
    const s = readBackupStatus()
    if (!s || isBackupStaleTerminal(s)) {
      payload = { state: 'idle', step: 0, totalSteps: BACKUP_TOTAL_STEPS, startedAt: now, updatedAt: now }
    } else if (isBackupStale(s)) {
      payload = { ...s, state: 'failed', error: 'backup process timed out (no progress in 15 min)' }
    } else {
      // NOTE: cloud token/folder reconciliation happens in the audit-terminal
      // internal endpoint (which fires for scheduled runs too), not here — this
      // GET stays a pure read.
      payload = s
    }
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
