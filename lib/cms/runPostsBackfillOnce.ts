import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { isMissingTable } from '@/lib/db/errors'
import {
  migratePostsToBlocks,
  type PostsMigrationReport,
} from './migratePostsToBlocks'

// Customer auto-migration: the once-per-process boot wrapper around the
// posts → CMS-blocks backfill (spec §12). After a customer updates and the
// app restarts (pm2 reload, after the update's schema-migration step),
// this moves any post whose body has not yet landed on the block engine
// (body_page_id IS NULL) onto it — a hidden body page + one lx_richtext
// block per post — using the SAME validated migratePostsToBlocks engine
// the dev CLI uses (parseAndSanitize on the seed block, one TX per post).
// Mirrors lib/cms/runProjectsBackfillOnce.ts exactly.
//
// Safe to call on EVERY production boot:
//   • once-per-process guard (globalThis) — never re-enters within a run.
//   • cheap pre-check — a single COUNT short-circuits the common no-op
//     case (all posts already migrated), so a normal restart costs
//     ~one query.
//   • idempotent — migratePostsToBlocks SKIPs any post already linked,
//     so even if the guard race-loses it's harmless (the per-post TX
//     re-reads body_page_id under FOR UPDATE).
//   • non-fatal — per-post failures are reported, never thrown; a post
//     whose body fails the lx_richtext cap/bidi gate is left NULL (the
//     detail route falls back to renderMarkdown(body_md)) and surfaced.
//   • missing-table-safe — an install whose posts table predates this
//     column / the table itself short-circuits cleanly.
//
// The CALLER (instrumentation.ts boot hook) runs this FIRE-AND-FORGET so
// it never blocks boot / delays the health check: posts render via the
// body_md fallback until their body page lands, each migrating in its own
// transaction, so a visitor mid-backfill always sees the old render OR
// the new one — never a half-built body.

const g = globalThis as unknown as { __cavecmsPostsBackfilled?: true }

export async function runPostsBackfillOnce(): Promise<PostsMigrationReport | null> {
  if (g.__cavecmsPostsBackfilled) return null
  g.__cavecmsPostsBackfilled = true

  // Cheap guard: any post still missing its body page?
  let pending = 0
  try {
    const [rows] = (await db.execute(sql`
      SELECT COUNT(*) AS n FROM posts WHERE body_page_id IS NULL
    `)) as unknown as [Array<{ n: number | string }>]
    pending = Number(rows[0]?.n ?? 0)
  } catch (err) {
    // posts table (or the body_page_id column) doesn't exist yet on a
    // very-early install — nothing to backfill.
    if (isMissingTable(err)) return null
    throw err
  }
  if (pending === 0) return null

  console.warn(
    JSON.stringify({ level: 'warn', msg: 'posts_backfill_start', pending }),
  )

  const report = await migratePostsToBlocks({
    onOutcome: (o) => {
      if (o.status === 'failed') {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'posts_backfill_post_failed',
            slug: o.slug,
            reason: o.reason,
            detail: o.detail,
          }),
        )
      }
    },
  })

  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'posts_backfill_done',
      total: report.total,
      migrated: report.migrated,
      skipped: report.skipped,
      failed: report.failed,
      failedSlugs: report.outcomes
        .filter((o) => o.status === 'failed')
        .map((o) => `${o.slug}:${o.reason}${o.detail ? `(${o.detail})` : ''}`)
        .slice(0, 20),
    }),
  )

  return report
}
