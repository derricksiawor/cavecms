import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB client + cache so the helper can be unit-tested without MySQL.
const selectRows: Array<{ value: unknown; version: number }> = []
const executed: Array<{ sql: string }> = []

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => selectRows.slice(),
      }),
    }),
    execute: async (q: { sql?: string } | unknown) => {
      // drizzle sql`` carries .queryChunks; we only assert it ran.
      executed.push({ sql: String((q as { sql?: string }).sql ?? 'exec') })
      return [{ affectedRows: 1 }]
    },
  },
}))

vi.mock('@/lib/cache/revalidate', () => ({ safeRevalidate: async () => undefined }))
vi.mock('@/lib/cache/tags', () => ({ tag: { settings: 'settings' } }))

import { updateSettingValue } from '@/lib/cms/writeSetting'
import { registry } from '@/lib/cms/settings-registry'

beforeEach(() => {
  selectRows.length = 0
  executed.length = 0
})

describe('updateSettingValue', () => {
  it('INSERTs when the row is absent, applying the mutator on top of the default', async () => {
    const next = await updateSettingValue(
      'backups',
      (cur) => ({ ...cur, destination: 'gdrive' }),
      42,
    )
    expect(next.destination).toBe('gdrive')
    // No existing row → an INSERT path ran.
    expect(executed.length).toBe(1)
  })

  it('UPDATEs when a row exists, merging onto the parsed current value', async () => {
    selectRows.push({ value: { ...registry.backups.default, remoteRetention: 5 }, version: 3 })
    const next = await updateSettingValue(
      'backups',
      (cur) => ({ ...cur, keepLocalCopy: false }),
      null,
    )
    expect(next.keepLocalCopy).toBe(false)
    expect(next.remoteRetention).toBe(5) // preserved from the existing row
    expect(executed.length).toBe(1)
  })

  it('re-validates the mutated value against the registry schema', async () => {
    await expect(
      updateSettingValue('backups', (cur) => ({ ...cur, remoteRetention: 9999 }), 1),
    ).rejects.toThrow()
  })
})
