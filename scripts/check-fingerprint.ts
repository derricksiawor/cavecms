// pnpm db:check — compares the baked-in schema fingerprint baseline
// against what's in the DB. Non-zero exit on mismatch or missing data.
// Wired into the `predev` lifecycle so a contributor with a stale local
// DB can't boot the dev server against drifted state.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db, pool } from '@/db/client'

async function main(): Promise<void> {
  try {
    const baselinePath = path.resolve('db/schema-fingerprint.txt')
    let expected = ''
    try {
      expected = (await readFile(baselinePath, 'utf8')).trim()
    } catch {
      console.error('db:check FAIL — db/schema-fingerprint.txt missing. Run pnpm db:migrate.')
      process.exit(1)
    }
    if (!expected) {
      console.error('db:check FAIL — db/schema-fingerprint.txt empty. Run pnpm db:fingerprint.')
      process.exit(1)
    }

    const [rows] = (await db.execute(
      sql`SELECT fingerprint FROM schema_fingerprint WHERE id = 1`,
    )) as unknown as [Array<{ fingerprint: string }>]
    const actual = rows[0]?.fingerprint
    if (!actual) {
      console.error('db:check FAIL — schema_fingerprint row missing. Run pnpm db:fingerprint.')
      process.exit(1)
    }
    if (actual !== expected) {
      console.error(`db:check FAIL — fingerprint mismatch.`)
      console.error(`  baseline: ${expected}`)
      console.error(`  database: ${actual}`)
      console.error(`Run pnpm db:migrate to sync.`)
      process.exit(1)
    }
    console.log('db:check OK')
  } finally {
    await pool.end()
  }
}

await main()
