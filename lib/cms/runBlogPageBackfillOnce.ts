import 'server-only'
import { seedBlogPageBlocksIfEmpty } from '@/db/seeds/systemPageBlocks'

// Customer auto-migration: the once-per-process boot wrapper that seeds the
// starter Blog-index block tree (spec §5) into the `pages.slug='blog'` system
// row on EXISTING installs after an update.
//
// Why this exists: migration 0034 only creates the blog page ROW (pure SQL
// can't author a section→column→widget block tree). On a FRESH install the
// blocks come from the install template (app/api/install/template, which
// re-exports BLOG_SECTIONS). But an EXISTING install that updates gets the
// empty row from 0034 with no blocks — so /blog would resolve to an empty
// page. This backfill closes that gap symmetrically with
// runProjectsBackfillOnce / runPostsBackfillOnce: it seeds the canonical
// BLOG_SECTIONS tree IF the row exists AND has zero live blocks.
//
// Safe to call on EVERY production boot:
//   • once-per-process guard (globalThis) — never re-enters within a run.
//   • idempotent — seedBlogPageBlocksIfEmpty no-ops when the row already has
//     live blocks (returns false), so a re-run after the first seed (or on an
//     install that already authored its own /blog) does nothing.
//   • non-fatal — wrapped by the caller; a failure leaves /blog 404-ing until
//     the next boot (better than crashing boot), surfaced in the log.
//
// The CALLER (instrumentation.ts boot hook) runs this FIRE-AND-FORGET so it
// never blocks boot / delays the health check.

const g = globalThis as unknown as { __cavecmsBlogPageBackfilled?: true }

export async function runBlogPageBackfillOnce(): Promise<number | false | null> {
  if (g.__cavecmsBlogPageBackfilled) return null
  g.__cavecmsBlogPageBackfilled = true

  const inserted = await seedBlogPageBlocksIfEmpty()
  if (inserted !== false) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'blog_page_backfill_seeded',
        rows: inserted,
      }),
    )
  }
  return inserted
}
