import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'
import type { CustomFont } from './customFonts'

// Serialises ALL custom_fonts read-modify-write across BOTH the upload (POST)
// and delete (DELETE) endpoints. Without it, two concurrent writers each read
// the same array, mutate, and write — the second clobbering the first (lost
// update). A promise-chain mutex queues writers so each sees the previous
// one's result. Per-process; matches the in-memory rate-limit / upload-lock
// decision elsewhere (single-instance PM2). For multi-instance, move to a
// row lock (SELECT … FOR UPDATE on the settings row).
let chain: Promise<unknown> = Promise.resolve()

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn)
  // Keep the chain alive regardless of this op's outcome.
  chain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Atomically read the custom_fonts registry, apply `mutate`, persist, and
 * revalidate the settings cache. `mutate` may throw to abort (e.g. cap
 * exceeded) — nothing is written in that case. Returns the new array.
 */
export function mutateCustomFonts(
  userId: number,
  mutate: (current: CustomFont[]) => CustomFont[],
): Promise<CustomFont[]> {
  return runExclusive(async () => {
    const current = (await getSetting('custom_fonts')) as CustomFont[]
    const next = mutate([...current])
    await db.execute(sql`
      INSERT INTO settings (\`key\`, value, version, updated_by)
      VALUES ('custom_fonts', ${JSON.stringify(next)}, 1, ${userId})
      ON DUPLICATE KEY UPDATE value = VALUES(value), version = version + 1, updated_by = VALUES(updated_by)
    `)
    // Invalidate the 'settings' cache so getSetting('custom_fonts') is fresh on
    // the next render (the layout emits the @font-face from it).
    await safeRevalidate([tag.settings]).catch(() => undefined)
    return next
  })
}
