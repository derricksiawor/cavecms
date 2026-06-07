import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { tagsForPostCreate } from '@/lib/cache/tags'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'

import { SLUG_RE, SLUG_MAX } from '@/lib/cms/slug'
import { TAXONOMY_RESERVED } from '@/lib/cms/taxonomy-slug'
import { insertPostBodyPage } from '@/lib/cms/postBodyPage'
import {
  syncPostTaxonomy,
  MAX_TERMS_PER_POST,
} from '@/lib/cms/syncPostTaxonomy'

const CreateBody = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(SLUG_MAX)
      .regex(SLUG_RE, 'slug_invalid_format')
      // Reject the words that name /blog sub-paths (category/tag/feed/page):
      // a post slug equal to one would shadow the archive/feed namespace
      // under /blog. Mirrors validateTermSlug's taxonomy-reserved guard.
      .refine((s) => !TAXONOMY_RESERVED.has(s.toLowerCase()), 'slug_reserved'),
    title: z.string().min(1).max(220),
    // Optional taxonomy assignment at create. Each is a bounded list of
    // existing category/tag ids; syncPostTaxonomy validates they exist + wires
    // the junctions in the same TX. Omitted → no terms (the common case).
    categoryIds: z.array(z.number().int().positive()).max(MAX_TERMS_PER_POST).optional(),
    tagIds: z.array(z.number().int().positive()).max(MAX_TERMS_PER_POST).optional(),
  })
  .strict()

interface InsertResult {
  insertId: number
}

// POST creates a draft post. Both admin and editor can create —
// publishing is admin-gated separately on PATCH. Body_md starts as
// empty string (the editor fills it in subsequent PATCHes). Pre-
// cleans any stale slug_redirects row whose old_slug equals the
// new slug, mirroring the projects POST: without this, recycling a
// retired slug would land visitors on the rename target via 308
// before they ever see the new post.
export const POST = withError(async (req) => {
  const ctx = await requireRole(adminPolicy('createPost'))
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'posts', 'write')
  checkCmsMutationRate(ctx)

  // Parse with safeParse so the slug-specific refine/regex failures surface as
  // PRECISE error codes the client can map to an actionable message. withError
  // flattens every raw ZodError to the generic `invalid_request` (which the
  // form would render as "try again in a moment" — implying a transient fault),
  // so a reserved/malformed slug would otherwise look retryable. Throwing a
  // typed HttpError with the refine's own code keeps the message honest while
  // still letting genuinely-unexpected shape errors fall through to the generic
  // 400. Mirrors the precise `slug_taken` 409 the duplicate-key path already
  // returns.
  const parsed = CreateBody.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    const slugIssue = parsed.error.issues.find((i) => i.path[0] === 'slug')
    if (slugIssue?.message === 'slug_reserved') {
      throw new HttpError(400, 'slug_reserved')
    }
    if (slugIssue?.message === 'slug_invalid_format') {
      throw new HttpError(400, 'slug_invalid_format')
    }
    throw parsed.error
  }
  const body = parsed.data
  const meta = auditMetaFromRequest(req)

  try {
    const txResult = await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM slug_redirects
        WHERE resource_type = 'post' AND old_slug = ${body.slug}
      `)

      const [insertArr] = (await tx.execute(sql`
        INSERT INTO posts (slug, title, body_md, author_id, version)
        VALUES (${body.slug}, ${body.title}, '', ${ctx.userId}, 0)
      `)) as unknown as [InsertResult]
      const postId = Number(insertArr.insertId)

      // Create the hidden body page (kind='post_body') + seed one empty
      // lx_richtext block, then link posts.body_page_id — all in THIS TX
      // so a post and its body page land atomically (spec §4.1). The
      // body is edited via the existing block engine pointed at this
      // body page id; body_md stays '' as the deprecated fallback until
      // a later release drops it.
      const bodyPageId = await insertPostBodyPage(tx, {
        postId,
        title: body.title,
        markdown: '',
      })
      await tx.execute(sql`
        UPDATE posts SET body_page_id = ${bodyPageId} WHERE id = ${postId}
      `)

      // Wire any taxonomy passed at create. The junctions reference the new
      // post id (just inserted) so this is order-safe within the TX. Validates
      // every term id exists (clean 400 on a stale id). Empty/omitted → no-op.
      const taxResult =
        body.categoryIds !== undefined || body.tagIds !== undefined
          ? await syncPostTaxonomy(tx, {
              postId,
              categoryIds: body.categoryIds,
              tagIds: body.tagIds,
            })
          : null

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'create',
        resourceType: 'post',
        resourceId: String(postId),
        diff: {
          kind: AUDIT_KIND.create,
          data: {
            slug: body.slug,
            title: body.title,
            body_page_id: bodyPageId,
            category_ids: taxResult?.finalCategoryIds ?? [],
            tag_ids: taxResult?.finalTagIds ?? [],
          },
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      // Invalidate the bar's slug-resolver cache for this slug —
      // a pre-create probe would otherwise leave the Edit link
      // missing for up to 5 minutes after the operator hits Save.
      const tags = tagsForPostCreate(body.slug).tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return { insertId: postId, queueRowId, tags }
    })

    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId, txResult.tags)
    })

    return new Response(JSON.stringify({ id: txResult.insertId, slug: body.slug }), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (err: unknown) {
    if (isDuplicateKey(err)) throw new HttpError(409, 'slug_taken')
    throw err
  }
})

interface PostListRow {
  id: number
  slug: string
  title: string
  excerpt: string | null
  published: number
  published_at: Date | null
  deleted_at: Date | null
  updated_at: Date
}

// GET serves the admin posts list. Admins, editors, and viewers see
// the same rows. Pagination is intentionally absent — the BWP blog
// is small enough that a 50-row cap (newest first) covers the admin
// list UI without scroll virtualization.
export const GET = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  requireScope(ctx, 'posts', 'read')
  checkReadRate(ctx.userId)
  const url = new URL(req.url)
  const showArchived = url.searchParams.get('archived') === '1'

  const [rows] = (await db.execute(
    showArchived
      ? sql`
          SELECT id, slug, title, excerpt, published, published_at,
                 deleted_at, updated_at
          FROM posts
          ORDER BY updated_at DESC, id DESC
          LIMIT 50
        `
      : sql`
          SELECT id, slug, title, excerpt, published, published_at,
                 deleted_at, updated_at
          FROM posts
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC
          LIMIT 50
        `,
  )) as unknown as [PostListRow[]]

  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
