// Version-proof schema fingerprint over the MIGRATION JOURNAL.
//
// sha256 of each migration's SQL text (the exact value Drizzle and
// install-migrate.mjs store in `__drizzle_migrations.hash`), joined in
// journal order, then sha256'd. Because the inputs are the migration SQL
// *text* — not `information_schema` — the result is byte-identical on
// every MariaDB/MySQL version. (Hashing the materialised schema is not
// portable: `explicit_defaults_for_timestamp`, integer display widths,
// `DEFAULT_GENERATED`, etc. all differ across engines/versions.)
//
// install-migrate.mjs (the standalone bundle, no `@/` alias) carries an
// INLINE copy of this exact algorithm in `updateSchemaFingerprint` — the
// two MUST stay byte-for-byte identical, or baked (build) and stored
// (install) would diverge. Keep them in sync.

import { createHash } from 'node:crypto'
import path from 'node:path'

interface JournalEntry {
  idx: number
  tag: string
}

export async function computeMigrationJournalFingerprint(opts: {
  /** Absolute path to the `db/migrations` directory. */
  migrationsDir: string
  /** Reads a file as a utf8 string. Injected so the caller controls fs. */
  readFile: (absPath: string) => Promise<string>
}): Promise<string> {
  const { migrationsDir, readFile } = opts
  const journalRaw = await readFile(
    path.join(migrationsDir, 'meta', '_journal.json'),
  )
  const journal = JSON.parse(journalRaw) as { entries?: JournalEntry[] }
  const entries = [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx)
  if (entries.length === 0) {
    throw new Error('journal fingerprint: _journal.json has no migrations')
  }
  const hashes: string[] = []
  for (const entry of entries) {
    const sqlText = await readFile(path.join(migrationsDir, `${entry.tag}.sql`))
    hashes.push(createHash('sha256').update(sqlText).digest('hex'))
  }
  return createHash('sha256').update(hashes.join('\n')).digest('hex')
}
