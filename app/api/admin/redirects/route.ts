import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { validateRedirect } from '@/lib/cms/redirects'

interface RedirectRow {
  id: number
  source: string
  match_type: string
  action: string
  target: string | null
  status_code: number | null
  query_handling: string
  case_insensitive: number
  enabled: number
  position: number
  hit_count: number
  last_hit_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const [rows] = (await db.execute(sql`
    SELECT id, source, match_type, action, target, status_code, query_handling,
           case_insensitive, enabled, position, hit_count, last_hit_at, notes,
           created_at, updated_at
    FROM redirects
    ORDER BY position ASC, id ASC
  `)) as unknown as [RedirectRow[]]
  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})

interface InsertResult {
  insertId: number
}

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const v = validateRedirect(await readJsonBody(req))
  if (!v.ok) throw new HttpError(400, v.error)
  const r = v.value
  const meta = auditMetaFromRequest(req)

  // Position = append to the end (max+1) so new rules don't reorder others.
  const [posRows] = (await db.execute(sql`
    SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM redirects
  `)) as unknown as [{ pos: number }[]]
  const position = Number(posRows[0]?.pos ?? 0)

  let id: number
  try {
    id = await db.transaction(async (tx) => {
      const [ins] = (await tx.execute(sql`
        INSERT INTO redirects
          (source, match_type, action, target, status_code, query_handling,
           case_insensitive, enabled, position, notes, created_by)
        VALUES
          (${r.source}, ${r.matchType}, ${r.action}, ${r.action === 'gone' ? null : r.target},
           ${r.action === 'gone' ? null : r.statusCode}, ${r.queryHandling},
           ${r.caseInsensitive ? 1 : 0}, ${r.enabled ? 1 : 0}, ${position},
           ${r.notes ?? null}, ${ctx.userId})
      `)) as unknown as [InsertResult]
      const newId = Number(ins.insertId)
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'redirect_create',
        resourceType: 'redirect',
        resourceId: String(newId),
        diff: { source: r.source, matchType: r.matchType, target: r.target } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
      return newId
    })
  } catch (err: unknown) {
    if (isDuplicateKey(err)) {
      throw new HttpError(409, 'A rule with this source and match type already exists')
    }
    throw err
  }

  return new Response(JSON.stringify({ id }), {
    status: 201,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
