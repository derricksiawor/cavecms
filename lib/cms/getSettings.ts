import 'server-only'
import { unstable_cache } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { settings } from '@/db/schema'
import { registry, type SettingsKey, type SettingsValue } from './settings-registry'

// Read + parse one settings row, falling back to the registry default
// when the row is missing or the stored JSON fails Zod validation.
// Fail-closed-on-parse is intentional: a tampered DB cell becomes the
// renderer-safe default rather than an admin-side hand grenade.
async function readSetting<K extends SettingsKey>(
  key: K,
): Promise<SettingsValue<K>> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
  const row = rows[0]
  const def = registry[key].default as SettingsValue<K>
  if (!row) return def
  // MariaDB aliases JSON to LONGTEXT, so mysql2 returns json columns
  // as strings (unlike MySQL native JSON which auto-parses). Drizzle's
  // `db.select` on a json() column passes the string through. Every
  // other JSON column reader in this codebase JSON.parses manually —
  // see lib/cms/hydrate.ts:152 (content_blocks.data), :256
  // (media.variants), :387 (project_sections.data). Mirror the pattern
  // here so Zod sees an object (not a string) and validation passes.
  let candidate: unknown = row.value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'settings_json_parse_failed',
          key,
          err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }),
      )
      return def
    }
  }
  const parsed = registry[key].schema.safeParse(candidate)
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'settings_parse_failed',
        key,
        err: parsed.error.message.slice(0, 200),
      }),
    )
    return def
  }
  return parsed.data as SettingsValue<K>
}

// Build the wrapped function ONCE per key, not on every call. Without
// this memo, every getSetting() call constructs a fresh
// unstable_cache wrapper (closure + internal id hashing + tag
// registration) even when the cached value is hot. Public CMS pages
// hit getSetting 3-5 times per render; the wrapper allocation was
// strictly waste.
//
// Also adds `revalidate: 60` so a stale cached value (e.g., from a
// row that failed Zod and returned the default) self-heals within a
// minute even if no caller explicitly revalidates the 'settings'
// tag. /admin/settings PATCH (Plan 08) revalidates the tag for
// immediate visibility; the timer is defense-in-depth for
// out-of-band fixes (operator runs the seed, raw SQL edit, etc.).
const wrappers = new Map<SettingsKey, () => Promise<unknown>>()

export function getSetting<K extends SettingsKey>(
  key: K,
): Promise<SettingsValue<K>> {
  let fn = wrappers.get(key)
  if (!fn) {
    fn = unstable_cache(() => readSetting(key), ['settings', key], {
      tags: ['settings'],
      revalidate: 60,
    })
    wrappers.set(key, fn)
  }
  return fn() as Promise<SettingsValue<K>>
}
