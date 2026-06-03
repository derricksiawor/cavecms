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
//
// SCALABILITY (F12): the production backfill (no `limit`) pages the un-migrated
// set by id-ASC keyset in BACKFILL_BATCH_SIZE-row batches and keeps running
// counters rather than a full per-post outcome array, so a blog with thousands
// of un-migrated bodies never loads them all into memory. The bounded `limit`
// path (test/contributor) fetches once.

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
  /** Retained outcomes for the run. To keep memory bounded on a production
   *  backfill of thousands of posts (F12), this holds ONLY the FAILED outcomes,
   *  capped at MAX_RETAINED_FAILURES — migrated/skipped outcomes are counted but
   *  NOT retained. Per-post visibility for any status is available live via
   *  `opts.onOutcome` (the CLI + boot wrapper stream every post through it). Both
   *  consumers only ever read `outcomes.filter(status==='failed')`, so capturing
   *  failures only is behaviour-preserving for them. */
  outcomes: PostMigrationOutcome[]
}

// Production backfill page size: migrate this many un-linked posts per index
// walk, then page forward by last-seen id (id-ASC keyset, like the cron-purge
// batched sweep) until none remain — so the full set of un-migrated bodies never
// loads into memory at once (F12). Each post still migrates in its OWN tx.
const BACKFILL_BATCH_SIZE = 500
// Cap on retained FAILED outcomes so a pathological run (thousands of un-
// migratable bodies) can't grow the report unboundedly. Both consumers slice to
// ≤ 20–all-failures for display; 200 is generous headroom for triage.
const MAX_RETAINED_FAILURES = 200

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
        SELECT id, title, body_md, body_page_id, deleted_at
        FROM posts
        WHERE id = ${post.id}
        FOR UPDATE
      `)) as unknown as [
        Array<{
          id: number
          title: string
          body_md: string
          body_page_id: number | null
          deleted_at: Date | string | null
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
      //
      // F8: pass the post's own deleted_at so an ALREADY-trashed legacy post's
      // body page is born trashed too (§4.5 lockstep) — never a live, editable
      // orphan tree for a dead post. Live posts pass null → live body page.
      const bodyPageId = await insertPostBodyPage(tx, {
        postId: row.id,
        title: row.title,
        markdown: row.body_md ?? '',
        deletedAt: row.deleted_at,
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
  // Running counters — we DON'T retain a per-post outcome array for the whole
  // run (F12); only failures are kept, capped, for the report. Live per-post
  // visibility is via opts.onOutcome.
  let total = 0
  let migrated = 0
  let skipped = 0
  let failed = 0
  const failures: PostMigrationOutcome[] = []

  const record = (outcome: PostMigrationOutcome): void => {
    total++
    if (outcome.status === 'migrated') migrated++
    else if (outcome.status === 'skipped') skipped++
    else {
      failed++
      if (failures.length < MAX_RETAINED_FAILURES) failures.push(outcome)
    }
    if (opts.onOutcome) opts.onOutcome(outcome)
  }

  // Common SELECT projection. Only posts NOT yet linked. Include soft-deleted
  // posts: their body page is created too (born trashed — F8 lockstep — so a
  // later restore renders via the block path). ORDER BY id for deterministic,
  // keyset-pageable progress.
  if (typeof opts.limit === 'number') {
    // TEST / contributor path: a bounded one-shot fetch (already capped by the
    // operator-supplied limit, so loading it once is fine — no paging needed).
    const [postRows] = (await db.execute(sql`
      SELECT id, slug, title, body_md, body_page_id
      FROM posts
      WHERE body_page_id IS NULL
      ORDER BY id
      LIMIT ${opts.limit}
    `)) as unknown as [PostRow[]]
    for (const p of postRows) {
      record(await migrateOne(p))
    }
  } else {
    // PRODUCTION backfill: page forward by last-seen id (id-ASC keyset) in
    // batches of BACKFILL_BATCH_SIZE so the full un-migrated set never lands in
    // memory at once. Each post migrates in its own TX (migrateOne) and sets
    // body_page_id, so a row processed in one batch can't reappear in the next —
    // the WHERE body_page_id IS NULL + id > lastId window strictly advances and
    // terminates. A post whose migration FAILS keeps body_page_id NULL, but the
    // `id > lastId` cursor still steps past it, so a single bad post can't wedge
    // the sweep into an infinite loop (it's reported via onOutcome + the
    // failures list, and retried on the NEXT boot's backfill).
    let lastId = 0
    for (;;) {
      const [batch] = (await db.execute(sql`
        SELECT id, slug, title, body_md, body_page_id
        FROM posts
        WHERE body_page_id IS NULL AND id > ${lastId}
        ORDER BY id
        LIMIT ${BACKFILL_BATCH_SIZE}
      `)) as unknown as [PostRow[]]
      if (batch.length === 0) break
      for (const p of batch) {
        lastId = p.id
        record(await migrateOne(p))
      }
      if (batch.length < BACKFILL_BATCH_SIZE) break
    }
  }

  return { total, migrated, skipped, failed, outcomes: failures }
}
