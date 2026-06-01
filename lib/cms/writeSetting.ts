import { sql, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { settings } from '@/db/schema/settings'
import {
  registry,
  type SettingsKey,
  type SettingsValue,
} from '@/lib/cms/settings-registry'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'

// Optimistic upsert of a single settings key from server code that is NOT the
// operator PATCH route (OAuth connect/disconnect, the scheduler). Reads the
// current row, applies `mutate`, re-validates against the registry schema,
// then INSERTs (absent) or UPDATEs (present) and busts the settings cache tag.
// `updatedBy` is the admin userId for interactive routes, or null for system
// writes (e.g. the scheduler).
export async function updateSettingValue<K extends SettingsKey>(
  key: K,
  mutate: (current: SettingsValue<K>) => SettingsValue<K>,
  updatedBy: number | null,
): Promise<SettingsValue<K>> {
  const rows = await db
    .select({ value: settings.value, version: settings.version })
    .from(settings)
    .where(eq(settings.key, key))
  const existing = rows[0]

  let current: SettingsValue<K>
  if (existing) {
    const raw =
      typeof existing.value === 'string'
        ? JSON.parse(existing.value)
        : existing.value
    const parsed = registry[key].schema.safeParse(raw)
    current = (parsed.success ? parsed.data : registry[key].default) as SettingsValue<K>
  } else {
    current = registry[key].default as SettingsValue<K>
  }

  const mutated = mutate(current)
  // Re-validate: a bad mutation throws here, never reaching the DB.
  const next = registry[key].schema.parse(mutated) as SettingsValue<K>
  const json = JSON.stringify(next)

  if (!existing) {
    await db.execute(sql`
      INSERT INTO settings (\`key\`, value, version, updated_by)
      VALUES (${key}, ${json}, 1, ${updatedBy})
    `)
  } else {
    await db.execute(sql`
      UPDATE settings
      SET value = ${json}, version = version + 1, updated_by = ${updatedBy}
      WHERE \`key\` = ${key}
    `)
  }

  await safeRevalidate([tag.settings]).catch(() => undefined)
  return next
}
