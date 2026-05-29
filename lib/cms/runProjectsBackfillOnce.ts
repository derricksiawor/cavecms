import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  migrateProjectsToBlocks,
  type ProjectsMigrationReport,
} from './migrateProjectsToBlocks'

// Customer auto-migration: the once-per-process boot wrapper around the
// projects → CMS-blocks backfill. When a customer updates and the app
// restarts (pm2 reload, after the update's schema-migration step), this
// converts any legacy `project_sections` project that doesn't yet have a
// block-tree `pages` row at its slug into the new CMS block tree — using
// the SAME validated migrateProjectsToBlocks engine the dev CLI uses
// (parseAndSanitize per widget, media availability checks, one TX per
// project). It is the customer-facing delivery of the projects→blocks
// feature: without it, an updated install ships the new code but its
// existing projects keep rendering via the legacy branch forever.
//
// Designed to be safe to call on EVERY production boot:
//   • once-per-process guard (globalThis) — never re-enters within a run.
//   • cheap pre-check — a single COUNT short-circuits the common no-op
//     case (all projects already migrated), so a normal restart costs
//     ~one query.
//   • idempotent — migrateProjectsToBlocks SKIPs any project that already
//     has a `pages` row, so even if the guard race-loses it's harmless.
//   • non-fatal — per-project failures are reported, never thrown; a
//     project whose tree fails validation is left for the legacy render
//     branch (still present this release) and surfaced in the log.
//   • publish:'inherit' — a live project goes live on the block branch
//     the instant its tree validates; a draft stays a draft.
//
// The CALLER (instrumentation.ts boot hook) runs this FIRE-AND-FORGET so
// it never blocks boot / delays the health check: projects render via the
// legacy branch until their tree lands, and each project migrates inside
// its own transaction, so a visitor mid-backfill always sees either the
// old render or the new one — never a half-built page.

const g = globalThis as unknown as { __cavecmsProjectsBackfilled?: true }

export async function runProjectsBackfillOnce(): Promise<ProjectsMigrationReport | null> {
  if (g.__cavecmsProjectsBackfilled) return null
  g.__cavecmsProjectsBackfilled = true

  // Cheap guard: any non-deleted project still missing its block-tree
  // page? (is_home = 0 mirrors migrateProjectsToBlocks' own slug lookup.)
  const [rows] = (await db.execute(sql`
    SELECT COUNT(*) AS n
    FROM projects p
    WHERE p.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM pages pg WHERE pg.slug = p.slug AND pg.is_home = 0
      )
  `)) as unknown as [Array<{ n: number | string }>]
  const pending = Number(rows[0]?.n ?? 0)
  if (pending === 0) return null

  console.warn(
    JSON.stringify({ level: 'warn', msg: 'projects_backfill_start', pending }),
  )

  const report = await migrateProjectsToBlocks({
    publish: 'inherit',
    onOutcome: (o) => {
      if (o.status === 'failed') {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'projects_backfill_project_failed',
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
      msg: 'projects_backfill_done',
      total: report.total,
      migrated: report.migrated,
      skipped: report.skipped,
      failed: report.failed,
      // First few failures inline so an operator sees the offending
      // section/field (e.g. "aurora-heights:parse_failed") without
      // hunting the per-project error lines above.
      failedSlugs: report.outcomes
        .filter((o) => o.status === 'failed')
        .map((o) => `${o.slug}:${o.reason}${o.detail ? `(${o.detail})` : ''}`)
        .slice(0, 20),
    }),
  )

  return report
}
