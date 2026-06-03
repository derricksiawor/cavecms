import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, requireScope, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { trashArchive, isValidArchiveBasename } from '@/lib/backups/store'

// POST /api/admin/backups/delete — move a backup to a sibling `.trash-<ts>/`
// dir (never rm). Admin-gated + CSRF.

export const dynamic = 'force-dynamic'

const Body = z.object({ file: z.string().min(1).max(200) }).strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'backups', 'delete')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))

  if (!isValidArchiveBasename(body.file)) throw new HttpError(400, 'invalid_file')

  const stamp = new Date()
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')
  try {
    trashArchive(body.file, stamp)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'not found') throw new HttpError(404, 'not_found')
    throw new HttpError(400, 'delete_failed')
  }

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'backup_deleted',
      resourceType: 'backups',
      resourceId: body.file.slice(0, 60),
      diff: {},
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'backup_delete_audit_failed', err: err instanceof Error ? err.message : String(err) }))
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
