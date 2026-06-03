import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tag } from '@/lib/cache/tags'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'

// Per-project optimistic-lock token accepted under either `version`
// (canonical) or the legacy `expectedVersion` alias.
const Body = z
  .object({
    projects: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            version: z.number().int().nonnegative().optional(),
            expectedVersion: z.number().int().nonnegative().optional(),
          })
          .refine(
            (b) => b.version !== undefined || b.expectedVersion !== undefined,
            'version_required',
          )
          .transform((b) => ({
            id: b.id,
            version: (b.version ?? b.expectedVersion) as number,
          })),
      )
      .min(1)
      .max(50),
  })
  .strict()

interface LivingRow {
  id: number
  version: number
  slug: string
}

// POST /api/cms/projects/reorder — sets featured_order across the
// submitted set in submission order, starting at 1. Mirrors the
// blocks/reorder pattern:
//   1. Set-equality + version drift guard inside FOR UPDATE.
//   2. Single batched UPDATE via CASE collapses N round-trips into one
//      — caps total lock time at one statement no matter how big the
//      catalog grows.
//   3. Cache tags: projects-index + featured-projects + every renamed
//      project tag (so renamed-but-published projects re-render with
//      new positions on the carousel).
export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'projects', 'write')
  checkCmsMutationRate(ctx)

  const body = Body.parse(await readJsonBody(req))

  const submittedIds = new Set(body.projects.map((p) => p.id))
  if (submittedIds.size !== body.projects.length) {
    throw new HttpError(409, 'duplicate_project_id')
  }

  const meta = auditMetaFromRequest(req)

  const txResult = await db.transaction(async (tx) => {
    const ids = body.projects.map((p) => p.id)
    const [rows] = (await tx.execute(sql`
      SELECT id, version, slug
      FROM projects
      WHERE id IN (${sql.join(ids, sql.raw(','))})
        AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [LivingRow[]]
    if (rows.length !== ids.length) throw new HttpError(409, 'drift')

    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const p of body.projects) {
      const cur = byId.get(p.id)
      if (!cur || cur.version !== p.version) {
        throw new HttpError(409, 'stale_version')
      }
    }

    // Batched UPDATE via CASE expression — one statement, one set of
    // row locks, one RTT. Same pattern as content_blocks reorder. The
    // CASE values are parameterized via sql template literals; column
    // names are static.
    const positionCase = sql.join(
      body.projects.map((p, i) => sql`WHEN ${p.id} THEN ${i + 1}`),
      sql.raw(' '),
    )
    await tx.execute(sql`
      UPDATE projects
      SET featured_order = CASE id ${positionCase} END,
          version = version + 1,
          updated_by = ${ctx.userId}
      WHERE id IN (${sql.join(ids, sql.raw(','))})
        AND deleted_at IS NULL
    `)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action: 'reorder',
      resourceType: 'projects',
      resourceId: null,
      diff: {
        kind: AUDIT_KIND.reorder,
        order: body.projects.map((p) => p.id),
      } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    const tags = [
      'projects-index',
      'featured-projects',
      ...rows.map((r) => tag.project(r.slug)),
    ]
    const queueRowId = await enqueueRevalidate(tx, tags)
    const out = body.projects.map((p) => ({
      id: p.id,
      version: p.version + 1,
    }))
    return { out, queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  // Response key `items` matches the convention every other list /
  // reorder endpoint uses. The prior `projects` outlier forced a
  // per-consumer special case (`ReorderResponse` in ProjectsTable).
  return new Response(JSON.stringify({ items: txResult.out }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
