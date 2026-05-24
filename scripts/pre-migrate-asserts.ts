// scripts/pre-migrate-asserts.ts
//
// Runs BEFORE the migrator (drizzle-kit migrate in dev, migrator-bundle/run.js
// in deploy.sh). Catches conditions that would crash the migration mid-way
// or violate invariants that the migration assumes. Failure halts the deploy
// BEFORE any DDL executes — the old binary keeps serving and no partial
// schema state is left behind.
//
// Three asserts (spec §1.5):
//   1. MariaDB version >= MIN_MARIADB (required for DELETE...RETURNING,
//      online ENUM-widening, UNIQUE on STORED generated columns).
//   2. No orphan content_blocks (rows pointing at non-existent pages.id) —
//      otherwise the migration's FK creation in step 7 would crash mid-
//      migration.
//   3. No duplicate (resource_type, old_slug) rows in slug_redirects —
//      the canonical UNIQUE index idx_redirects_type_old already exists
//      since migration 0004; this gate catches any duplicate state that
//      would have crashed that constraint on a re-create scenario AND
//      signals a corrupted DB worth operator attention.
//
// Implementation note: this script uses mysql2/promise DIRECTLY rather than
// `@/db/client` to avoid loading `@/lib/env`, which validates ALL secrets
// (JWT_SECRET, CSRF_SECRET, etc.) at module-load time. Pre-migrate asserts
// only need DATABASE_URL — keeping the dependency surface that narrow lets
// deploy.sh invoke this script with just DATABASE_URL injected, without
// having to source the full production env file inside the runuser
// subshell (which would also work, but adds blast radius).

import mysql from 'mysql2/promise'
import { MIN_MARIADB_MAJOR, MIN_MARIADB_MINOR } from '@/db/min-mariadb-version'

// Strip non-printable bytes from server-controlled strings (VERSION())
// before logging to operator stderr. Defense against an attacker with
// SUPER (or a compromised DB) crafting an ANSI/CSI escape that forges a
// "passed" line into the deploy log. Hard-cap length to prevent log
// flooding even after sanitisation.
function sanitiseForLog(s: string): string {
  return s
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 200)
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) {
    throw new Error('[pre-migrate-asserts] DATABASE_URL not set in environment')
  }
  const conn = await mysql.createConnection(url)
  try {
    // -----------------------------------------------------------------------
    // 1. MariaDB version >= MIN_MARIADB.
    //
    // MariaDB 10.x prefixes VERSION() output with "5.5.5-" for legacy MySQL
    // client handshake compat (e.g. "5.5.5-10.6.5-MariaDB-..."). The regex
    // targets the MariaDB substring directly to side-step the prefix AND
    // reject MySQL servers (which lack DELETE...RETURNING and UNIQUE on
    // STORED generated columns).
    //
    // Belt-and-braces: @@version_comment is queried alongside so a future
    // distro that strips "-MariaDB" from VERSION() but still returns
    // "MariaDB Server" from @@version_comment still passes the gate.
    // -----------------------------------------------------------------------
    const [versionRows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT VERSION() AS v, @@version_comment AS comment',
    )
    const versionString = String(versionRows[0]?.['v'] ?? '')
    const versionComment = String(versionRows[0]?.['comment'] ?? '')
    const versionDisplay = sanitiseForLog(versionString)

    const versionMatch = versionString.match(/(\d+)\.(\d+)[^-]*-MariaDB/)
    const looksLikeMariaDB =
      versionMatch !== null || /MariaDB/i.test(versionComment)
    if (!looksLikeMariaDB) {
      throw new Error(
        `[pre-migrate-asserts] #1 not running MariaDB (VERSION()=${versionDisplay}); this codebase requires MariaDB >= ${MIN_MARIADB_MAJOR}.${MIN_MARIADB_MINOR}`,
      )
    }
    // Parse major.minor: if the standard pattern matched, use it; else
    // fall back to leading "X.Y" of the raw string (covers stripped-suffix
    // distros that pass @@version_comment).
    let major: number
    let minor: number
    if (versionMatch) {
      major = Number(versionMatch[1])
      minor = Number(versionMatch[2])
    } else {
      const fallback = versionString.match(/^(?:5\.5\.5-)?(\d+)\.(\d+)/)
      major = Number(fallback?.[1])
      minor = Number(fallback?.[2])
    }
    if (!Number.isFinite(major) || !Number.isFinite(minor)) {
      throw new Error(
        `[pre-migrate-asserts] #1 could not parse MariaDB version: ${versionDisplay}`,
      )
    }
    if (
      major < MIN_MARIADB_MAJOR ||
      (major === MIN_MARIADB_MAJOR && minor < MIN_MARIADB_MINOR)
    ) {
      throw new Error(
        `[pre-migrate-asserts] #1 MariaDB version too old: ${versionDisplay} (parsed ${major}.${minor}); need >= ${MIN_MARIADB_MAJOR}.${MIN_MARIADB_MINOR}`,
      )
    }

    // -----------------------------------------------------------------------
    // 2. Orphan content_blocks.
    //
    // FK creation in migration step 7 (ON DELETE CASCADE) would fail with
    // ER_NO_REFERENCED_ROW_2 if any content_blocks.page_id points at a
    // non-existent pages.id. The fix is operator action.
    //
    // TOCTOU caveat: this check runs as the app principal against a
    // separate connection. Between this assert and migration step 7,
    // an admin POST could insert an orphan block. The mitigation is
    // operator-side: take a brief maintenance window OR set the app to
    // read-only mode during deploy. A future hardening could move both
    // pre-asserts INTO the migrator's transaction.
    // -----------------------------------------------------------------------
    const [orphanRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n
      FROM content_blocks cb
      LEFT JOIN pages p ON p.id = cb.page_id
      WHERE p.id IS NULL
    `)
    const orphanCount = Number(orphanRows[0]?.['n'] ?? 0)
    if (orphanCount !== 0) {
      throw new Error(
        `[pre-migrate-asserts] #2 orphan content_blocks present: ${orphanCount} rows reference non-existent pages.id; recovery: DELETE FROM content_blocks WHERE page_id NOT IN (SELECT id FROM pages); — then re-deploy`,
      )
    }

    // -----------------------------------------------------------------------
    // 3. Duplicate (resource_type, old_slug) rows in slug_redirects.
    //
    // The canonical UNIQUE index idx_redirects_type_old was created by
    // migration 0004. Pre-existing duplicates here are a corruption
    // signal — they would have crashed that constraint on its initial
    // creation. Surfacing them now (even if 0010 no longer re-creates
    // the index) keeps the operator-facing gate consistent across
    // versions and catches any state that bypassed the original
    // constraint via direct SQL.
    // -----------------------------------------------------------------------
    const [dupRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM (
        SELECT resource_type, old_slug, COUNT(*) AS c
        FROM slug_redirects
        GROUP BY resource_type, old_slug
        HAVING c > 1
      ) dups
    `)
    const dupCount = Number(dupRows[0]?.['n'] ?? 0)
    if (dupCount !== 0) {
      throw new Error(
        `[pre-migrate-asserts] #3 duplicate (resource_type, old_slug) rows in slug_redirects: ${dupCount} groups; recovery: SELECT resource_type, old_slug, COUNT(*) c FROM slug_redirects GROUP BY 1,2 HAVING c>1; — manually DELETE all but one row per group, then re-deploy`,
      )
    }

    console.log('[pre-migrate-asserts] passed (3/3)')
  } finally {
    try {
      await conn.end()
    } catch {
      // connection cleanup error at script exit is benign.
    }
  }
}

try {
  await main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
