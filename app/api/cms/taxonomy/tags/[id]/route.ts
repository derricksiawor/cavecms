import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { env } from '@/lib/env'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import {
  tagsForTaxonomyUpdate,
  tagsForTaxonomyDelete,
} from '@/lib/cache/tags'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { SLUG_RE, SLUG_MIN } from '@/lib/cms/slug'
import { validateTermSlug } from '@/lib/cms/taxonomy-slug'

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
const SLUG_MAX = 120
const NAME_MAX = 120

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// Tags have no `version` column (flat free-form terms). Edits are last-write-
// wins on (name, slug). The slug UNIQUE index is the only conflict guard.
const PatchBody = z
  .object({
    name: z.string().min(1).max(NAME_MAX).optional(),
    slug: z
      .string()
      .min(SLUG_MIN)
      .max(SLUG_MAX)
      .regex(SLUG_RE, 'slug_invalid_format')
      .optional(),
  })
  .strict()

interface TagRow {
  id: number
  slug: string
  name: string
}

type RouteCtx = { params: Promise<{ id: string }> }

export const PATCH = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = PatchBody.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)

  if (body.slug !== undefined) {
    const slugCheck = validateTermSlug(body.slug, env.LOGIN_PATH)
    if (!slugCheck.ok) {
      console.info(
        JSON.stringify({
          level: 'info',
          msg: 'tag_slug_validation_failed',
          reason: slugCheck.reason,
        }),
      )
      throw new HttpError(422, 'slug_invalid')
    }
  }

  let slugChangedOuter = false
  try {
    const txResult = await db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT id, slug, name FROM tags WHERE id = ${id} FOR UPDATE
      `)) as unknown as [TagRow[]]
      const row = rows[0]
      if (!row) throw new HttpError(404, 'not_found')

      const slugChanged = body.slug !== undefined && body.slug !== row.slug
      slugChangedOuter = slugChanged
      const nextSlug = body.slug ?? row.slug
      const nextName = body.name ?? row.name

      if (nextSlug === row.slug && nextName === row.name) {
        return { queueRowId: null as number | null, tags: [] as string[] }
      }

      await tx.execute(sql`
        UPDATE tags
        SET slug = ${nextSlug}, name = ${nextName}, updated_by = ${ctx.userId}
        WHERE id = ${id}
      `)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'update',
        resourceType: 'tag',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.taxonomyUpdate,
          from: { slug: row.slug, name: row.name },
          to: { slug: nextSlug, name: nextName },
          slugChanged,
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      const tags = tagsForTaxonomyUpdate('tag', nextSlug, {
        slugChanged,
        oldSlug: slugChanged ? row.slug : undefined,
      }).tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return { queueRowId, tags }
    })

    if (txResult.queueRowId !== null) {
      const rowId = txResult.queueRowId
      const tags = txResult.tags
      queueMicrotask(() => {
        void drainRevalidate(rowId, tags)
      })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (err: unknown) {
    if (isDuplicateKey(err)) {
      throw new HttpError(409, slugChangedOuter ? 'slug_taken' : 'conflict')
    }
    throw err
  }
})

// DELETE removes a tag. SAFE BY DESIGN: post_tags FK is ON DELETE CASCADE, so
// only the junction rows vanish — the posts survive. Admin-only. Hard delete.
export const DELETE = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const meta = auditMetaFromRequest(req)

  const txResult = await db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, slug, name FROM tags WHERE id = ${id} FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; name: string }>]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    const [cntRows] = (await tx.execute(sql`
      SELECT COUNT(*) AS n FROM post_tags WHERE tag_id = ${id}
    `)) as unknown as [Array<{ n: number | string }>]
    const detachedPostCount = Number(cntRows[0]?.n ?? 0)

    await tx.execute(sql`DELETE FROM tags WHERE id = ${id}`)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'delete',
      resourceType: 'tag',
      resourceId: String(id),
      diff: {
        kind: AUDIT_KIND.taxonomyDelete,
        slug: row.slug,
        name: row.name,
        detached_post_count: detachedPostCount,
      } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    const tags = tagsForTaxonomyDelete('tag', row.slug).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(null, { status: 204 })
})
