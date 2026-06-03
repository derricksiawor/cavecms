import 'server-only'
import { sql } from 'drizzle-orm'
import type { Tx } from '@/db/client'
import { parseAndSanitize } from './parse'

// Shared helper: create the HIDDEN "body page" that owns a post's body
// as a content_blocks tree (spec §4). A post's body is a `pages` row
// marked kind='post_body' whose block tree IS the body; posts.body_page_id
// links to it. This reuses the entire existing block engine (hydratePage,
// every block renderer, the block-CRUD APIs, the inline-edit drawer)
// WITHOUT modifying those page_id-keyed paths.
//
// One TX-scoped helper, used by BOTH:
//   • POST /api/cms/posts (create-draft) — same TX as the posts INSERT,
//     so a post and its body page land atomically.
//   • lib/cms/migratePostsToBlocks.ts (backfill) — one TX per post,
//     converting body_md → an lx_richtext block.
//
// The body page is NEVER resolved by slug (the slug is a non-routable
// internal sentinel `__post-body-<id>`, only present to satisfy the
// pages.slug UNIQUE constraint). It is hidden from every page-surfacing
// consumer via the kind='post_body' filter (spec §4.4 guard checklist).
//
// The seeded body block is an `lx_richtext` widget — the reuse decision
// (spec §4.6 / verified at implementation): the lx_text `body_richtext`
// DOMPurify allowlist is inline+lists only (no h2/blockquote/pre/img/hr),
// so a single lx_text block cannot hold a full post body faithfully.
// lx_richtext stores the markdown source as plain text and renders it
// via renderMarkdownSync's sanitize pipeline (which permits the full
// block-level markdown set), so headings / code / quotes / images / rules
// survive the migration.

/** The non-routable internal slug for a post's body page. Unique per
 *  post id; never resolved by slug. The `__` prefix + `post-body`
 *  segment make it visually unmistakable in the DB / audit trail. */
function bodyPageSlug(postId: number): string {
  return `__post-body-${postId}`
}

/**
 * Inserts the hidden body page + its single seed lx_richtext block inside
 * the GIVEN transaction, and returns the new page id. The caller is
 * responsible for setting posts.body_page_id to the returned value (the
 * create route does it in the same TX; the backfill does it per post).
 *
 * `markdown` is the post body's markdown source (empty string for a fresh
 * draft; the migrated body_md for a backfill). It is run through
 * parseAndSanitize('lx_richtext', …) — the SAME write boundary every
 * block goes through — so the stored block is byte-identical to one an
 * operator would author, and the bidi/zero-width display-spoof gate +
 * length cap apply. (The markdown is plain text, NOT a RICHTEXT_FIELD, so
 * parseAndSanitize does NOT DOMPurify-strip it — sanitization happens at
 * render via renderMarkdownSync.)
 *
 * The body page is published=0 / system=0 / is_home=0; its published
 * state is irrelevant because it is never routed by slug — hydratePage
 * reads its blocks regardless of the page's published flag.
 *
 * `deletedAt` (F8): when migrating a post that is ALREADY trashed
 * (posts.deleted_at set), the body page must be born trashed too so the §4.5
 * lockstep holds — otherwise the backfill would create a LIVE body page for a
 * dead post, leaving an editable orphan tree. Defaults to null (live) for the
 * create-draft path + every live post in the backfill. The value is the post's
 * deleted_at as returned by mysql2 (Date or ISO string); a falsy value keeps the
 * body page live.
 */
export async function insertPostBodyPage(
  tx: Tx,
  args: {
    postId: number
    title: string
    markdown: string
    deletedAt?: Date | string | null
  },
): Promise<number> {
  // Validate + normalise the seed block through the standard write
  // boundary BEFORE any INSERT (validate-before-write — a bad payload
  // aborts cleanly, no half-tree). For an empty draft this yields the
  // schema defaults ({ markdown: '', tone: 'obsidian', maxWidth: 'wide',
  // animation: 'none' }).
  const blockData = parseAndSanitize('lx_richtext', { markdown: args.markdown })
  const blockJson = JSON.stringify(blockData)

  // INSERT the hidden body page. kind='post_body' is the discriminator
  // every page-surfacing query filters out (spec §4.4). The slug is the
  // non-routable sentinel; it satisfies the UNIQUE constraint and is
  // never used to resolve the page.
  //
  // deleted_at (F8): born trashed IFF the post being migrated is already
  // trashed, so the §4.5 lockstep holds. Normalised to a Date the driver binds
  // as DATETIME(3); a falsy value → NULL (live), the default for create-draft +
  // every live post. We stamp the post's OWN deleted_at (not NOW(3)) so the two
  // timestamps match exactly, mirroring the trash path's coupled write.
  let deletedAt: Date | null = null
  if (args.deletedAt) {
    const d =
      args.deletedAt instanceof Date ? args.deletedAt : new Date(args.deletedAt)
    // A NaN date (corrupt cell) would make mysql2 bind garbage — fall back to
    // null (a live body page) rather than crash the backfill batch.
    if (!Number.isNaN(d.getTime())) deletedAt = d
  }
  const [pageRes] = (await tx.execute(sql`
    INSERT INTO pages
      (slug, title, is_home, system, kind, published, published_at, deleted_at, version)
    VALUES (
      ${bodyPageSlug(args.postId)}, ${args.title}, 0, 0, 'post_body', 0, NULL, ${deletedAt}, 0
    )
  `)) as unknown as [{ insertId: number }]
  const pageId = Number(pageRes.insertId)

  // Seed ONE lx_richtext widget at the top level (kind='widget',
  // parent_id NULL — a loose top-level widget, the same shape a page with
  // no sections uses). position 1000 mirrors the seed spacing elsewhere.
  // No meta. The block engine + every renderer + the inline-edit drawer
  // operate on this row by page_id exactly as for any normal page.
  await tx.execute(sql`
    INSERT INTO content_blocks
      (page_id, parent_id, kind, block_key, block_type, position, data, meta, version, updated_by)
    VALUES (
      ${pageId}, NULL, 'widget', NULL, 'lx_richtext', 1000, ${blockJson}, NULL, 0, NULL
    )
  `)

  return pageId
}
