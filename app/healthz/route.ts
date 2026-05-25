import { timingSafeEqual } from 'node:crypto'
import { pool } from '@/db/client'
import { env } from '@/lib/env'

const STARTED_AT = Date.now()

export const dynamic = 'force-dynamic'

interface InternalPool {
  pool?: {
    config?: { connectionLimit?: number }
    _allConnections?: { length?: number }
    _freeConnections?: { length?: number }
  }
}

let warnedAboutPoolShape = false

function readPoolFreeOrNull(p: typeof pool): number | null {
  // mysql2 internals are not part of the public API. We log loud once
  // if the shape changes (e.g., after a mysql2 upgrade) and return null
  // so dashboards can alert on absence rather than trust a fabricated
  // number.
  //
  // CORRECTION (audit M8): `_allConnections.length` is the TOTAL count
  // of provisioned connections (idle + active). `_freeConnections.length`
  // is the queue of immediately-available idle ones. The metric we
  // actually want — "how much pool capacity is free RIGHT NOW" —
  // accounts for both: unprovisioned slots (limit - total) PLUS idle
  // provisioned slots (free queue length). Pre-fix this returned
  // `limit - total` only, which under steady-state (all conns
  // provisioned, all idle) reported 0 free even though every conn was
  // available.
  const internal = p as unknown as InternalPool
  const limit = internal.pool?.config?.connectionLimit
  const total = internal.pool?._allConnections?.length
  const idleFree = internal.pool?._freeConnections?.length
  if (
    typeof limit !== 'number' ||
    typeof total !== 'number' ||
    typeof idleFree !== 'number'
  ) {
    if (!warnedAboutPoolShape) {
      warnedAboutPoolShape = true
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'mysql2_pool_shape_changed',
          note: 'pool._allConnections / _freeConnections / config.connectionLimit not found — mysql2 likely upgraded; healthz pool_free now reports null',
        }),
      )
    }
    return null
  }
  // Unprovisioned slots + idle provisioned slots.
  return Math.max(0, limit - total) + idleFree
}

function authorizedForVerbose(req: Request): boolean {
  // Verbose mode requires the HEALTHZ_TOKEN bearer in production. In
  // dev/test we always emit verbose for convenience. We do NOT trust any
  // client-controllable header (e.g. x-real-ip) for trust decisions —
  // an attacker behind a misconfigured proxy could spoof loopback.
  if (env.NODE_ENV !== 'production') return true
  const token = env.HEALTHZ_TOKEN
  if (!token) return false
  const auth = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/.exec(auth)
  if (!m || !m[1]) return false
  const presented = Buffer.from(m[1])
  const expected = Buffer.from(token)
  if (presented.length !== expected.length) return false
  return timingSafeEqual(presented, expected)
}

export async function GET(req: Request): Promise<Response> {
  let dbPing: 'ok' | 'fail' = 'ok'
  let poolFree: number | null = null
  try {
    const c = await pool.getConnection()
    try {
      await c.query('SELECT 1')
    } finally {
      c.release()
    }
    poolFree = readPoolFreeOrNull(pool)
  } catch {
    dbPing = 'fail'
  }

  const verbose = authorizedForVerbose(req)
  const body = verbose
    ? {
        status: dbPing === 'ok' ? 'ok' : 'degraded',
        commit: env.CAVECMS_COMMIT,
        db_ping: dbPing,
        pool_free: poolFree,
        uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
      }
    : { status: dbPing === 'ok' ? 'ok' : 'degraded' }

  // Status code reflects actual health regardless of verbose. Uptime
  // monitors must see 503 when the DB is unreachable.
  return new Response(JSON.stringify(body), {
    status: dbPing === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
  })
}
