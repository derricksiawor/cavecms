// scripts/db-migrate-with-lock.ts
//
// Thin wrapper around `drizzle-kit migrate` that takes the same advisory
// lock the production migrator (migrator/run.js:131) uses — so concurrent
// `pnpm db:migrate` runs from two terminals (or a dev + a CI git-hook)
// can't race on the __drizzle_migrations table mid-flight.
//
// Lock name and shape match migrator/run.js (`bwc_migrator_lock_<dbname>`,
// 60-second wait) so a dev migration and a prod migration cannot run
// concurrently against the same DB even if someone points dev tooling at
// prod credentials by accident.
//
// Production usage is explicitly NOT a target of this wrapper — prod
// migrations run via scripts/deploy.sh → migrator-bundle/run.js. The
// NODE_ENV=production refusal at the top of main() mirrors the same gate
// in db/seed.ts:151-162.

import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'

const ADVISORY_LOCK_PREFIX = 'bwc_migrator_lock'
const ADVISORY_LOCK_WAIT_SECONDS = 60

function lockNameFor(dbName: string | undefined): string {
  // Same regex as migrator/run.js:125 — strict identifier-shape so the
  // lock name is always a safe SQL string. Fall back to the bare prefix
  // if the DB name doesn't fit; better to share the lock than refuse.
  if (typeof dbName === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(dbName)) {
    return `${ADVISORY_LOCK_PREFIX}_${dbName}`
  }
  return ADVISORY_LOCK_PREFIX
}

async function main(): Promise<number> {
  // Production refusal — mirrors db/seed.ts:151-162. Prod migrations
  // run via scripts/deploy.sh → migrator-bundle/run.js, NOT this wrapper.
  // A dev pointing DATABASE_URL at the prod DB by accident (copied env
  // file, wrong tunnel) would otherwise grab the prod migrator's
  // advisory lock and apply uncommitted dev migrations to prod.
  if (
    process.env['NODE_ENV'] === 'production' &&
    process.env['BWC_MIGRATE_OK'] !== '1'
  ) {
    console.error(
      '[db-migrate-with-lock] refusing to run with NODE_ENV=production without explicit opt-in.',
    )
    console.error(
      '[db-migrate-with-lock]   prod migrations run via scripts/deploy.sh; if you really need to migrate manually: BWC_MIGRATE_OK=1 pnpm db:migrate',
    )
    return 1
  }

  const url = process.env['DATABASE_URL']
  if (!url) {
    throw new Error('[db-migrate-with-lock] DATABASE_URL not set in environment')
  }
  const conn = await mysql.createConnection(url)
  const dbName =
    typeof conn.config.database === 'string' ? conn.config.database : undefined
  const lockName = lockNameFor(dbName)

  let acquired = false
  let childExitCode = 1
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT GET_LOCK(?, ?) AS lock_result',
      [lockName, ADVISORY_LOCK_WAIT_SECONDS],
    )
    // Number() coercion defends against mysql2 driver variants that
    // return GET_LOCK as BigInt under certain pool options.
    const result = Number(rows[0]?.['lock_result'] ?? -1)
    if (result !== 1) {
      // 0 = timeout (another migrator running), NULL → coerced to NaN
      // → -1 here = error.
      throw new Error(
        `[db-migrate-with-lock] could not acquire advisory lock ${lockName} (result=${String(rows[0]?.['lock_result'])}) — another migrator is running or crashed without releasing`,
      )
    }
    acquired = true

    // Spawn drizzle-kit migrate as a child. The child inherits the
    // parent's env (DATABASE_URL was loaded by the parent via
    // --env-file=.env.local on the package.json invocation, so it's
    // already in process.env). Hardcoding --env-file=.env.local on the
    // child argv would override CLI-level DATABASE_URL overrides and
    // could load a different DB than the lock was taken for.
    //
    // Signal forwarding: if the parent receives SIGINT/SIGTERM/SIGHUP,
    // forward to the child so we don't orphan a mid-DDL drizzle-kit
    // process that holds no advisory lock. Without forwarding,
    // `kill <parent_pid>` (SIGTERM to wrapper only) leaves the child
    // running, the parent's mysql2 connection closes, the lock auto-
    // frees, and a second `pnpm db:migrate` could grab the lock while
    // the orphaned drizzle-kit is still applying statements.
    childExitCode = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        ['node_modules/drizzle-kit/bin.cjs', 'migrate'],
        { stdio: 'inherit' },
      )
      const forward = (sig: NodeJS.Signals): (() => void) => () => {
        if (!child.killed) child.kill(sig)
      }
      const sigint = forward('SIGINT')
      const sigterm = forward('SIGTERM')
      const sighup = forward('SIGHUP')
      process.on('SIGINT', sigint)
      process.on('SIGTERM', sigterm)
      process.on('SIGHUP', sighup)
      const cleanup = (): void => {
        process.off('SIGINT', sigint)
        process.off('SIGTERM', sigterm)
        process.off('SIGHUP', sighup)
      }
      child.on('exit', (code) => {
        cleanup()
        resolve(code ?? 1)
      })
      child.on('error', (err) => {
        cleanup()
        console.error('[db-migrate-with-lock] failed to spawn migrator:', err.message)
        resolve(1)
      })
    })
  } finally {
    if (acquired) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName])
      } catch {
        // Lock auto-frees on connection close anyway — don't fail over a
        // stuck release.
      }
    }
    try {
      await conn.end()
    } catch {
      // connection cleanup error at script exit is benign.
    }
  }
  return childExitCode
}

try {
  process.exitCode = await main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
