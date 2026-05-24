import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { registry, type SettingsKey, type SettingsValue } from '@/lib/cms/settings-registry'

// Bypass-cache reader for settings rows. lib/cms/getSetting uses
// unstable_cache + the 'settings' tag — that's the right tool for
// public renderers (cached across requests, busted on PATCH). The
// admin Integrations test/forms/fields endpoints and the CRM
// dispatch helpers need the LATEST stored credentials immediately
// (e.g., "operator just saved a new token, now test it" — the
// cache miss only happens after the tag bust propagates). Hitting
// the DB directly here adds <1ms and removes the timing hazard.
//
// Same fail-closed-on-parse contract as the cached reader: a
// tampered/older-shape JSON cell becomes the registry default
// instead of crashing the caller.

export async function getRawSetting<K extends SettingsKey>(
  key: K,
): Promise<SettingsValue<K>> {
  const [rows] = (await db.execute(sql`
    SELECT value FROM settings WHERE \`key\` = ${key}
  `)) as unknown as [Array<{ value: unknown }>]
  const def = registry[key].default as SettingsValue<K>
  const row = rows[0]
  if (!row) return def
  let candidate: unknown = row.value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch (err) {
      // Silent fallback would mask a corrupted row indefinitely.
      // Structured log surfaces it via journalctl / log aggregation
      // even though the renderer keeps working.
      console.error(JSON.stringify({
        level: 'error',
        msg: 'getRawSetting_json_parse_failed',
        key,
        err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      }))
      return def
    }
  }
  const parsed = registry[key].schema.safeParse(candidate)
  if (!parsed.success) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'getRawSetting_schema_invalid',
      key,
      issue: parsed.error.issues[0]?.message ?? 'unknown',
    }))
    return def
  }
  return parsed.data as SettingsValue<K>
}
