import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { isLoopbackInternalRequest, jsonInternal } from '@/lib/api/internalAuth'

// POST /api/internal/backups/audit-terminal — record the terminal state of a
// backup or restore run in `audit_log` (resource_type='backups').
//
// Called by scripts/cavecms-backup.sh + scripts/cavecms-restore.sh after each
// terminal transition. Distinct from the updates audit-terminal route because
// backups have no SHA-shaped resource id (the resource id is the archive
// basename) and a different action vocabulary.
//
// Loopback + bearer auth via the shared helper. userId is null — the
// orchestrator runs as the OS user, not on behalf of a logged-in admin (the
// "create"/"restore" admin route already wrote the who-triggered row).

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    action: z.enum([
      'backup',
      'backup_completed',
      'backup_failed',
      'restore',
      'restore_completed',
      'restore_failed',
      'restore_rolled_back',
    ]),
    // The archive basename (or "unknown" before one is named). varchar(60).
    resourceId: z.string().min(1).max(60),
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
    route: 'api/internal/backups/audit-terminal',
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

  const { action, resourceId, durationMs, error } = parsed.data

  try {
    await db.insert(auditLog).values({
      userId: null,
      action,
      resourceType: 'backups',
      resourceId: resourceId.slice(0, 60),
      diff: {
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
        ...(typeof error === 'string' && error.length > 0 ? { error } : {}),
      },
      ip: null,
      userAgent: null,
      requestId: null,
    })

    // On a terminal BACKUP state, reconcile cloud bookkeeping: persist any
    // rotated refresh token / folder id the engine wrote, and — if this run was
    // scheduler-initiated — record the REAL outcome (completion, not spawn).
    if (action === 'backup_completed' || action === 'backup_failed') {
      try {
        const { reconcileBackupCloudCredsOut, recordScheduledBackupOutcome } = await import(
          '@/lib/backups/cloud/credsFile'
        )
        await reconcileBackupCloudCredsOut()
        await recordScheduledBackupOutcome(action === 'backup_completed', error ?? null)
      } catch (err) {
        logEvent('warn', 'cloud_reconcile_failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    logEvent('info', 'recorded', { action, resourceId })
    return jsonInternal({ ok: true }, 200)
  } catch (err) {
    logEvent('error', 'db_failed', {
      err: err instanceof Error ? err.message : String(err),
    })
    return jsonInternal({ error: 'db_failed' }, 500)
  }
}
