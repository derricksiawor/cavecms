import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { isLoopbackInternalRequest, jsonInternal } from '@/lib/api/internalAuth'

// POST /api/internal/updates/audit-terminal — record the terminal state
// of an update run (completed | failed | rolled_back) in `audit_log`.
//
// Called by scripts/cavecms-update.sh after each terminal transition
// (success, failed, rolled_back). The script ALREADY has an "apply"
// audit_log entry written by app/api/admin/updates/apply/route.ts at
// kick-off, capturing who-clicked-update + fromSha → toSha. The
// terminal write adds the outcome + duration so the Update History
// table on /admin/settings/updates can render "Apply ... succeeded /
// rolled back / failed in 87s" without scraping the status file or
// inferring from log files.
//
// Why a separate row (not an UPDATE on the apply row): `audit_log` is
// append-only by design (the audit thread for ANY resource is a series
// of immutable events). The history table joins the apply row (who
// triggered) with the terminal row (what happened) by `(resource_id,
// time-window)`.
//
// User-id is null on terminal rows: the orchestrator runs as the OS
// user, not on behalf of any logged-in admin. The "who triggered"
// column in the history table reads userId from the matching apply row.
//
// Loopback + bearer auth via the shared helper.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    action: z.enum(['completed', 'failed', 'rolled_back']),
    fromSha: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9a-fA-F]+$|^unknown$/),
    toSha: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9a-fA-F]+$/),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    error: z.string().max(500).optional(),
  })
  .strict()

function logEvent(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  const out = JSON.stringify({
    level,
    route: 'api/internal/updates/audit-terminal',
    msg,
    ...extra,
  })
  if (level === 'error') console.error(out)
  else console.log(out)
}

export async function POST(req: Request): Promise<Response> {
  if (!isLoopbackInternalRequest(req)) {
    logEvent('warn', 'unauthorized')
    return jsonInternal({ error: 'unauthorized' }, 401)
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return jsonInternal({ error: 'invalid_json' }, 400)
  }
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return jsonInternal({ error: 'invalid_payload' }, 400)
  }

  const { action, fromSha, toSha, durationMs, error } = parsed.data
  const fromLower = fromSha.toLowerCase()
  const toLower = toSha.toLowerCase()

  try {
    await db.insert(auditLog).values({
      userId: null,
      action,
      resourceType: 'updates',
      resourceId: toLower.slice(0, 12),
      diff: {
        fromSha: fromLower,
        toSha: toLower,
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
        ...(typeof error === 'string' && error.length > 0 ? { error } : {}),
      },
      ip: null,
      userAgent: null,
      requestId: null,
    })

    logEvent('info', 'recorded', { action, toSha: toLower.slice(0, 12) })
    return jsonInternal({ ok: true }, 200)
  } catch (err) {
    logEvent('error', 'db_failed', {
      err: err instanceof Error ? err.message : String(err),
    })
    return jsonInternal({ error: 'db_failed' }, 500)
  }
}
