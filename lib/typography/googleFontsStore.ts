import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'
import type { SettingsValue } from '@/lib/cms/settings-registry'

// Activated Google font registry shape — the `google_fonts` setting. Same
// member shape as a CustomFont so the CSS emitter + picker treat them alike.
export type GoogleActivatedFont = SettingsValue<'google_fonts'>[number]

// Serialises ALL google_fonts read-modify-write across BOTH the activation
// (POST) and deactivation (DELETE) endpoints. Mirrors customFontsStore — a
// promise-chain mutex queues writers so two concurrent activations don't each
// read the same array, append, and write (lost update). Separate mutex from
// custom_fonts is correct: they're different settings rows, so they never
// contend, and serialising them together would needlessly block. Per-process
// (single-instance PM2); for multi-instance, move to a SELECT … FOR UPDATE on
// the settings row.
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
 * Atomically read the google_fonts registry, apply `mutate`, persist, and
 * revalidate the settings cache. `mutate` may throw to abort (e.g. cap
 * exceeded) — nothing is written in that case. Returns the new array.
 */
export function mutateGoogleFonts(
  userId: number,
  mutate: (current: GoogleActivatedFont[]) => GoogleActivatedFont[],
): Promise<GoogleActivatedFont[]> {
  return runExclusive(async () => {
    const current = (await getSetting('google_fonts')) as GoogleActivatedFont[]
    const next = mutate([...current])
    await db.execute(sql`
      INSERT INTO settings (\`key\`, value, version, updated_by)
      VALUES ('google_fonts', ${JSON.stringify(next)}, 1, ${userId})
      ON DUPLICATE KEY UPDATE value = VALUES(value), version = version + 1, updated_by = VALUES(updated_by)
    `)
    // Invalidate the 'settings' cache so getSetting('google_fonts') is fresh on
    // the next render (the layout emits the @font-face from it).
    await safeRevalidate([tag.settings]).catch(() => undefined)
    return next
  })
}
