import 'server-only'
import { sql } from 'drizzle-orm'
import type { Tx } from '@/db/client'
import { HttpError } from '@/lib/auth/requireRole'

// Shared post-trash core (F6). The SAME soft-delete sequence is needed by both
// the single-post DELETE (app/api/cms/posts/[id]/route.ts) and the bulk trash
// (app/api/cms/posts/bulk/route.ts doTrashOne). Extracting it here keeps the two
// byte-equivalent so a future change to trash semantics (the body-page coupling,
// the slug_redirects cleanup) can't drift between the two paths.
//
// What this helper owns (inside the CALLER's transaction, FOR-UPDATE-locked):
//   1. Soft-delete the post (deleted_at = NOW(3), updated_by).
//   2. Couple the hidden body page (spec §4.5): soft-delete it too + bump its
//      preview_epoch (invalidate any leaked preview token). Scoped to
//      kind='post_body' as defence in depth so it can ONLY ever touch a body
//      page, never a normal page.
//   3. Clean BOTH directions of slug_redirects for this post's slug so a
//      renamed-then-deleted post leaves no dangling 308→404 cascade.
//
// What it deliberately does NOT own (caller-specific, left in each route):
//   • the audit_log row (single vs bulk write a different AUDIT_KIND shape)
//   • cache-tag accumulation / revalidate enqueue (single enqueues per request;
//     bulk accumulates across the batch and enqueues once)
//
// The caller must have already SELECT … FOR UPDATE'd the post row (to lock it +
// read its slug/body_page_id) and pass those values in — this helper does the
// writes only, so it never re-reads or re-locks.

export interface TrashPostInput {
  /** The post id being trashed. */
  id: number
  /** The acting user id (stamped into updated_by on both the post + body page). */
  userId: number
  /** The post's current slug (already read under the caller's FOR UPDATE lock).
   *  Used for the bidirectional slug_redirects cleanup. */
  slug: string
  /** The post's body_page_id (NULL for a post whose body never moved onto the
   *  block engine). When set, the hidden body page is coupled-soft-deleted. */
  bodyPageId: number | null
}

/**
 * Run the shared post-trash writes inside the caller's transaction. Assumes the
 * post row is already locked (FOR UPDATE) by the caller. Performs no reads of its
 * own — every value it needs is passed in via {@link TrashPostInput}.
 */
export async function trashPostInTx(tx: Tx, input: TrashPostInput): Promise<void> {
  const { id, userId, slug, bodyPageId } = input
  if (!Number.isInteger(id) || id <= 0) {
    // Defensive: the routes parse/validate the id before reaching here; a
    // non-positive id slipping in would scope the UPDATE to a bogus row.
    throw new HttpError(400, 'invalid_id')
  }

  await tx.execute(sql`
    UPDATE posts
    SET deleted_at = NOW(3),
        updated_by = ${userId}
    WHERE id = ${id}
  `)

  // Couple the hidden body page's lifecycle to the post (spec §4.5): soft-delete
  // it too so its block tree can't be edited while the post sits in trash (the
  // block-CRUD routes filter pages.deleted_at IS NULL). The body page is already
  // unreachable everywhere, but coupling keeps the lifecycle consistent + safe.
  // Scoped to kind='post_body' as defence in depth so this can only ever touch a
  // body page, never a normal page. preview_epoch bump invalidates any
  // (theoretical) leaked preview token, mirroring the page DELETE path.
  if (bodyPageId !== null) {
    await tx.execute(sql`
      UPDATE pages
      SET deleted_at = NOW(3),
          preview_epoch = preview_epoch + 1,
          updated_by = ${userId}
      WHERE id = ${bodyPageId}
        AND kind = 'post_body'
        AND deleted_at IS NULL
    `)
  }

  // Clean any slug_redirects pointing AT or FROM this post's slug so a renamed-
  // then-deleted post doesn't leave dangling 308→404 cascades for crawlers
  // hitting the old URL. Both directions: rows that USED to redirect to this
  // slug, and any row that lists this slug as new (shouldn't exist if the chain-
  // collapse step worked, but is safe to clean either way).
  await tx.execute(sql`
    DELETE FROM slug_redirects
    WHERE resource_type = 'post'
      AND (new_slug = ${slug} OR old_slug = ${slug})
  `)
}
