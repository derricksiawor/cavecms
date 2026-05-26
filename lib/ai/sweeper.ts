import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

// AI proposal lifecycle reaper.
//
// Two responsibilities, run on the same 5-minute tick:
//
//   1. EXPIRE — flip `pending` rows past `expires_at` to `expired`.
//      Without this sweep a stale token sits at `pending` in storage
//      and only flips on a (potentially never-coming) apply attempt.
//      The admin dashboard's pending-list would lie; an out-of-band
//      apply with a leaked token would succeed against a page that
//      has moved on.
//
//   2. HARD-DELETE — physically remove rows in any terminal status
//      (`accepted` / `dismissed` / `expired`) older than 7 days.
//      The forensic trail lives in `audit_log` (every apply / dismiss
//      writes there). Keeping the cart row indefinitely just bloats
//      the table + the per-page-status index. 7 days is enough to
//      debug "where did my proposal go?" during the first day-after,
//      not so much that the table grows unbounded.
//
// Each step caps work at `BATCH_LIMIT` per query to keep the table
// lock window tight. On a packed backlog the next tick continues from
// where the previous one left off. A single tick also re-runs each
// query in a tight loop until it stops finding rows so a normal
// cadence catches up in one tick.
//
// Errors are caught + logged per step; one step's failure doesn't
// halt the other or the interval.

const BATCH_LIMIT = 1000
const HARD_DELETE_AGE_DAYS = 7
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
const FIRST_FIRE_DELAY_MS = 60_000
// Per-tick safety cap on inner-loop iterations. With BATCH_LIMIT=1000
// this lets ONE tick process up to 50K rows per step before yielding
// back to the interval — enough for any realistic backlog without
// monopolising the event loop on a pathological case.
const MAX_INNER_ITERATIONS = 50

export interface SweepResult {
  /** Rows transitioned pending → expired this run. */
  expired: number
  /** Rows hard-deleted (terminal status, > 7d old). */
  hardDeleted: number
  /** End-to-end latency in milliseconds. */
  latencyMs: number
  /** Set when the inner batched loop hit MAX_INNER_ITERATIONS while
   *  still producing full batches — work remains and the next tick
   *  needs to pick it up. Operators read this to distinguish
   *  "finished" from "yielded mid-backlog". */
  truncated: boolean
}

/**
 * Run one full sweep cycle (expire-then-hard-delete). Exposed so
 * integration tests can invoke deterministically without waiting on
 * the 5-min interval, and so an admin-action route could trigger an
 * on-demand sweep in the future.
 *
 * Idempotent + safe to call concurrently — each inner step is a
 * single SQL statement that the DB serialises naturally.
 */
export async function sweepExpiredProposals(): Promise<SweepResult> {
  const t0 = Date.now()
  let expired = 0
  let hardDeleted = 0
  let truncated = false

  // Step 1: expire pending rows. Loop until a tick produces zero
  // affected rows (or we hit the safety cap). Each statement is its
  // own commit boundary so a crash mid-loop only loses the work-in-
  // progress, not the rows already flipped.
  let lastExpireBatch = 0
  let expireIters = 0
  for (let i = 0; i < MAX_INNER_ITERATIONS; i += 1) {
    expireIters = i + 1
    const [result] = (await db.execute(sql`
      UPDATE ai_proposals
      SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at < NOW(3)
      LIMIT ${BATCH_LIMIT}
    `)) as unknown as [{ affectedRows: number }]
    const n = result?.affectedRows ?? 0
    lastExpireBatch = n
    if (n === 0) break
    expired += n
    // If we got a full batch, there's probably more — keep going.
    if (n < BATCH_LIMIT) break
  }
  if (expireIters === MAX_INNER_ITERATIONS && lastExpireBatch === BATCH_LIMIT) {
    truncated = true
  }

  // Step 2: hard-delete terminal-status rows older than 7 days. Driven
  // off `expires_at` (rather than `created_at`) so the existing
  // `idx_ai_proposals_expires` index serves the scan. Because every
  // row carries `expires_at = created_at + 30min`, the semantic is
  // identical to "created over 7 days ago" — a row applied yesterday
  // still has its original 30-min expiry stamp, well within the
  // 7-day exclusion. The audit_log retains the apply / dismiss events
  // so this isn't a forensic loss.
  //
  // sql.raw(HARD_DELETE_AGE_DAYS) is safe: HARD_DELETE_AGE_DAYS is a
  // module-scope integer literal. MariaDB doesn't accept bind
  // parameters in INTERVAL N DAY syntax, so the raw escape is the
  // canonical workaround. DO NOT wire a runtime variable through it.
  let lastDeleteBatch = 0
  let deleteIters = 0
  for (let i = 0; i < MAX_INNER_ITERATIONS; i += 1) {
    deleteIters = i + 1
    const [result] = (await db.execute(sql`
      DELETE FROM ai_proposals
      WHERE status IN ('accepted', 'dismissed', 'expired')
        AND expires_at < NOW(3) - INTERVAL ${sql.raw(String(HARD_DELETE_AGE_DAYS))} DAY
      LIMIT ${BATCH_LIMIT}
    `)) as unknown as [{ affectedRows: number }]
    const n = result?.affectedRows ?? 0
    lastDeleteBatch = n
    if (n === 0) break
    hardDeleted += n
    if (n < BATCH_LIMIT) break
  }
  if (deleteIters === MAX_INNER_ITERATIONS && lastDeleteBatch === BATCH_LIMIT) {
    truncated = true
  }

  return { expired, hardDeleted, latencyMs: Date.now() - t0, truncated }
}

/**
 * Register the periodic sweep on a 5-minute interval. Idempotent
 * across HMR via a globalThis flag — a Next.js dev reload that
 * re-evaluates instrumentation.ts will NOT spawn a second timer.
 *
 * Boot gates handled at the call site (instrumentation.ts):
 *   - NEXT_RUNTIME === 'nodejs'   (skip Edge runtime)
 *   - NODE_ENV !== 'test'         (vitest pool spawns hundreds of
 *                                  child workers; spawning timers in
 *                                  each is wasteful + flaky)
 *   - PM2 cluster-mode refused upstream so two workers don't both
 *     sweep concurrently.
 */
// Global-state shape used by the sweeper. Kept on globalThis so HMR
// in dev doesn't spawn duplicate intervals + so the SIGTERM drain in
// instrumentation.ts can read the in-flight promise across module
// boundaries.
interface SweeperGlobals {
  __cavecmsAiProposalSweeper?: ReturnType<typeof setInterval>
  __cavecmsAiProposalSweeperInFlight?: Promise<void> | null
}

export function startAiProposalSweeper(): void {
  const g = globalThis as unknown as SweeperGlobals
  if (g.__cavecmsAiProposalSweeper) return

  // Re-entrance guard. setInterval fires every SWEEP_INTERVAL_MS
  // regardless of whether the previous tick has resolved; on a
  // backed-up table OR a transient DB stall a >5min sweep would
  // otherwise produce overlapping fire() invocations doubling lock
  // pressure + emitting double-counted log lines.
  //
  // The in-flight value is the actual Promise (not a boolean) so the
  // SIGTERM drain can await it before pool.end() — without that, a
  // sweep mid-`db.execute` gets its statement cut, producing spurious
  // `ai_proposal_sweep_failed` log lines on every reload.
  const fire = (): Promise<void> => {
    if (g.__cavecmsAiProposalSweeperInFlight) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ai_proposal_sweep_overlapped',
          msg: 'previous sweep still in-flight; skipping this tick',
        }),
      )
      return Promise.resolve()
    }
    const p = (async (): Promise<void> => {
      try {
        const result = await sweepExpiredProposals()
        if (result.expired > 0 || result.hardDeleted > 0 || result.truncated) {
          console.info(
            JSON.stringify({
              level: result.truncated ? 'warn' : 'info',
              event: result.truncated
                ? 'ai_proposal_sweep_truncated'
                : 'ai_proposal_sweep',
              expired: result.expired,
              hardDeleted: result.hardDeleted,
              latencyMs: result.latencyMs,
              truncated: result.truncated,
            }),
          )
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'ai_proposal_sweep_failed',
            err:
              err instanceof Error
                ? err.message.slice(0, 200)
                : String(err).slice(0, 200),
          }),
        )
      } finally {
        g.__cavecmsAiProposalSweeperInFlight = null
      }
    })()
    g.__cavecmsAiProposalSweeperInFlight = p
    return p
  }

  // First sweep one minute after boot so the DB pool finishes warming
  // and so a process flapping in a crash loop doesn't keep retrying
  // the sweep on every restart. unref() so a process that exits
  // before the first fire (e.g. failed health check) isn't held alive
  // by the pending timer.
  const firstFire = setTimeout(() => {
    void fire()
  }, FIRST_FIRE_DELAY_MS)
  firstFire.unref?.()

  const handle = setInterval(() => {
    void fire()
  }, SWEEP_INTERVAL_MS)
  handle.unref?.()
  g.__cavecmsAiProposalSweeper = handle
}

/** Tear down the periodic sweeper AND wait for any in-flight tick to
 *  resolve, with a bounded timeout. Used by the SIGTERM drain in
 *  instrumentation.ts so a sweep cannot run during the drain window
 *  (which would otherwise race against pool.end + cut the in-flight
 *  statement, producing a spurious `ai_proposal_sweep_failed` log
 *  line on every reload).
 *
 *  Idempotent + safe to call when no sweeper is registered.
 *  Resolves either when the in-flight sweep completes, or after
 *  `timeoutMs` (defaults to 2s — leaves at least 1s for the rest of
 *  the drain inside PM2's 8s kill_timeout).
 */
export async function stopAiProposalSweeper(timeoutMs = 2_000): Promise<void> {
  const g = globalThis as unknown as SweeperGlobals
  if (g.__cavecmsAiProposalSweeper) {
    clearInterval(g.__cavecmsAiProposalSweeper)
    g.__cavecmsAiProposalSweeper = undefined
  }
  const inFlight = g.__cavecmsAiProposalSweeperInFlight
  if (inFlight) {
    await Promise.race([
      inFlight,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ])
  }
  // Always clear — either the sweep resolved (finally already
  // cleared it) or we timed out and the value is stale.
  g.__cavecmsAiProposalSweeperInFlight = null
}
