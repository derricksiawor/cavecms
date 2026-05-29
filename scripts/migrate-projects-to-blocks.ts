// Data migration — convert legacy `project_sections` content into a CMS
// block tree per project (a `pages` row + content_blocks at the project
// slug) so project detail pages render through EditableMain and become
// front-end inline-editable like any other page. The engine lives in
// lib/cms/migrateProjectsToBlocks.ts; this is the CLI entry point.
//
// Idempotent — re-running SKIPS any project that already has a page row
// at its slug, so it's safe to run on every update. Runs on BOTH:
//   • the publisher / local-test box, with `--publish=draft` → every
//     migrated page lands published=0 (dark launch) so a human can
//     verify it before flipping it live; and
//   • customer installs, during an update, with the default
//     `--publish=inherit` → a project that was published goes live on
//     the CMS branch the moment its tree validates; one whose tree
//     fails validation is left for the legacy render branch and
//     reported FAIL (it never half-migrates — each project is one TX).
//
// This is a REAL production data migration (it runs on customer
// installs via the updater), so — unlike the dev-only scripts — it is
// deliberately NOT NODE_ENV-guarded.
//
// Usage:
//   node --conditions=react-server --env-file-if-exists=.env.local \
//     --import tsx scripts/migrate-projects-to-blocks.ts \
//     [--publish=draft|inherit] [--limit=N]

import { pool } from '../db/client'
import { migrateProjectsToBlocks } from '../lib/cms/migrateProjectsToBlocks'

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

async function main() {
  const publish = readArg('publish') === 'draft' ? 'draft' : 'inherit'
  const limitRaw = readArg('limit')
  const limit = limitRaw === undefined ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error('[migrate-projects-to-blocks] --limit must be a positive integer')
    process.exitCode = 1
    return
  }

  const report = await migrateProjectsToBlocks({
    publish,
    limit,
    onOutcome: (o) => {
      // One structured JSON line per project on stdout so the updater
      // can stream + parse progress.
      console.log(JSON.stringify({ level: 'info', msg: 'project_migration', ...o }))
    },
  })

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'project_migration_report',
      publish,
      total: report.total,
      migrated: report.migrated,
      skipped: report.skipped,
      failed: report.failed,
    }),
  )

  // Human-readable summary on stderr so the JSON stream on stdout stays
  // clean for machine parsing.
  console.error(
    `\nProjects → blocks (${publish}): ${report.migrated} migrated, ` +
      `${report.skipped} skipped, ${report.failed} failed (of ${report.total}).`,
  )
  const divergences = report.outcomes.filter((o) => o.brochurePdfDivergence)
  if (divergences.length > 0) {
    console.error(
      `  ⚠ ${divergences.length} project(s) had a section brochure PDF not mirrored ` +
        `on the project row (set it under Projects → Brochure): ` +
        divergences.map((d) => d.slug).join(', '),
    )
  }
  for (const f of report.outcomes.filter((o) => o.status === 'failed')) {
    console.error(`  ✗ ${f.slug}: ${f.reason}${f.detail ? ` (${f.detail})` : ''}`)
  }

  // A completed run always exits 0 — per-project failures are reported
  // (in the JSON stream + the admin Updates report) but must NOT roll
  // back a customer's whole update: a single un-migratable project just
  // keeps rendering through the legacy branch. Only a fatal run-level
  // error (the catch below) exits non-zero.
}

try {
  await main()
} catch (err) {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: 'project_migration_fatal',
      err: err instanceof Error ? err.message : String(err),
    }),
  )
  process.exitCode = 1
} finally {
  await pool.end().catch(() => {})
}
