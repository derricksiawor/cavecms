import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import {
  tagsForPostSave,
  tagsForPostDelete,
  tagsForPostTaxonomySync,
} from '@/lib/cache/tags'
import { syncPostTaxonomy, MAX_TERMS_PER_POST } from '@/lib/cms/syncPostTaxonomy'
import { trashPostInTx } from '@/lib/cms/trashPost'
import {
  BULK_POST_ACTIONS,
  type BulkPostAction,
  MAX_BULK_POST_IDS,
  normalizeBulkIds,
  roleCanRunBulkAction,
} from '@/lib/cms/bulkPostActions'

// POST /api/cms/posts/bulk — bulk publish / unpublish / trash / assign-category
// / add-tag for the /admin/blog list (spec §10). CSRF + per-action role gate +
// Zod + BOUNDED batch (≤ MAX_BULK_POST_IDS) + parameterized SQL + one audit row
// per affected post (shared requestId correlates a single bulk submit).
//
// Each post is processed in ITS OWN short transaction so one bad/locked/missing
// post doesn't roll back the whole batch — the response reports per-id failures
// (`failed: [{ id, reason }]`) so the operator sees exactly what didn't apply,
// matching the AdminTable bulk-bar's partial-failure toast. The publish/trash
// state-changing actions are admin-only; taxonomy assignment is editor+admin,
// mirroring the single-post route's gates.
//
// SEMANTICS
//   publish          — published=1, published_at = COALESCE(published_at, NOW(3))
//                      (publish now / preserve original; NEVER schedules — bulk
//                      scheduling is out of scope, the single editor schedules).
//   unpublish        — published=0 (published_at untouched, like the editor).
//   trash            — soft-delete (deleted_at=NOW), couple the hidden body page,
//                      clean slug_redirects — identical to the single DELETE.
//   assignCategories — ADD the given categories to each post (additive: the
//                      post's existing categories are preserved; already-present
//                      ones are a no-op). Same for addTags.

const BulkBody = z
  .object({
    action: z.enum(BULK_POST_ACTIONS),
    // Bounded at the schema layer too (defence in depth on top of
    // normalizeBulkIds' cap check). 1..MAX so an empty submit is a clean 400.
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_BULK_POST_IDS),
    // Taxonomy payload — required only for the assign actions (validated below).
    categoryIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_TERMS_PER_POST)
      .optional(),
    tagIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_TERMS_PER_POST)
      .optional(),
  })
  .strict()

type BulkBodyT = z.infer<typeof BulkBody>

interface PerPostFailure {
  id: number
  reason: string
}

// Tags collected across every affected post, deduped, enqueued ONCE after the
// batch so the bulk submit issues a single revalidate drain.
type TagAccumulator = Set<string>

// ── per-action, per-post executors (each in the caller's TX) ─────────────────

async function doPublishOne(
  tx: Tx,
  id: number,
  userId: number,
  meta: { ip: string | null; userAgent: string | null; requestId: string | null },
  tags: TagAccumulator,
): Promise<void> {
  const [rows] = (await tx.execute(sql`
    SELECT id, slug, published FROM posts
    WHERE id = ${id} AND deleted_at IS NULL
    FOR UPDATE
  `)) as unknown as [Array<{ id: number; slug: string; published: number }>]
  const row = rows[0]
  if (!row) throw new HttpError(404, 'not_found')
  // Already published → no-op (no version bump, no audit, no cache churn).
  if (row.published === 1) return

  await tx.execute(sql`
    UPDATE posts
    SET published = TRUE,
        published_at = COALESCE(published_at, NOW(3)),
        version = version + 1,
        updated_by = ${userId}
    WHERE id = ${id}
  `)
  await writeBulkAudit(tx, id, 'publish', row.slug, userId, meta)
  for (const t of tagsForPostSave(row.slug, { publishedChanged: true }).tags) {
    tags.add(t)
  }
}

async function doUnpublishOne(
  tx: Tx,
  id: number,
  userId: number,
  meta: { ip: string | null; userAgent: string | null; requestId: string | null },
  tags: TagAccumulator,
): Promise<void> {
  const [rows] = (await tx.execute(sql`
    SELECT id, slug, published FROM posts
    WHERE id = ${id} AND deleted_at IS NULL
    FOR UPDATE
  `)) as unknown as [Array<{ id: number; slug: string; published: number }>]
  const row = rows[0]
  if (!row) throw new HttpError(404, 'not_found')
  if (row.published === 0) return // already a draft → no-op

  await tx.execute(sql`
    UPDATE posts
    SET published = FALSE,
        version = version + 1,
        updated_by = ${userId}
    WHERE id = ${id}
  `)
  await writeBulkAudit(tx, id, 'unpublish', row.slug, userId, meta)
  for (const t of tagsForPostSave(row.slug, { publishedChanged: true }).tags) {
    tags.add(t)
  }
}

async function doTrashOne(
  tx: Tx,
  id: number,
  userId: number,
  meta: { ip: string | null; userAgent: string | null; requestId: string | null },
  tags: TagAccumulator,
): Promise<void> {
  // Mirror the single-post DELETE exactly via the shared trashPostInTx helper
  // (F6): lock + read the post here, then delegate the soft-delete + body-page
  // coupling + slug_redirects cleanup to the shared core.
  const [rows] = (await tx.execute(sql`
    SELECT id, slug, body_page_id FROM posts
    WHERE id = ${id} AND deleted_at IS NULL
    FOR UPDATE
  `)) as unknown as [
    Array<{ id: number; slug: string; body_page_id: number | null }>,
  ]
  const row = rows[0]
  if (!row) throw new HttpError(404, 'not_found')

  // Shared trash core (F6) — byte-equivalent to the single-post DELETE.
  await trashPostInTx(tx, {
    id,
    userId,
    slug: row.slug,
    bodyPageId: row.body_page_id,
  })
  await writeBulkAudit(tx, id, 'trash', row.slug, userId, meta)
  for (const t of tagsForPostDelete(row.slug).tags) tags.add(t)
}

async function doAssignTaxonomyOne(
  tx: Tx,
  id: number,
  action: 'assignCategories' | 'addTags',
  termIds: number[],
  userId: number,
  meta: { ip: string | null; userAgent: string | null; requestId: string | null },
  tags: TagAccumulator,
): Promise<void> {
  const [rows] = (await tx.execute(sql`
    SELECT id, slug FROM posts
    WHERE id = ${id} AND deleted_at IS NULL
    FOR UPDATE
  `)) as unknown as [Array<{ id: number; slug: string }>]
  const row = rows[0]
  if (!row) throw new HttpError(404, 'not_found')

  // Additive: union the post's CURRENT ids of this axis with the requested
  // ids, then sync to that union. syncPostTaxonomy diffs against the live set,
  // so already-present terms touch zero rows; only genuinely-new ones insert.
  // This never wipes a post's OTHER terms (the other axis is left untouched by
  // passing undefined for it).
  const junctionTable =
    action === 'assignCategories' ? 'post_categories' : 'post_tags'
  const fkCol = action === 'assignCategories' ? 'category_id' : 'tag_id'
  const [curRows] = (await tx.execute(sql`
    SELECT ${sql.raw(fkCol)} AS id
    FROM ${sql.raw(junctionTable)}
    WHERE post_id = ${id}
  `)) as unknown as [Array<{ id: number }>]
  const union = new Set<number>(curRows.map((r) => r.id))
  for (const t of termIds) union.add(t)

  const taxResult = await syncPostTaxonomy(tx, {
    postId: id,
    categoryIds: action === 'assignCategories' ? [...union] : undefined,
    tagIds: action === 'addTags' ? [...union] : undefined,
  })
  const changed =
    taxResult.changedCategorySlugs.length > 0 ||
    taxResult.changedTagSlugs.length > 0
  // No genuinely-new term for this post → no-op (everything was already
  // assigned). Skip the audit + cache churn.
  if (!changed) return

  await writeBulkAudit(tx, id, action, row.slug, userId, meta, {
    category_ids: taxResult.finalCategoryIds,
    tag_ids: taxResult.finalTagIds,
    changed_category_slugs: taxResult.changedCategorySlugs,
    changed_tag_slugs: taxResult.changedTagSlugs,
  })
  for (const t of tagsForPostTaxonomySync(row.slug, {
    categorySlugs: taxResult.changedCategorySlugs,
    tagSlugs: taxResult.changedTagSlugs,
  }).tags) {
    tags.add(t)
  }
}

async function writeBulkAudit(
  tx: Tx,
  id: number,
  action: BulkPostAction,
  slug: string,
  userId: number,
  meta: { ip: string | null; userAgent: string | null; requestId: string | null },
  extra?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({
    userId,
    action: 'update',
    resourceType: 'post',
    resourceId: String(id),
    diff: {
      kind: AUDIT_KIND.bulkPost,
      action,
      slug,
      ...(extra ?? {}),
    } as unknown as object,
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  })
}

export const POST = withError(async (req) => {
  // Auth FIRST (any admin surface role), then parse, then per-action role gate.
  // We gate to the broadest set here so an editor's CSRF + rate-limit are
  // enforced before the 403 — but the action-specific role check below is the
  // real authorization boundary.
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body: BulkBodyT = BulkBody.parse(await readJsonBody(req))
  const action = body.action as BulkPostAction

  // Per-action role gate (publish/unpublish/trash = admin; assign* = editor+).
  if (!roleCanRunBulkAction(action, ctx.role)) {
    throw new HttpError(403, 'forbidden')
  }

  // Re-normalise (de-dupe + bound) — defence in depth over the Zod schema.
  const { ids, tooMany } = normalizeBulkIds(body.ids)
  if (tooMany) throw new HttpError(400, 'too_many_ids')
  if (ids.length === 0) throw new HttpError(400, 'no_valid_ids')

  // Taxonomy actions require their payload.
  let termIds: number[] = []
  if (action === 'assignCategories') {
    if (!body.categoryIds || body.categoryIds.length === 0) {
      throw new HttpError(400, 'missing_category_ids')
    }
    termIds = body.categoryIds
  } else if (action === 'addTags') {
    if (!body.tagIds || body.tagIds.length === 0) {
      throw new HttpError(400, 'missing_tag_ids')
    }
    termIds = body.tagIds
  }

  const meta = auditMetaFromRequest(req)
  const tags: TagAccumulator = new Set<string>()
  const failed: PerPostFailure[] = []
  let ok = 0

  // Process each post in its own short TX so a single failure is isolated.
  for (const id of ids) {
    try {
      await db.transaction(async (tx) => {
        if (action === 'publish') {
          await doPublishOne(tx, id, ctx.userId, meta, tags)
        } else if (action === 'unpublish') {
          await doUnpublishOne(tx, id, ctx.userId, meta, tags)
        } else if (action === 'trash') {
          await doTrashOne(tx, id, ctx.userId, meta, tags)
        } else {
          await doAssignTaxonomyOne(
            tx,
            id,
            action,
            termIds,
            ctx.userId,
            meta,
            tags,
          )
        }
      })
      ok++
    } catch (err) {
      const reason =
        err instanceof HttpError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'unknown_error'
      failed.push({ id, reason })
    }
  }

  // Enqueue the deduped tag set ONCE (only when something actually changed).
  if (tags.size > 0) {
    const finalTags = [...tags]
    const queueRowId = await db.transaction(async (tx) =>
      enqueueRevalidate(tx, finalTags),
    )
    queueMicrotask(() => {
      void drainRevalidate(queueRowId, finalTags)
    })
  }

  return new Response(JSON.stringify({ ok, failed, action }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
