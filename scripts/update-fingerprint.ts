// Computes the schema fingerprint and writes it both to
// db/schema-fingerprint.txt (baked into the build) and the single-row
// schema_fingerprint table.
//
// Invoked by `pnpm db:fingerprint` after `pnpm db:migrate`. Boot-time
// check in instrumentation.ts compares the file vs the row — mismatch
// means "new code on old schema" or vice versa; process exits 1.
//
// ─── Why the fingerprint is over the MIGRATION JOURNAL, not the schema ───
// It used to hash information_schema.COLUMNS (column_type, is_nullable,
// column_default, …). That is NOT portable: the SAME migrations
// materialize a DIFFERENT schema depending on the server's
// `explicit_defaults_for_timestamp` (OFF on MariaDB ≤10.9 / Ubuntu-22.04's
// 10.6 → timestamps become NOT NULL with '0000-00-00'/`on update`
// implicit defaults; ON on MariaDB ≥10.10 / 12.x → nullable DEFAULT NULL),
// and on integer display widths (`int(11)` on MariaDB, `int` on MySQL 8),
// `DEFAULT_GENERATED` in EXTRA (MySQL 8), and more. So a baseline generated
// on one engine fatally mismatched a fresh install on another engine —
// the release simply would not boot on a different MariaDB/MySQL version.
//
// The fingerprint's real job is only "does this DB have the migrations
// this build expects." So we hash the MIGRATION JOURNAL: sha256 of each
// applied migration's SQL (exactly what Drizzle + install-migrate.mjs
// already store in `__drizzle_migrations.hash`), joined in journal order,
// then sha256'd. That is byte-identical on every engine because it hashes
// the migration SQL text, never the server's materialised schema.
//
// Not guarded with the NODE_ENV=production refusal that destructive dev
// scripts have, because this is meant to run in CI and on the deploy box
// during migration — both legitimate production-adjacent use cases.

import { open, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db, pool } from '@/db/client'
import { sql } from 'drizzle-orm'
import { computeMigrationJournalFingerprint } from '@/lib/db/journalFingerprint'

async function main(): Promise<void> {
  try {
    const migrationsDir = path.resolve('db/migrations')
    const fingerprint = await computeMigrationJournalFingerprint({
      migrationsDir,
      readFile: (p) => readFile(p, 'utf8'),
    })

    // Write the DB row FIRST (so the file is always at-least-as-fresh).
    // Single-row table: id=1 always. ON DUPLICATE KEY UPDATE handles
    // both fresh and re-runs.
    await db.execute(sql`
      INSERT INTO schema_fingerprint (id, fingerprint, applied_at)
      VALUES (1, ${fingerprint}, NOW(3))
      ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), applied_at = NOW(3)
    `)

    // Then atomically write the baseline file: write-to-tmp → fsync →
    // rename. A power loss between write and rename leaves the previous
    // (consistent) file in place. The DB row is the source-of-truth when
    // they disagree — boot-time check fails if either side is wrong.
    const outPath = path.resolve('db/schema-fingerprint.txt')
    const tmpPath = `${outPath}.tmp`
    await writeFile(tmpPath, fingerprint + '\n', { mode: 0o640 })
    // fsync the file contents before the rename so the rename can't be
    // reordered ahead of the bytes hitting disk.
    const fh = await open(tmpPath, 'r+')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmpPath, outPath)
    console.log(`fingerprint: ${fingerprint}`)
    console.log(`wrote ${outPath}`)
  } finally {
    await pool.end()
  }
}

await main()
