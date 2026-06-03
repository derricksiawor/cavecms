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
import { tagsForTaxonomyCreate } from '@/lib/cache/tags'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { SLUG_RE, SLUG_MIN } from '@/lib/cms/slug'
import { validateTermSlug } from '@/lib/cms/taxonomy-slug'

// Category slug + name caps mirror the DB column widths (varchar(120) /
// varchar(120) / varchar(320) for description).
const SLUG_MAX = 120
const NAME_MAX = 120
const DESC_MAX = 320

const CreateBody = z
  .object({
    name: z.string().min(1).max(NAME_MAX),
    slug: z
      .string()
      .min(SLUG_MIN)
      .max(SLUG_MAX)
      .regex(SLUG_RE, 'slug_invalid_format'),
    description: z.string().max(DESC_MAX).nullable().optional(),
    // One-level hierarchy: a parent category id. Validated to exist + to not
    // be self / to not itself have a parent (depth cap) inside the TX.
    parentId: z.number().int().positive().nullable().optional(),
  })
  .strict()

interface InsertResult {
  insertId: number
}

// POST creates a category. admin + editor (mirrors the post create policy —
// publishing/visibility is not a concern for taxonomy terms, so no admin-only
// split). The slug is validated against the canonical slug contract PLUS the
// taxonomy reserved set so it can't shadow /blog/feed, /blog/category, etc.
export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = CreateBody.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)

  // Term-slug validation — canonical rules + taxonomy reserved set. Public
  // code collapses every granular reason to `slug_invalid` (no enumeration).
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

  try {
    const txResult = await db.transaction(async (tx) => {
      // Resolve + bound the parent. Must exist, must not be self (no row yet,
      // so self is impossible at create — but the depth guard matters): a
      // parent that ITSELF has a parent would create a 2-level chain, which
      // the spec's one-level hierarchy forbids. Reject with 422.
      let parentId: number | null = null
      if (body.parentId != null) {
        const [prows] = (await tx.execute(sql`
          SELECT id, parent_id FROM categories WHERE id = ${body.parentId}
        `)) as unknown as [Array<{ id: number; parent_id: number | null }>]
        const parent = prows[0]
        if (!parent) throw new HttpError(422, 'parent_not_found')
        if (parent.parent_id !== null) {
          throw new HttpError(422, 'parent_too_deep')
        }
        parentId = parent.id
      }

      // position: append after the current max within the same parent scope
      // so a new sibling sorts last. NULL-parent and a specific-parent scope
      // each get their own append sequence.
      const [posRows] = (await tx.execute(sql`
        SELECT COALESCE(MAX(position), -1) + 1 AS next_pos
        FROM categories
        WHERE ${parentId === null ? sql`parent_id IS NULL` : sql`parent_id = ${parentId}`}
      `)) as unknown as [Array<{ next_pos: number | string }>]
      const position = Number(posRows[0]?.next_pos ?? 0)

      const [insertArr] = (await tx.execute(sql`
        INSERT INTO categories (slug, name, description, parent_id, position, version, updated_by)
        VALUES (${body.slug}, ${body.name}, ${body.description ?? null},
                ${parentId}, ${position}, 0, ${ctx.userId})
      `)) as unknown as [InsertResult]
      const id = Number(insertArr.insertId)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'create',
        resourceType: 'category',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.taxonomyCreate,
          data: { slug: body.slug, name: body.name, parent_id: parentId },
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      const tags = tagsForTaxonomyCreate().tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return { id, slug: body.slug, queueRowId, tags }
    })

    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId, txResult.tags)
    })

    return new Response(
      JSON.stringify({ id: txResult.id, slug: txResult.slug }),
      {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      },
    )
  } catch (err: unknown) {
    if (isDuplicateKey(err)) throw new HttpError(409, 'slug_taken')
    throw err
  }
})

interface CategoryListRow {
  id: number
  slug: string
  name: string
  description: string | null
  parent_id: number | null
  position: number
  version: number
  post_count: number | string
}

// GET serves the admin taxonomy list (categories). admin + editor + viewer see
// the same rows. `post_count` is a correlated COUNT over the junction so the
// admin UI can show "N posts" + warn before deleting a populated term. Ordered
// by the hierarchy (parents first, then children under each parent) via
// (COALESCE(parent_id, id), parent_id IS NOT NULL, position) so the one-level
// tree renders in a stable, readable order. Hard cap 1000 — taxonomy is small.
export const GET = withError(async () => {
  await requireRole(['admin', 'editor', 'viewer'])

  const [rows] = (await db.execute(sql`
    SELECT c.id, c.slug, c.name, c.description, c.parent_id, c.position, c.version,
           (SELECT COUNT(*) FROM post_categories pc WHERE pc.category_id = c.id) AS post_count
    FROM categories c
    ORDER BY COALESCE(c.parent_id, c.id), (c.parent_id IS NOT NULL), c.position, c.id
    LIMIT 1000
  `)) as unknown as [CategoryListRow[]]

  const items = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    parentId: r.parent_id,
    position: r.position,
    version: r.version,
    postCount: Number(r.post_count ?? 0),
  }))

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
