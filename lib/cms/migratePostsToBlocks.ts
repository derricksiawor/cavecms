import 'server-only'
import { sql } from 'drizzle-orm'
import { ZodError } from 'zod'
import { db } from '@/db/client'
import { insertPostBodyPage } from './postBodyPage'

// Engine for the posts → CMS-blocks backfill (spec §12). For each post
// whose body has NOT yet moved onto the block engine (body_page_id IS
// NULL), create a hidden body page (kind='post_body') + one lx_richtext
// block holding the post's markdown (converted from body_md), then set
// posts.body_page_id. Mirrors lib/cms/migrateProjectsToBlocks.ts:
// per-post, one transaction, validate-before-write (the block payload is
// parsed through parseAndSanitize inside insertPostBodyPage before any
// INSERT, so a post either lands whole or not at all).
//
// IDEMPOTENT: a post that already has body_page_id set is SKIPPED, so
// re-running is safe (the customer-install auto-migration runs it on
// every boot after an update). body_md is NEVER dropped — it stays as
// the deprecated reversibility fallback (spec §12 rollback); the detail
// route falls back to renderMarkdown(body_md) for any post still NULL.
//
// Used by both the dev/publisher CLI (scripts/migrate-posts-to-blocks.ts)
// and the customer-install auto-migration (lib/cms/runPostsBackfillOnce.ts,
// wired into instrumentation.ts boot).

export interface PostMigrationOutcome {
  postId: number
  slug: string
  status: 'migrated' | 'skipped' | 'failed'
  /** Machine reason for skip/fail (e.g. 'already_linked',
   *  'body_too_large', 'unexpected_error'). */
  reason?: string
  /** Extra detail when known (e.g. the Zod path that failed). */
  detail?: string
  bodyPageId?: number
}

export interface PostsMigrationReport {
  total: number
  migrated: number
  skipped: number
  failed: number
  outcomes: PostMigrationOutcome[]
}

export interface MigratePostsOpts {
  /** Optional cap — migrate at most N posts (test convenience). */
  limit?: number
  /** Optional structured logger; one call per post outcome so the
   *  customer-install updater can stream progress. */
  onOutcome?: (o: PostMigrationOutcome) => void
}

interface PostRow {
  id: number
  slug: string
  title: string
  body_md: string
  body_page_id: number | null
}

function zodDetail(err: unknown): string | undefined {
  if (err instanceof ZodError) {
    const issue = err.issues[0]
    const path = issue?.path?.join('.') ?? ''
    return path ? `lx_richtext.${path}` : 'lx_richtext'
  }
  return undefined
}

async function migrateOne(post: PostRow): Promise<PostMigrationOutcome> {
  const base = { postId: post.id, slug: post.slug }
  try {
    const out = await db.transaction(async (tx) => {
      // Re-read body_page_id under FOR UPDATE so a concurrent backfill
      // (clustered PM2 boot) or an interleaved create can't double-create
      // a body page for the same post. ANY non-null value means another
      // path already linked it → SKIP.
      const [rows] = (await tx.execute(sql`
        SELECT id, title, body_md, body_page_id
        FROM posts
        WHERE id = ${post.id}
        FOR UPDATE
      `)) as unknown as [
        Array<{
          id: number
          title: string
          body_md: string
          body_page_id: number | null
        }>,
      ]
      const row = rows[0]
      if (!row) return { kind: 'skip' as const, reason: 'post_missing' }
      if (row.body_page_id !== null) {
        return { kind: 'skip' as const, reason: 'already_linked' }
      }

      // Create the body page + seed the lx_richtext block from body_md,
      // then link. insertPostBodyPage validates the block payload through
      // parseAndSanitize BEFORE any INSERT, so a body that fails the
      // length cap / bidi gate aborts this TX cleanly (rolled back, post
      // left NULL for a retry or a manual fix).
      const bodyPageId = await insertPostBodyPage(tx, {
        postId: row.id,
        title: row.title,
        markdown: row.body_md ?? '',
      })
      await tx.execute(sql`
        UPDATE posts SET body_page_id = ${bodyPageId} WHERE id = ${row.id}
      `)
      return { kind: 'migrated' as const, bodyPageId }
    })

    if (out.kind === 'skip') {
      return { ...base, status: 'skipped', reason: out.reason }
    }
    return { ...base, status: 'migrated', bodyPageId: out.bodyPageId }
  } catch (err) {
    // A Zod failure here means the body_md exceeded the lx_richtext cap
    // or carried bidi/zero-width chars the gate rejects — report so an
    // operator can fix the offending post; the batch continues.
    if (err instanceof ZodError) {
      return {
        ...base,
        status: 'failed',
        reason: 'block_validation_failed',
        detail: zodDetail(err),
      }
    }
    return {
      ...base,
      status: 'failed',
      reason: 'unexpected_error',
      detail: err instanceof Error ? err.name : 'unknown',
    }
  }
}

export async function migratePostsToBlocks(
  opts: MigratePostsOpts = {},
): Promise<PostsMigrationReport> {
  // Only posts NOT yet linked. Include soft-deleted posts: their body
  // page is created too (unreachable, but it keeps the post fully
  // migrated so a later restore renders via the block path). ORDER BY id
  // for deterministic progress.
  const [postRows] = (await db.execute(sql`
    SELECT id, slug, title, body_md, body_page_id
    FROM posts
    WHERE body_page_id IS NULL
    ORDER BY id
  `)) as unknown as [PostRow[]]

  const posts =
    typeof opts.limit === 'number' ? postRows.slice(0, opts.limit) : postRows

  const outcomes: PostMigrationOutcome[] = []
  for (const p of posts) {
    const outcome = await migrateOne(p)
    outcomes.push(outcome)
    if (opts.onOutcome) opts.onOutcome(outcome)
  }

  return {
    total: outcomes.length,
    migrated: outcomes.filter((o) => o.status === 'migrated').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
  }
}
