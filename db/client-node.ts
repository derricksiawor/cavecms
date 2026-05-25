// Node-runtime DB client (no `server-only` guard).
// Used by build-time CLIs (seed, migrations) that run outside Next's
// Server Component context. App code should import from `db/client` instead.

import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'
import { env } from '@/lib/env'

// Pinned to globalThis so dev HMR doesn't create a new pool + listener
// stack on every reload (would trip MaxListenersExceededWarning) and
// doesn't leak connections.
declare global {
  var __cavecmsMysqlPool: ReturnType<typeof mysql.createPool> | undefined
  var __cavecmsMysqlPoolInit: true | undefined
}

const pool = globalThis.__cavecmsMysqlPool ?? mysql.createPool({
  uri: env.DATABASE_URL,
  connectionLimit: env.DB_POOL_LIMIT,
  waitForConnections: true,
  queueLimit: 50,
  connectTimeout: 5000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
  timezone: '+00:00',
})
globalThis.__cavecmsMysqlPool = pool

if (!globalThis.__cavecmsMysqlPoolInit) {
  globalThis.__cavecmsMysqlPoolInit = true
  // Pool-level error handler — mysql2 emits 'error' events when the
  // pool itself (not an individual query) hits an unrecoverable state
  // (network reset on an idle conn, MaxScale failover, wait_timeout).
  // Without a listener, Node promotes to uncaughtException → process
  // exit; the pool would otherwise transparently re-establish on the
  // next checkout. Cast to EventEmitter — drizzle's pool wrapper types
  // omit the 'error' event despite mysql2 supporting it at runtime.
  ;(pool as unknown as NodeJS.EventEmitter).on('error', (err: Error) => {
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'mysql_pool_error',
        err: err.message,
      }),
    )
  })
  // max_statement_time bounds SELECT runtime per-session (MariaDB only;
  // MySQL uses MAX_EXECUTION_TIME hints differently). INSERT/UPDATE/DELETE
  // are NOT covered. Failures here mean the SELECT cap is not enforced —
  // we log loud but DO NOT destroy the connection (old MariaDB lacks the
  // variable; destroying would cause a connect-loop and pool starvation).
  pool.on('connection', (conn) => {
    // The 'connection' event from mysql2/promise's pool actually hands back
    // the raw (non-promise) mysql2 connection — `.query()` returns a query
    // stream, NOT a Promise (TS types disagree with runtime here). Use the
    // callback signature via a cast so we don't fall into the
    // await-on-non-promise trap.
    const raw = conn as unknown as {
      query: (sql: string, cb: (err: Error | null) => void) => void
    }
    raw.query(
      `SET SESSION max_statement_time = ${env.DB_STATEMENT_TIMEOUT_MS / 1000}`,
      (err) => {
        if (!err) return
        console.error(JSON.stringify({
          level: 'error',
          msg: 'mysql_set_session_failed',
          err: err.message,
          note: 'SELECT statement timeout NOT enforced on this connection. Verify MariaDB >= 10.1.1.',
        }))
      },
    )
  })
}

export const db = drizzle(pool, { schema, mode: 'default' })
export { pool }
