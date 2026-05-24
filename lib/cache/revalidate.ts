import 'server-only'
import { revalidateTag } from 'next/cache'
import { db } from '@/db/client'
import { notificationFailures } from '@/db/schema'

/**
 * Best-effort tag revalidation. Wraps next/cache's revalidateTag so a single
 * failure (Next throws on tag misconfig, missing storage, etc.) never
 * propagates back to the save handler — by the time we call this, the DB
 * mutation is already committed and the cache lag is recoverable.
 *
 * On failure, enqueues to notification_failures (kind=revalidate_failed)
 * with a 30s nextRetryAt — a sweeper picks it up on the next page load.
 * The catch on the insert itself is intentional: if the DB is also down,
 * we still want this function to resolve (not throw and orphan the request).
 */
// Hard cap on how long the failure-bookkeeping insert is allowed to
// block. mysql2's `connectTimeout: 5000` only covers initial connect,
// NOT subsequent connection acquires from the wait queue. Under a true
// DB outage (the exact scenario this function exists to log), the
// insert can hang on the pool's queueLimit ladder indefinitely while
// the caller's request lifecycle has ALREADY ended. 3s race prevents
// that — the log line above carries the same signal at half the cost.
const ENQUEUE_TIMEOUT_MS = 3000

export async function safeRevalidate(tags: string[]): Promise<void> {
  await Promise.allSettled(
    tags.map(async (t) => {
      try {
        revalidateTag(t)
      } catch (err) {
        const insertP = db
          .insert(notificationFailures)
          .values({
            kind: 'revalidate_failed',
            payload: { tag: t, error: String(err) },
            nextRetryAt: new Date(Date.now() + 30_000),
          })
          .then(() => undefined)
        const timeoutP = new Promise<void>((_, reject) => {
          setTimeout(
            () => reject(new Error('enqueue_timeout')),
            ENQUEUE_TIMEOUT_MS,
          ).unref?.()
        })
        await Promise.race([insertP, timeoutP]).catch((dbErr: unknown) => {
          // Both revalidateTag AND notification_failures insert failed
          // (or the insert exceeded the 3s race) — probably a DB
          // outage. Log loudly so the operator sees a signal; the
          // in-flight request has already returned to the user and we
          // cannot rethrow from this best-effort path.
          console.error(
            JSON.stringify({
              level: 'error',
              msg: 'revalidate_enqueue_failed',
              tag: t,
              revalidate_err: err instanceof Error ? err.message : String(err),
              db_err: dbErr instanceof Error ? dbErr.message : String(dbErr),
            }),
          )
        })
      }
    }),
  )
}
