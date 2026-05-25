'use strict'

// Standalone DDL applier. The deploy story is operator-driven (no
// GitHub Actions): build the standalone artifact locally, produce a
// portable migrator bundle via `pnpm --filter=@cavecms/migrator deploy
// --prod migrator-bundle` (which materializes a flat, symlink-free
// node_modules), pack into a tarball, scp to the server (typically
// via `~/connect/connect <server> upload …`), then either invoke
// scripts/deploy.sh from the server or run the steps manually.
//
// scripts/deploy.sh, when used, extracts the tarball into
// /opt/cavecms/releases/<sha>/ and runs this script via
// `node migrator-bundle/run.js` with DATABASE_URL sourced from
// DATABASE_MIGRATOR_URL in /etc/cavecms/env.production (subshell-scoped
// so the DDL principal's credentials never bleed into the
// PM2-launched app process). Manual invocation works the same:
// `DATABASE_URL=$DATABASE_MIGRATOR_URL node migrator-bundle/run.js`.
//
// CommonJS on purpose: the workspace root is "type": "module" but the
// migrator package omits the field so it inherits the Node default
// (CommonJS). require() avoids ESM hoist ordering surprises and the
// runtime resolver works the same way whether this is run from the
// repo root or from a deploy artifact subdirectory.
//
// Authoritative contract with deploy.sh:
//   - Reads DATABASE_URL from the environment (deploy.sh exports it
//     from $DATABASE_MIGRATOR_URL in a subshell so the migrator user's
//     DDL grant is never visible to the running app's PM2 process).
//   - Exits 0 on success after writing schema_fingerprint and logging
//     a one-line summary.
//   - Exits 1 on ANY error and writes a multi-line diagnostic to
//     stderr — deploy.sh treats non-zero as "DB may be in a partial
//     state" and aborts the symlink flip.

const mysql = require('mysql2/promise')
const fs = require('node:fs/promises')
const path = require('node:path')

// GET_LOCK key. Two simultaneous deploys racing the migrator would
// each see the same applied-set, both try to apply the same pending
// migrations, and at least one would crash on a CREATE-already-exists.
// The named lock is held for the duration of this process; the wait is
// bounded so a hung migrator from a prior crashed deploy doesn't block
// forever. The lock name is suffixed with the target database name
// (parsed from DATABASE_URL after mysql2 connects) so a single MariaDB
// instance hosting both staging and production schemas cannot deadlock
// a deploy against the wrong env's serialization point.
const ADVISORY_LOCK_PREFIX = 'cavecms_migrator_lock'
const ADVISORY_LOCK_WAIT_SECONDS = 60

// Drizzle-kit writes each generated migration with one or more
// `--> statement-breakpoint` lines between statements. Splitting on
// that string is the canonical convention drizzle's own migrate
// helper uses; we replicate it here to avoid pulling drizzle-kit (a
// 50MB devDependency) into the migrator bundle.
const STATEMENT_BREAKPOINT = '--> statement-breakpoint'

function logInfo(event, extra = {}) {
  console.log(JSON.stringify({ level: 'info', script: 'migrator', event, ...extra }))
}

function logError(event, extra = {}) {
  console.error(JSON.stringify({ level: 'error', script: 'migrator', event, ...extra }))
}

async function loadMigrationFiles(migrationsDir) {
  let entries
  try {
    entries = await fs.readdir(migrationsDir)
  } catch (err) {
    throw new Error(
      `cannot read migrations dir at ${migrationsDir}: ${err.message}`,
    )
  }
  // Hash key matches drizzle's filename convention: the SHA-256-keyed
  // ordering is encoded in the filename prefix (0000_, 0001_, …), so
  // sorting filenames lexically produces deterministic apply order.
  const files = entries.filter((f) => f.endsWith('.sql')).sort()
  if (files.length === 0) {
    throw new Error(`no .sql files in migrations dir at ${migrationsDir}`)
  }
  return files
}

async function readFingerprint(fingerprintPath) {
  let raw
  try {
    raw = await fs.readFile(fingerprintPath, 'utf8')
  } catch (err) {
    throw new Error(
      `cannot read schema fingerprint at ${fingerprintPath}: ${err.message}. ` +
        `CI should have written this file as part of the artifact build.`,
    )
  }
  const fp = raw.trim()
  // Output of sha256sum is a hex string of exactly 64 chars. Refusing
  // anything else catches a half-written file or accidental text
  // (BOM, log lines redirected into the wrong path, etc.) at deploy
  // time rather than letting an unparseable fingerprint reach the
  // schema_fingerprint table.
  if (!/^[0-9a-f]{64}$/.test(fp)) {
    throw new Error(
      `schema fingerprint at ${fingerprintPath} is not a 64-char hex digest (got ${fp.length} chars)`,
    )
  }
  return fp
}

function splitStatements(sqlText) {
  return sqlText
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter(Boolean)
}

function lockNameFor(conn) {
  // mysql2 populates conn.config.database from the URI. Strict regex
  // mirrors what MySQL/MariaDB accepts as an identifier without
  // backticks. If something pathological lands here (empty, non-ASCII),
  // we fall back to the prefix alone — better to share the lock than
  // to refuse to deploy.
  const dbName = conn && conn.config && typeof conn.config.database === 'string'
    ? conn.config.database
    : ''
  if (/^[A-Za-z0-9_]{1,40}$/.test(dbName)) {
    return `${ADVISORY_LOCK_PREFIX}_${dbName}`
  }
  return ADVISORY_LOCK_PREFIX
}

async function acquireAdvisoryLock(conn, lockName) {
  // GET_LOCK is connection-scoped; releasing the connection releases
  // the lock automatically. We still RELEASE_LOCK explicitly in the
  // finally to free it the moment the work is done (concurrent
  // deploy doesn't have to wait for our keep-alived connection to
  // age out).
  const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS lock_result', [
    lockName,
    ADVISORY_LOCK_WAIT_SECONDS,
  ])
  const result = rows && rows[0] ? rows[0].lock_result : null
  if (result !== 1) {
    // 0 = timeout (another migrator is running), NULL = error.
    throw new Error(
      `could not acquire advisory lock ${lockName} (result=${String(result)}) — another migrator is running or crashed without releasing`,
    )
  }
}

async function releaseAdvisoryLock(conn, lockName) {
  try {
    await conn.query('SELECT RELEASE_LOCK(?)', [lockName])
  } catch (err) {
    // Don't fail the deploy over a stuck release — the lock auto-
    // frees on connection close anyway.
    logError('advisory_lock_release_failed', { cause: err.message })
  }
}

async function main() {
  const startedAt = Date.now()
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set in the environment')
  }

  // Paths are resolved relative to this file so the script works
  // both from the repo root (dev: node migrator/run.js) and from the
  // deploy artifact subdir (prod: node migrator-bundle/run.js).
  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations')
  const fingerprintPath = path.resolve(__dirname, '..', 'db', 'schema-fingerprint.txt')

  const files = await loadMigrationFiles(migrationsDir)
  const expectedFingerprint = await readFingerprint(fingerprintPath)

  // Connect with multipleStatements OFF (the default). Each statement
  // is sent individually so a syntax error surfaces with the exact
  // statement, not as a generic mid-batch failure.
  const conn = await mysql.createConnection({
    uri: databaseUrl,
    multipleStatements: false,
    // Fail fast if the DDL principal can't connect — deploy.sh
    // raises the alert if migration takes too long.
    connectTimeout: 10_000,
  })

  const lockName = lockNameFor(conn)
  let appliedCount = 0
  try {
    await acquireAdvisoryLock(conn, lockName)

    // Bookkeeping table. The migrator owns this table even though the
    // schema_fingerprint table is owned by the application — separating
    // the "what's installed" ledger from the "what shape is the DB"
    // assertion keeps each table's contract narrow.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INT PRIMARY KEY AUTO_INCREMENT,
        hash VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT idx_drizzle_migrations_hash UNIQUE (hash)
      )
    `)

    const [appliedRows] = await conn.query('SELECT hash FROM __drizzle_migrations')
    const alreadyApplied = new Set((appliedRows || []).map((r) => r.hash))

    for (const file of files) {
      if (alreadyApplied.has(file)) continue
      const filePath = path.join(migrationsDir, file)
      let sqlText
      try {
        sqlText = await fs.readFile(filePath, 'utf8')
      } catch (err) {
        throw new Error(`cannot read migration ${file}: ${err.message}`)
      }
      const statements = splitStatements(sqlText)
      if (statements.length === 0) {
        throw new Error(
          `migration ${file} has no executable statements after splitting on "${STATEMENT_BREAKPOINT}"`,
        )
      }

      logInfo('migration_applying', { file, statementCount: statements.length })
      for (let i = 0; i < statements.length; i += 1) {
        const stmt = statements[i]
        try {
          await conn.query(stmt)
        } catch (err) {
          // MySQL DDL implicitly commits each statement individually,
          // so a mid-migration failure can leave a partial state.
          // Surface the file + statement index + first 200 chars so
          // an operator can recover by hand. The advisory lock is
          // released in the outer finally; the prior partial DDL is
          // recorded in audit via the deploy log.
          throw new Error(
            `migration ${file} failed on statement ${i + 1}/${statements.length}: ${err.message}\n` +
              `statement: ${stmt.slice(0, 200)}${stmt.length > 200 ? '…' : ''}`,
          )
        }
      }

      await conn.query('INSERT INTO __drizzle_migrations (hash) VALUES (?)', [file])
      logInfo('migration_applied', { file })
      appliedCount += 1
    }

    // Pin the schema fingerprint LAST so a failed migration above
    // leaves the prior fingerprint in place — instrumentation.ts's
    // boot-time check will then disagree with the running code and
    // refuse to start, which is the right safety outcome.
    await conn.query(
      `INSERT INTO schema_fingerprint (id, fingerprint)
       VALUES (1, ?)
       ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), applied_at = NOW(3)`,
      [expectedFingerprint],
    )
  } finally {
    await releaseAdvisoryLock(conn, lockName)
    await conn.end()
  }

  const durationMs = Date.now() - startedAt
  logInfo('completed', {
    durationMs,
    migrationsApplied: appliedCount,
    fingerprint: expectedFingerprint,
  })
}

main().catch((err) => {
  logError('fatal', {
    cause: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : undefined,
  })
  process.exit(1)
})
