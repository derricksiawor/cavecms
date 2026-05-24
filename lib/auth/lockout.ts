import 'server-only'
import { db } from '@/db/client'
import { sql, eq } from 'drizzle-orm'
import {
  loginAttempts,
  failedLoginsByEmail,
  failedLoginsByIp,
} from '@/db/schema'
import { env } from '@/lib/env'

function parseCsvInts(csv: string, label: string): number[] {
  const parts = csv.split(',').map((s) => s.trim())
  if (parts.some((s) => s === '' || !/^[0-9]+$/.test(s))) {
    throw new Error(`${label} must be a CSV of positive integers (got "${csv}")`)
  }
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`${label} entries must be positive integers (got "${csv}")`)
  }
  return nums
}

const THRESHOLDS = parseCsvInts(env.LOCKOUT_THRESHOLDS, 'LOCKOUT_THRESHOLDS')
const DURATIONS_MIN = parseCsvInts(env.LOCKOUT_DURATIONS_MIN, 'LOCKOUT_DURATIONS_MIN')
// computeLockState's SQL hardcodes 3 windows (10m, 1h, 24h). Tier count must
// match exactly — fewer means a tier is unreachable; more means silent no-op.
if (THRESHOLDS.length !== 3 || DURATIONS_MIN.length !== 3) {
  throw new Error('LOCKOUT_THRESHOLDS and LOCKOUT_DURATIONS_MIN must each have exactly 3 entries (one per 10m/1h/24h window)')
}
for (let i = 1; i < THRESHOLDS.length; i++) {
  const a = THRESHOLDS[i - 1]
  const b = THRESHOLDS[i]
  if (a === undefined || b === undefined || b <= a) {
    throw new Error('LOCKOUT_THRESHOLDS must be strictly ascending (e.g. 3,6,9)')
  }
}
const MAX_DURATION_MIN = 7 * 24 * 60 // 1 week — sanity cap
for (const d of DURATIONS_MIN) {
  if (d > MAX_DURATION_MIN) {
    throw new Error(`LOCKOUT_DURATIONS_MIN entry ${d} exceeds sanity cap of ${MAX_DURATION_MIN} minutes`)
  }
}

// MySQL TIMESTAMP minimum is '1970-01-01 00:00:01' UTC; using exactly the
// epoch (Date(0)) can be rejected under strict sql_mode + NO_ZERO_DATE.
const EPOCH = new Date(1000)

export interface LockState {
  locked: boolean
  eCounts: number[]
  iCounts: number[]
}

export async function computeLockState(args: { email: string; ip: string }): Promise<LockState> {
  // Resolve lock-row state first, in parallel. We pull `reset_at` from el so
  // the aggregate query can pass it as a parameter rather than running a
  // correlated subquery (faster and easier to reason about).
  const [el, il] = await Promise.all([
    db.select().from(failedLoginsByEmail).where(eq(failedLoginsByEmail.email, args.email)).then((rows) => rows[0]),
    db.select().from(failedLoginsByIp).where(eq(failedLoginsByIp.ip, args.ip)).then((rows) => rows[0]),
  ])
  const resetAt = el?.resetAt ?? EPOCH

  // Per-tier SUMs apply the reset_at filter ON THE ROW BOOLEAN, so a row that
  // matches the IP-side OR branch in the WHERE clause but pre-dates the email
  // reset is still excluded from the email aggregate (the IP aggregate
  // intentionally counts ALL failures regardless of any per-account reset —
  // shared-NAT defense).
  const [aggRows] = await db.execute(sql`
    SELECT
      SUM(success=0 AND email=${args.email} AND created_at > ${resetAt} AND created_at > NOW() - INTERVAL 10 MINUTE) AS e10m,
      SUM(success=0 AND email=${args.email} AND created_at > ${resetAt} AND created_at > NOW() - INTERVAL 1  HOUR  ) AS e1h,
      SUM(success=0 AND email=${args.email} AND created_at > ${resetAt} AND created_at > NOW() - INTERVAL 24 HOUR ) AS e24h,
      SUM(success=0 AND ip   =${args.ip}    AND created_at > NOW() - INTERVAL 10 MINUTE) AS i10m,
      SUM(success=0 AND ip   =${args.ip}    AND created_at > NOW() - INTERVAL 1  HOUR  ) AS i1h,
      SUM(success=0 AND ip   =${args.ip}    AND created_at > NOW() - INTERVAL 24 HOUR ) AS i24h
    FROM login_attempts
    WHERE created_at > NOW() - INTERVAL 24 HOUR
      AND (email = ${args.email} OR ip = ${args.ip})
  `)
  const r = (aggRows as unknown as Array<Record<string, number | string | null>>)[0] ?? {}
  const num = (k: string): number => Number(r[k] ?? 0)
  const e = [num('e10m'), num('e1h'), num('e24h')]
  const i = [num('i10m'), num('i1h'), num('i24h')]

  const now = Date.now()
  const lockedByEmail = !!(el?.lockedUntil && el.lockedUntil.getTime() > now)
  const lockedByIp = !!(il?.lockedUntil && il.lockedUntil.getTime() > now)
  return { locked: lockedByEmail || lockedByIp, eCounts: e, iCounts: i }
}

async function applyLockToEmail(email: string, totalCount: number, durationMin: number): Promise<void> {
  const lockUntil = new Date(Date.now() + durationMin * 60_000)
  await db.execute(sql`
    INSERT INTO failed_logins_by_email (email, count, locked_until, last_failure_at)
    VALUES (${email}, ${totalCount}, ${lockUntil}, NOW())
    ON DUPLICATE KEY UPDATE count = VALUES(count), locked_until = VALUES(locked_until), last_failure_at = NOW()
  `)
}

async function applyLockToIp(ip: string, totalCount: number, durationMin: number): Promise<void> {
  const lockUntil = new Date(Date.now() + durationMin * 60_000)
  await db.execute(sql`
    INSERT INTO failed_logins_by_ip (ip, count, locked_until, last_failure_at)
    VALUES (${ip}, ${totalCount}, ${lockUntil}, NOW())
    ON DUPLICATE KEY UPDATE count = VALUES(count), locked_until = VALUES(locked_until), last_failure_at = NOW()
  `)
}

export async function recordFailure(args: {
  email: string
  ip: string
  userAgent: string
  reason: string
  preCheckedState?: LockState
}): Promise<void> {
  // Explicit createdAt so it shares ms precision with reset_at (the schema's
  // defaultNow() resolves to MySQL NOW() which truncates to seconds, causing
  // the reset_at comparison to misorder events under sub-second timing).
  await db.insert(loginAttempts).values({
    email: args.email,
    ip: args.ip,
    userAgent: args.userAgent,
    success: false,
    failureReason: args.reason,
    createdAt: new Date(),
  })

  let eCounts: number[]
  let iCounts: number[]
  if (args.preCheckedState) {
    eCounts = args.preCheckedState.eCounts.map((n) => n + 1)
    iCounts = args.preCheckedState.iCounts.map((n) => n + 1)
  } else {
    const fresh = await computeLockState({ email: args.email, ip: args.ip })
    eCounts = fresh.eCounts
    iCounts = fresh.iCounts
  }

  // Tier index 0 = 10m, 1 = 1h, 2 = 24h. Fixed-length 3 enforced at module load.
  //
  // Resolve the two lock-application promises in parallel via
  // allSettled — pre-fix, if applyLockToEmail threw under lock
  // contention (the exact failure mode the lockout is defending
  // against under a brute-force burst) applyLockToIp never ran and
  // the IP-axis lockout silently lapsed. Per-rejection logging keeps
  // the forensic signal while the route-side response (the caller's
  // generic 401) stays consistent.
  const lockApplies: Promise<unknown>[] = []
  for (let tier = THRESHOLDS.length - 1; tier >= 0; tier--) {
    const count = eCounts[tier] ?? 0
    const threshold = THRESHOLDS[tier] ?? Infinity
    if (count >= threshold) {
      lockApplies.push(
        applyLockToEmail(args.email, count, DURATIONS_MIN[tier] ?? 0),
      )
      break
    }
  }
  for (let tier = THRESHOLDS.length - 1; tier >= 0; tier--) {
    const count = iCounts[tier] ?? 0
    const threshold = THRESHOLDS[tier] ?? Infinity
    if (count >= threshold) {
      lockApplies.push(
        applyLockToIp(args.ip, count, DURATIONS_MIN[tier] ?? 0),
      )
      break
    }
  }
  if (lockApplies.length > 0) {
    const results = await Promise.allSettled(lockApplies)
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'lockout_apply_failed',
            err:
              r.reason instanceof Error
                ? r.reason.message
                : String(r.reason),
          }),
        )
      }
    }
  }
}

export async function recordSuccess(args: {
  email: string
  ip: string
  userId: number
  userAgent: string
}): Promise<void> {
  await db.insert(loginAttempts).values({
    email: args.email,
    ip: args.ip,
    userAgent: args.userAgent,
    success: true,
    createdAt: new Date(),
  })
  // Reset email-side lock state. We UPSERT a reset_at marker rather than
  // DELETE so computeLockState's window queries naturally exclude failures
  // that pre-date the success — preventing a victim from being re-locked
  // by a single follow-up bad password against the residual ledger.
  // We do NOT clear the IP lock: shared egress (corporate NAT, mobile
  // carriers, VPN exits) means another account's success on the same IP
  // must not unlock the IP for an unrelated brute-force. The IP lock
  // expires passively when locked_until passes.
  // Node-supplied Date so all timestamps share ms precision. We set reset_at
  // to 1 ms in the past so a subsequent failure that lands in the SAME ms
  // (very fast attacker, or test races) is still classified as post-reset
  // (its created_at strictly > reset_at). Prior failures by definition have
  // created_at older than now-1ms, so they remain excluded.
  // resetAt is 1 ms in the past so a subsequent failure that lands in the
  // SAME ms (very fast attacker, or test races) is still classified as
  // post-reset. Use NOW for last_success_at — that timestamp is informational
  // and should reflect the actual success time, not the cutoff marker.
  const resetAt = new Date(Date.now() - 1)
  const successAt = new Date()
  // Bookkeeping writes after a successful auth verdict — the JWT has
  // already been signed at this point. Promise.allSettled (not all) so a
  // transient failure on EITHER table doesn't fail the entire login:
  // both writes are forensic (lockout counter reset + known-IP log),
  // not part of the auth contract. Pre-fix a brute-force burst that
  // hot-locked failed_logins_by_email broke EVERY legitimate login.
  const [r1, r2] = await Promise.allSettled([
    db.execute(sql`
      INSERT INTO failed_logins_by_email (email, count, locked_until, last_failure_at, reset_at)
      VALUES (${args.email}, 0, NULL, ${successAt}, ${resetAt})
      ON DUPLICATE KEY UPDATE count = 0, locked_until = NULL, reset_at = ${resetAt}
    `),
    db.execute(sql`
      INSERT INTO user_known_ips (user_id, ip, last_success_at)
      VALUES (${args.userId}, ${args.ip}, ${successAt})
      ON DUPLICATE KEY UPDATE last_success_at = ${successAt}
    `),
  ])
  if (r1.status === 'rejected') {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'lockout_reset_email_failed',
        err: r1.reason instanceof Error ? r1.reason.message : String(r1.reason),
      }),
    )
  }
  if (r2.status === 'rejected') {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'lockout_known_ip_failed',
        err: r2.reason instanceof Error ? r2.reason.message : String(r2.reason),
      }),
    )
  }
}
