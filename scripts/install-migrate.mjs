#!/usr/bin/env node
// scripts/install-migrate.mjs
//
// Self-contained Drizzle-compatible migration runner shipped in the
// release zip. Runs against the operator's MariaDB to bring a fresh
// `npx create-cavecms` install up to the schema the bundled release
// expects.
//
// Why not just `pnpm db:migrate`?
//   db:migrate uses tsx + drizzle-kit (devDependencies). Customer
//   installs don't have those, and we explicitly do NOT want to ship
//   them in the zip — they bloat the artifact and pull a CLI surface
//   the customer never needs after install. This script reads the
//   drizzle journal (db/migrations/meta/_journal.json) + .sql files
//   that ARE shipped, and applies them via mysql2 (already present
//   in the standalone bundle's node_modules).
//
// Compatibility:
//   - Tracks state in `__drizzle_migrations` table — same schema +
//     hash format Drizzle uses, so an install that runs through this
//     script is interchangeable with one that ran `pnpm db:migrate`.
//   - Reads DATABASE_URL from env (the sealed env.production the CLI
//     just wrote). If unset, refuses with a clear error.
//
// Invocation:
//   node scripts/install-migrate.mjs                # apply all pending
//   node scripts/install-migrate.mjs --check        # report state without applying
//   DATABASE_URL=... node scripts/install-migrate.mjs

import { createHash } from 'node:crypto'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Repo root inside the unpacked zip: scripts/install-migrate.mjs lives
// at <root>/scripts/, so root is one level up.
const INSTALL_ROOT = resolve(__dirname, '..')
const MIGRATIONS_DIR = join(INSTALL_ROOT, 'db', 'migrations')
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json')

// Resolve mysql2 from the standalone bundle's node_modules. The CLI
// invokes this script with cwd at the unpacked root; mysql2 lives at
// `.next/standalone/node_modules/mysql2/`. createRequire with a base
// path pointing into the standalone tree gives Node's resolver the
// hint it needs.
const STANDALONE_PKG = join(INSTALL_ROOT, '.next', 'standalone', 'package.json')
let mysql
try {
  const requireFromStandalone = createRequire(STANDALONE_PKG)
  mysql = requireFromStandalone('mysql2/promise')
} catch (err) {
  // Fall back to top-level require — useful in dev when running from
  // the repo (mysql2 is in repo node_modules) instead of an unpacked
  // zip. If neither resolves, give the operator something actionable.
  try {
    const requireFromRepo = createRequire(import.meta.url)
    mysql = requireFromRepo('mysql2/promise')
  } catch {
    console.error('[install-migrate] mysql2 not found — looked in:')
    console.error(`  ${STANDALONE_PKG}`)
    console.error(`  ${import.meta.url}`)
    console.error('This script must run from inside the unpacked CaveCMS zip.')
    process.exit(1)
  }
  // Surface the standalone-resolution failure for debugging without
  // failing the whole script.
  console.error(
    `[install-migrate] note: standalone mysql2 unavailable (${err instanceof Error ? err.message.slice(0, 120) : err}); using repo node_modules`,
  )
}

const args = new Set(process.argv.slice(2))
const CHECK_ONLY = args.has('--check') || args.has('-n') || args.has('--dry-run')
const VERBOSE = args.has('-v') || args.has('--verbose')

function log(msg) {
  process.stdout.write(`[install-migrate] ${msg}\n`)
}
function logErr(msg) {
  process.stderr.write(`[install-migrate] ERROR: ${msg}\n`)
}

function requireDatabaseUrl() {
  const u = process.env.DATABASE_URL
  if (!u || !u.startsWith('mysql://')) {
    logErr('DATABASE_URL is not set (or not a mysql:// URL).')
    logErr('Customer installs: the CLI writes this into env.production for you.')
    logErr('Contributors: copy .env.example to .env.local and fill DATABASE_URL.')
    process.exit(1)
  }
  return u
}

function readJournal() {
  if (!existsSync(JOURNAL_PATH)) {
    logErr(`Migration journal not found at ${JOURNAL_PATH}`)
    logErr('This zip is missing db/migrations/meta/_journal.json — report a bug.')
    process.exit(1)
  }
  const raw = readFileSync(JOURNAL_PATH, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logErr(`Invalid journal JSON at ${JOURNAL_PATH}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    logErr('Journal missing `entries` array.')
    process.exit(1)
  }
  return parsed
}

function listSqlFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

function readMigration(tag) {
  // Drizzle writes files as <tag>.sql at the migrations root.
  const path = join(MIGRATIONS_DIR, `${tag}.sql`)
  if (!existsSync(path)) {
    logErr(`Migration file missing for journal entry: ${tag}.sql`)
    process.exit(1)
  }
  return readFileSync(path, 'utf8')
}

/**
 * Drizzle's MySQL migrator hashes the *raw* SQL file content with sha256
 * and stores the hex digest in __drizzle_migrations.hash. We mirror that
 * exactly so a CLI-installed instance is interchangeable with one that
 * ran pnpm db:migrate via drizzle-kit.
 */
function hashSql(sql) {
  return createHash('sha256').update(sql).digest('hex')
}

/**
 * Split a Drizzle-generated migration on `--> statement-breakpoint`
 * markers. Drizzle inserts these between top-level statements so the
 * runner can dispatch each one as its own query (MySQL's prepared
 * statement protocol does NOT support multiple statements per execute).
 */
function splitStatements(sql) {
  return sql
    .split(/-->\s*statement-breakpoint\s*/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function ensureMigrationsTable(conn) {
  // Mirror Drizzle's MySQL migrator schema exactly. id BIGINT AUTO_INCREMENT,
  // hash TEXT, created_at BIGINT. The exact CHARSET / COLLATE matches
  // what Drizzle would create so a later switch back to drizzle-kit
  // wouldn't mismatch.
  //
  // Privilege check via the side effect of CREATE TABLE IF NOT EXISTS:
  // if the customer's DB user lacks CREATE on the database, this fails
  // with ER_TABLEACCESS_DENIED_ERROR (1142) — give them an actionable
  // message instead of the raw mysql error code.
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`__drizzle_migrations\` (
        \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
        \`hash\` TEXT NOT NULL,
        \`created_at\` BIGINT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `)
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : ''
    const errno = err && typeof err === 'object' ? err.errno : 0
    if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR' || errno === 1142 || errno === 1044) {
      logErr('Database user does not have permission to create tables.')
      logErr('Required grants (run as root or DB owner):')
      logErr('  GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON `cavecms`.* TO ' +
        "'<your-cavecms-user>'@'%';")
      logErr('Then retry the install.')
      process.exit(78) // EX_CONFIG
    }
    throw err
  }
}

async function getAppliedHashes(conn) {
  const [rows] = await conn.query(
    'SELECT `hash`, `created_at` FROM `__drizzle_migrations` ORDER BY `id` ASC',
  )
  if (!Array.isArray(rows)) return new Set()
  return new Set(rows.map((r) => String(r.hash)))
}

async function applyMigration(conn, entry, sql, hash) {
  const statements = splitStatements(sql)
  if (statements.length === 0) {
    log(`  skipped ${entry.tag} — empty migration`)
    return
  }

  // MySQL/MariaDB doesn't support transactional DDL — we can't wrap
  // schema changes in BEGIN/COMMIT and get atomic rollback. But we CAN
  // wrap the bookkeeping (the __drizzle_migrations INSERT) so a crash
  // between "apply DDL" and "record applied" doesn't leave the table
  // saying we never ran it. Pattern: apply each statement, THEN insert
  // the hash. If we crash mid-DDL the operator must inspect manually.
  // (This matches Drizzle's own migrator behaviour.)
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]
    if (VERBOSE) log(`    [${entry.tag}] stmt ${i + 1}/${statements.length}`)
    try {
      // `query` (not `execute`) — Drizzle migrations may contain syntax
      // mysql2's prepared-statement protocol can't parse (multi-statement
      // CHECK constraints with question marks, ALTER TABLE blobs, etc.).
      // `query` uses text protocol which is the right choice for raw
      // schema SQL.
      await conn.query(stmt)
    } catch (err) {
      logErr(`Failed applying ${entry.tag} statement ${i + 1}/${statements.length}:`)
      logErr(`  ${err instanceof Error ? err.message : String(err)}`)
      logErr(`  SQL: ${stmt.slice(0, 200)}${stmt.length > 200 ? '…' : ''}`)
      throw err
    }
  }

  await conn.query(
    'INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)',
    [hash, Date.now()],
  )
}

async function main() {
  const url = requireDatabaseUrl()
  const journal = readJournal()
  log(`Found ${journal.entries.length} migration(s) in journal.`)

  // Also surface any orphan .sql files that aren't tracked in the
  // journal — surfaces a bad zip build.
  const sqlFiles = new Set(listSqlFiles().map((f) => f.replace(/\.sql$/, '')))
  const journalTags = new Set(journal.entries.map((e) => e.tag))
  const orphans = [...sqlFiles].filter((s) => !journalTags.has(s))
  if (orphans.length > 0) {
    logErr(
      `${orphans.length} .sql file(s) not referenced in db/migrations/meta/_journal.json:`,
    )
    for (const o of orphans) logErr(`  ${o}.sql`)
    logErr('The release zip is inconsistent — refusing to apply migrations.')
    logErr('Report this as a build-pipeline bug (the build-zip step is missing journal entries).')
    process.exit(70) // EX_SOFTWARE — release artifact bug
  }

  const conn = await mysql.createConnection({
    uri: url,
    // multipleStatements: false — we split on `--> statement-breakpoint`
    // ourselves and dispatch one statement per query. Letting the driver
    // multi-execute would conceal which statement failed.
    multipleStatements: false,
    // Reasonable connect timeout for a fresh-install flow where the DB
    // is on the same box and should respond instantly.
    connectTimeout: 10_000,
  })
  try {
    // Cross-process advisory lock. Prevents two concurrent
    // install-migrate runs (or a CLI install racing with a contributor's
    // `pnpm db:migrate`) from both reading the applied-hashes set,
    // both deciding the same migration is pending, and both applying
    // it — which corrupts __drizzle_migrations (duplicate hash) AND
    // crashes mid-DDL (MySQL has no transactional DDL). MariaDB's
    // GET_LOCK is connection-scoped; we hold it for the duration of
    // this script's run.
    const [lockRows] = await conn.query("SELECT GET_LOCK('cavecms_install_migrate', 60) AS got")
    const got = Array.isArray(lockRows) && lockRows.length > 0 ? lockRows[0].got : null
    if (got !== 1) {
      logErr('Another migration is already running. Wait for it to finish then retry.')
      process.exit(75) // EX_TEMPFAIL
    }

    // ─── Pre-flight: refuse to clobber an existing customer database ───
    // CaveCMS's migrations CREATE TABLE IF NOT EXISTS for generic names
    // (`users`, `posts`, `pages`, `settings`, `media`, `audit_log`,
    // `content_blocks`, `leads`, `subscribers`, `login_attempts`,
    // `notifications`). If the operator points us at a database that
    // ALREADY has tables under those names from another app, our schema
    // never overlays them — but CaveCMS will then query columns those
    // foreign tables don't have and crash at runtime.
    //
    // Safer to refuse loud than to half-install. The operator can
    // either create a fresh dedicated database OR explicitly OK the
    // current state by setting CAVECMS_ALLOW_NONEMPTY_DB=1 (e.g. when
    // they've manually verified the existing tables won't collide).
    const [tablesRows] = await conn.query('SHOW TABLES')
    const existingTables = Array.isArray(tablesRows)
      ? tablesRows.map((row) => Object.values(row)[0]).filter(Boolean)
      : []
    const hasMigrationsTable = existingTables.includes('__drizzle_migrations')
    const nonMigrationTables = existingTables.filter((t) => t !== '__drizzle_migrations')

    if (nonMigrationTables.length > 0 && !hasMigrationsTable) {
      logErr('Target database is not empty AND does not look like a previous CaveCMS install.')
      logErr(`Found ${nonMigrationTables.length} existing table(s):`)
      for (const t of nonMigrationTables.slice(0, 10)) logErr(`  - ${t}`)
      if (nonMigrationTables.length > 10) {
        logErr(`  ... and ${nonMigrationTables.length - 10} more`)
      }
      logErr('')
      logErr('CaveCMS uses generic table names (users, posts, pages, settings, ...) that')
      logErr('could collide with another app sharing this database. Refusing to proceed.')
      logErr('')
      logErr('Options:')
      logErr('  1. (recommended) Point CaveCMS at a fresh dedicated database:')
      logErr('       mysql> CREATE DATABASE cavecms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;')
      logErr('       mysql> GRANT ALL ON cavecms.* TO \'cavecms\'@\'%\' IDENTIFIED BY \'...\';')
      logErr('  2. If you\'re SURE no name collisions exist, override:')
      logErr('       CAVECMS_ALLOW_NONEMPTY_DB=1 ...rerun the installer...')
      if (process.env.CAVECMS_ALLOW_NONEMPTY_DB !== '1') {
        await conn.query("SELECT RELEASE_LOCK('cavecms_install_migrate')")
        process.exit(78) // EX_CONFIG
      }
      logErr('CAVECMS_ALLOW_NONEMPTY_DB=1 is set — proceeding at your own risk.')
    }

    await ensureMigrationsTable(conn)
    const applied = await getAppliedHashes(conn)
    log(`Already applied: ${applied.size}`)

    let toApply = 0
    let didApply = 0
    for (const entry of journal.entries) {
      const sql = readMigration(entry.tag)
      const hash = hashSql(sql)
      if (applied.has(hash)) {
        if (VERBOSE) log(`  ✓ ${entry.tag} (already applied)`)
        continue
      }
      toApply++
      if (CHECK_ONLY) {
        log(`  pending: ${entry.tag}`)
        continue
      }
      log(`  applying ${entry.tag}…`)
      await applyMigration(conn, entry, sql, hash)
      didApply++
    }

    if (CHECK_ONLY) {
      log(`Check-only: ${toApply} migration(s) pending.`)
      // Release lock before exit (connection close releases anyway,
      // but explicit is cleaner).
      await conn.query("SELECT RELEASE_LOCK('cavecms_install_migrate')")
      process.exit(toApply > 0 ? 2 : 0) // exit 2 = pending (CI signal)
    } else {
      log(`Applied ${didApply} migration(s). Schema is up to date.`)
    }
    await conn.query("SELECT RELEASE_LOCK('cavecms_install_migrate')")
  } finally {
    await conn.end()
  }
}

main().catch((err) => {
  logErr(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
