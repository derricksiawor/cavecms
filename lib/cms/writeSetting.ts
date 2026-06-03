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

const MAX_CAS_ATTEMPTS = 6

// Compare-and-swap upsert of a single settings key from server code that is NOT
// the operator PATCH route (OAuth connect/disconnect, the scheduler, the cloud
// token reconciler). Reads the current row + version, applies `mutate`,
// re-validates against the registry schema, then writes with an optimistic
// `version` guard and RETRIES on a lost race so two concurrent writers to the
// same key (e.g. the poll route persisting a token while the reconciler
// persists a rotated one) can't silently clobber each other. `updatedBy` is the
// admin userId for interactive routes, or null for system writes.
export async function updateSettingValue<K extends SettingsKey>(
  key: K,
  mutate: (current: SettingsValue<K>) => SettingsValue<K>,
  updatedBy: number | null,
): Promise<SettingsValue<K>> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const rows = await db
      .select({ value: settings.value, version: settings.version })
      .from(settings)
      .where(eq(settings.key, key))
    const existing = rows[0]

    let current: SettingsValue<K>
    if (existing) {
      const raw =
        typeof existing.value === 'string' ? JSON.parse(existing.value) : existing.value
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
      // No row yet — INSERT. A concurrent insert wins the PK race and throws a
      // duplicate-key error; retry (we'll take the UPDATE path next pass).
      try {
        await db.execute(sql`
          INSERT INTO settings (\`key\`, value, version, updated_by)
          VALUES (${key}, ${json}, 1, ${updatedBy})
        `)
        await safeRevalidate([tag.settings]).catch(() => undefined)
        return next
      } catch {
        continue
      }
    }

    // Optimistic UPDATE guarded on the version we read. affectedRows === 0 means
    // another writer bumped the version between our SELECT and UPDATE → retry.
    const result = (await db.execute(sql`
      UPDATE settings
      SET value = ${json}, version = version + 1, updated_by = ${updatedBy}
      WHERE \`key\` = ${key} AND version = ${existing.version}
    `)) as unknown as [{ affectedRows?: number } | undefined]
    const affected = result?.[0]?.affectedRows ?? 0
    if (affected > 0) {
      await safeRevalidate([tag.settings]).catch(() => undefined)
      return next
    }
    // else: lost the race — loop and re-read.
  }
  throw new Error('settings_write_contention')
}
