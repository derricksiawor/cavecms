import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import {
  readStatus,
  isStale,
  isStaleTerminal,
  type UpdateStatus,
} from '@/lib/updates/statusFile'
import { UPDATE_TOTAL_STEPS } from '@/lib/updates/constants'

// GET /api/admin/updates/status — admin-gated read of the live status
// file. The Updates progress modal polls this every 1-2s while an
// update is in flight, so we keep the work here minimal: one disk
// read, two staleness checks, JSON out.
//
// Two flavours of "stale":
//
// 1. STALE IN-PROGRESS — state ∈ {preflight, updating, restarting}
//    AND updatedAt > 15 min old: the orchestrator script crashed
//    silently. Surface a synthetic `failed` so the modal renders an
//    error + the apply route's stale-clear path lets the operator
//    retry.
//
// 2. STALE TERMINAL — state ∈ {completed, failed, rolled_back} AND
//    updatedAt > 24 h old: irrelevant; pretend the status file is
//    empty (`idle`) so the dashboard banner doesn't resurrect a
//    week-old completion the next time an operator logs in.
//
// CSRF not required: this is a pure read.

export const dynamic = 'force-dynamic'

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const status = readStatus()
  let payload: UpdateStatus
  if (!status || isStaleTerminal(status)) {
    const now = new Date().toISOString()
    payload = {
      state: 'idle',
      step: 0,
      totalSteps: UPDATE_TOTAL_STEPS,
      startedAt: now,
      updatedAt: now,
    }
  } else if (isStale(status)) {
    payload = {
      ...status,
      state: 'failed',
      error: 'update process timed out (no progress in 15 min)',
    }
  } else {
    payload = status
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
