// Computes a SHA-256 fingerprint over the canonical shape of every table
// the app owns and writes it both to db/schema-fingerprint.txt (baked into
// the build) and the single-row schema_fingerprint table.
//
// Invoked by `pnpm db:fingerprint` after `pnpm db:migrate`. Boot-time
// check in instrumentation.ts compares the file vs the row — mismatch
// means "new code on old schema" or vice versa; process exits 1.
//
// Not guarded with the NODE_ENV=production refusal that destructive dev
// scripts have, because this is meant to run in CI and on the deploy box
// during migration — both legitimate production-adjacent use cases.

import { createHash } from 'node:crypto'
import { open, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { db, pool } from '@/db/client'
import { sql } from 'drizzle-orm'

// Tables the app owns. Listed explicitly (not derived from
// information_schema) so a stray test table or an unrelated schema in the
// same database cannot tilt the fingerprint.
const TRACKED_TABLES = [
  'audit_log',
  'content_blocks',
  'failed_logins_by_email',
  'failed_logins_by_ip',
  'leads',
  'login_attempts',
  'media',
  'media_references',
  'newsletter_subscribers',
  'notification_failures',
  'pages',
  'pending_emails',
  'posts',
  'project_sections',
  'projects',
  'saved_blocks',
  'schema_fingerprint',
  'settings',
  'slug_redirects',
  'user_known_ips',
  'users',
] as const

interface ColumnRow {
  table_name: string
  column_name: string
  column_type: string
  is_nullable: 'YES' | 'NO'
  column_default: string | null
  column_key: string
  extra: string
}

async function fetchColumns(): Promise<ColumnRow[]> {
  const [rows] = (await db.execute(sql`
    SELECT
      TABLE_NAME      AS table_name,
      COLUMN_NAME     AS column_name,
      COLUMN_TYPE     AS column_type,
      IS_NULLABLE     AS is_nullable,
      COLUMN_DEFAULT  AS column_default,
      COLUMN_KEY      AS column_key,
      EXTRA           AS extra
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN (${sql.join([...TRACKED_TABLES], sql.raw(','))})
    ORDER BY TABLE_NAME, COLUMN_NAME
  `)) as unknown as [ColumnRow[]]
  return rows
}

function canonicalize(rows: ColumnRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.table_name}.${r.column_name}:${r.column_type}|null=${r.is_nullable}|default=${r.column_default ?? '<none>'}|key=${r.column_key}|extra=${r.extra}`,
    )
    .join('\n')
}

async function main(): Promise<void> {
  try {
    const rows = await fetchColumns()
    if (rows.length === 0) {
      console.error('fingerprint: no tracked tables found — has the migration run?')
      process.exit(1)
    }
    const found = new Set(rows.map((r) => r.table_name))
    const missing = TRACKED_TABLES.filter((t) => !found.has(t))
    if (missing.length > 0) {
      console.error(`fingerprint: missing tables: ${missing.join(', ')}`)
      process.exit(1)
    }
    const canonical = canonicalize(rows)
    const fingerprint = createHash('sha256').update(canonical).digest('hex')

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
