import 'server-only'

// MySQL "Table ... doesn't exist" error code. mysql2 surfaces this
// as `err.code === 'ER_NO_SUCH_TABLE'`. Several read paths
// (hydrate.ts cross-table fetches, sitemap.ts conditional posts
// inclusion) need to feature-detect whether a planned-but-not-yet-
// shipped table is present. Catching ANY error and returning the
// empty fallback would mask real DB problems (connection drops,
// deadlock victims, statement timeouts) as "table missing".
// Centralize the narrow check so every caller stays disciplined.
const ER_NO_SUCH_TABLE = 'ER_NO_SUCH_TABLE'

export function isMissingTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === ER_NO_SUCH_TABLE
  )
}

// MySQL duplicate-key violation. Lookup-then-insert and rename flows
// race against concurrent inserts that target the same UNIQUE
// constraint; the cleanest handling is to catch this specific code
// and translate to HttpError(409, 'slug_taken' | 'email_taken' | ...).
const ER_DUP_ENTRY = 'ER_DUP_ENTRY'

export function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === ER_DUP_ENTRY
  )
}
