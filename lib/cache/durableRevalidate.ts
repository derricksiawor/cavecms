import 'server-only'
import { sql } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import { db, type Tx } from '@/db/client'

// Durable cache invalidation:
//   1. Inside the save TX, INSERT a notification_failures row with the
//      tag set + nextRetryAt=NOW so it's immediately "due". The row is
//      committed alongside the data mutation — if the process dies after
//      commit but before queueMicrotask drains, the row persists and the
//      Plan 09 sweeper retries it.
//   2. After the TX returns, the route calls drainRevalidate(rowId,tags)
//      in a queueMicrotask. On success → DELETE the row. On revalidate
//      throw → UPDATE attempts++ + push nextRetryAt out; row stays.
//
// safeRevalidate (the throw-only path) remains for callers without a TX
// to enqueue into. Both routes converge on the same notification_failures
// table; the sweeper doesn't need to distinguish.

interface InsertResult {
  insertId: number
}

/**
 * Called inside the save TX. INSERTs a pending row whose payload is the
 * tag set and whose nextRetryAt is NOW(3). Returns the new row's id so
 * the caller can DELETE it on successful revalidate.
 */
export async function enqueueRevalidate(
  tx: Tx,
  tags: string[],
): Promise<number> {
  const [res] = (await tx.execute(sql`
    INSERT INTO notification_failures (kind, payload, attempts, next_retry_at)
    VALUES ('revalidate_pending', ${JSON.stringify({ tags })}, 0, NOW(3))
  `)) as unknown as [InsertResult]
  return Number(res.insertId)
}

/**
 * Called from queueMicrotask AFTER the save TX commits. Best-effort
 * revalidateTag per tag, then either DELETE (all succeeded) or UPDATE the
 * row to bump attempts + push retry. Either branch is wrapped in a catch
 * that swallows — the request lifecycle is over, the user has their
 * response, and a DB outage at this point shouldn't crash the process.
 *
 * NOT callable from CLI / cron context — `revalidateTag` requires Next's
 * `workAsyncStorage` to be populated, which only happens inside a
 * server-component / route-handler / server-action request lifecycle.
 * From a plain Node process every `revalidateTag()` invariant-throws
 * (`static generation store missing`). The cron-purge tag invalidation
 * path uses an internal HTTP endpoint (`/api/internal/revalidate-tags`)
 * so the call lands inside a Next request context.
 */
export async function drainRevalidate(
  rowId: number,
  tags: string[],
): Promise<void> {
  let allOk = true
  for (const t of tags) {
    try {
      revalidateTag(t)
    } catch (err) {
      allOk = false
      console.error(JSON.stringify({
        level: 'error',
        msg: 'revalidate_tag_failed',
        tag: t,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
  if (allOk) {
    await db
      .execute(sql`DELETE FROM notification_failures WHERE id = ${rowId}`)
      .catch((err: unknown) => {
        console.error(JSON.stringify({
          level: 'error',
          msg: 'revalidate_dequeue_failed',
          rowId,
          err: err instanceof Error ? err.message : String(err),
        }))
      })
  } else {
    // Promote pending → failed so sweeper applies backoff policy. attempts
    // increments either branch; the kind flip is the explicit "we tried
    // once, revalidateTag threw" signal.
    await db
      .execute(sql`
        UPDATE notification_failures
        SET kind = 'revalidate_failed',
            attempts = attempts + 1,
            next_retry_at = DATE_ADD(NOW(3), INTERVAL 30 SECOND)
        WHERE id = ${rowId}
      `)
      .catch((err: unknown) => {
        console.error(JSON.stringify({
          level: 'error',
          msg: 'revalidate_retry_update_failed',
          rowId,
          err: err instanceof Error ? err.message : String(err),
        }))
      })
  }
}
