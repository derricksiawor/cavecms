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

const SLUG_MAX = 120
const NAME_MAX = 120

const CreateBody = z
  .object({
    name: z.string().min(1).max(NAME_MAX),
    slug: z
      .string()
      .min(SLUG_MIN)
      .max(SLUG_MAX)
      .regex(SLUG_RE, 'slug_invalid_format'),
  })
  .strict()

interface InsertResult {
  insertId: number
}

// POST creates a tag. Tags are flat free-form terms (no hierarchy, no version,
// no description) — the simplest taxonomy. Slug validated against the canonical
// contract + taxonomy reserved set. admin + editor (mirrors post create).
export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = CreateBody.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)

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

  try {
    const txResult = await db.transaction(async (tx) => {
      const [insertArr] = (await tx.execute(sql`
        INSERT INTO tags (slug, name, updated_by)
        VALUES (${body.slug}, ${body.name}, ${ctx.userId})
      `)) as unknown as [InsertResult]
      const id = Number(insertArr.insertId)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'create',
        resourceType: 'tag',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.taxonomyCreate,
          data: { slug: body.slug, name: body.name },
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

interface TagListRow {
  id: number
  slug: string
  name: string
  post_count: number | string
}

// GET serves the admin taxonomy list (tags). Ordered by name; `post_count`
// per the correlated junction COUNT. Hard cap 1000.
export const GET = withError(async () => {
  await requireRole(['admin', 'editor', 'viewer'])

  const [rows] = (await db.execute(sql`
    SELECT t.id, t.slug, t.name,
           (SELECT COUNT(*) FROM post_tags pt WHERE pt.tag_id = t.id) AS post_count
    FROM tags t
    ORDER BY t.name, t.id
    LIMIT 1000
  `)) as unknown as [TagListRow[]]

  const items = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
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
