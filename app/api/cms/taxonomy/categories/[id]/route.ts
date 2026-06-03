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
const DESC_MAX = 320

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

const PatchBody = z
  .object({
    name: z.string().min(1).max(NAME_MAX).optional(),
    slug: z
      .string()
      .min(SLUG_MIN)
      .max(SLUG_MAX)
      .regex(SLUG_RE, 'slug_invalid_format')
      .optional(),
    description: z.string().max(DESC_MAX).nullable().optional(),
    // null clears the parent (promote to top level). A positive id re-parents
    // (validated for existence + depth in the TX). Omitted = leave unchanged.
    parentId: z.number().int().positive().nullable().optional(),
    version: z.number().int().nonnegative(),
  })
  .strict()

interface CategoryRow {
  id: number
  slug: string
  name: string
  description: string | null
  parent_id: number | null
  version: number
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

  // Validate the slug BEFORE the TX when a rename is requested.
  if (body.slug !== undefined) {
    const slugCheck = validateTermSlug(body.slug, env.LOGIN_PATH)
    if (!slugCheck.ok) {
      console.info(
        JSON.stringify({
          level: 'info',
          msg: 'category_slug_validation_failed',
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
        SELECT id, slug, name, description, parent_id, version
        FROM categories WHERE id = ${id} FOR UPDATE
      `)) as unknown as [CategoryRow[]]
      const row = rows[0]
      if (!row) throw new HttpError(404, 'not_found')
      if (row.version !== body.version) {
        throw new HttpError(409, 'stale_version')
      }

      // Resolve the requested parent. `undefined` → leave as-is; `null` →
      // promote to top level; an id → re-parent with existence + depth + cycle
      // guards. A category that HAS children may not itself become a child
      // (that would make a 3-level chain) — reject 422.
      let nextParentId: number | null = row.parent_id
      if (body.parentId !== undefined) {
        if (body.parentId === null) {
          nextParentId = null
        } else {
          if (body.parentId === id) throw new HttpError(422, 'parent_self')
          const [prows] = (await tx.execute(sql`
            SELECT id, parent_id FROM categories WHERE id = ${body.parentId}
          `)) as unknown as [
            Array<{ id: number; parent_id: number | null }>,
          ]
          const parent = prows[0]
          if (!parent) throw new HttpError(422, 'parent_not_found')
          if (parent.parent_id !== null) {
            throw new HttpError(422, 'parent_too_deep')
          }
          // This row can't gain a parent if it itself is a parent of others.
          const [childRows] = (await tx.execute(sql`
            SELECT 1 FROM categories WHERE parent_id = ${id} LIMIT 1
          `)) as unknown as [Array<{ '1': number }>]
          if (childRows.length > 0) {
            throw new HttpError(422, 'has_children')
          }
          nextParentId = parent.id
        }
      }

      const slugChanged = body.slug !== undefined && body.slug !== row.slug
      slugChangedOuter = slugChanged
      const nextSlug = body.slug ?? row.slug
      const nextName = body.name ?? row.name
      const nextDescription =
        body.description === undefined ? row.description : body.description

      const nothingChanged =
        nextSlug === row.slug &&
        nextName === row.name &&
        nextDescription === row.description &&
        nextParentId === row.parent_id
      if (nothingChanged) {
        return {
          newVersion: row.version,
          queueRowId: null as number | null,
          tags: [] as string[],
        }
      }

      await tx.execute(sql`
        UPDATE categories
        SET slug = ${nextSlug},
            name = ${nextName},
            description = ${nextDescription},
            parent_id = ${nextParentId},
            version = version + 1,
            updated_by = ${ctx.userId}
        WHERE id = ${id}
      `)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'update',
        resourceType: 'category',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.taxonomyUpdate,
          from: {
            slug: row.slug,
            name: row.name,
            description: row.description,
            parent_id: row.parent_id,
          },
          to: {
            slug: nextSlug,
            name: nextName,
            description: nextDescription,
            parent_id: nextParentId,
          },
          slugChanged,
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      const tags = tagsForTaxonomyUpdate('category', nextSlug, {
        slugChanged,
        oldSlug: slugChanged ? row.slug : undefined,
      }).tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return { newVersion: row.version + 1, queueRowId, tags }
    })

    if (txResult.queueRowId !== null) {
      const rowId = txResult.queueRowId
      const tags = txResult.tags
      queueMicrotask(() => {
        void drainRevalidate(rowId, tags)
      })
    }

    return new Response(
      JSON.stringify({ ok: true, version: txResult.newVersion }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      },
    )
  } catch (err: unknown) {
    if (isDuplicateKey(err)) {
      throw new HttpError(409, slugChangedOuter ? 'slug_taken' : 'conflict')
    }
    throw err
  }
})

// DELETE removes a category. SAFE BY DESIGN: the post_categories FK is
// ON DELETE CASCADE, so deleting the term removes ONLY its junction rows — the
// posts themselves are untouched (no post is orphaned or deleted). The
// categories.parent_id self-FK is ON DELETE SET NULL, so any child categories
// are promoted to top-level rather than cascade-deleted. Admin-only (a
// destructive structural op). Hard delete (taxonomy has no soft-delete/trash —
// terms are cheap to recreate and carry no editorial history).
export const DELETE = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const meta = auditMetaFromRequest(req)

  const txResult = await db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, slug, name FROM categories WHERE id = ${id} FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; name: string }>]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    // Count attached posts purely for the audit trail — confirms the
    // cascade scope (these junction rows vanish; the posts survive).
    const [cntRows] = (await tx.execute(sql`
      SELECT COUNT(*) AS n FROM post_categories WHERE category_id = ${id}
    `)) as unknown as [Array<{ n: number | string }>]
    const detachedPostCount = Number(cntRows[0]?.n ?? 0)

    // The DELETE cascades post_categories (junction) and SET-NULLs child
    // categories' parent_id — both enforced at the FK layer (migration 0032).
    await tx.execute(sql`DELETE FROM categories WHERE id = ${id}`)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'delete',
      resourceType: 'category',
      resourceId: String(id),
      diff: {
        kind: AUDIT_KIND.taxonomyDelete,
        slug: row.slug,
        name: row.name,
        // The junction rows removed by the cascade — posts themselves survive.
        detached_post_count: detachedPostCount,
      } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    const tags = tagsForTaxonomyDelete('category', row.slug).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(null, { status: 204 })
})
