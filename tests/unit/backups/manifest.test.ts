import { describe, it, expect } from 'vitest'
import {
  ManifestSchema,
  evaluateCompat,
  BACKUP_FLOOR_VERSION,
  MIGRATION_0024_BOUNDARY,
} from '@/lib/backups/manifest'

const base = {
  formatVersion: 1,
  kind: 'cavecms-backup',
  createdAt: '2026-05-31T00:00:00Z',
  cavecms: { version: '0.1.60', commit: 'a'.repeat(40) },
  database: {
    name: 'c',
    engine: 'mariadb',
    serverVersion: '10.11.2',
    schemaFingerprint: 'b'.repeat(64),
    migratorEncoding: 'drizzle-hash',
    file: 'database.sql.gz',
    sha256: 'c'.repeat(64),
    sizeBytes: 10,
  },
  uploads: { file: 'uploads.tar.gz', sha256: 'd'.repeat(64), sizeBytes: 10, fileCount: 2 },
  env: { included: false },
  encryption: { scheme: 'none' },
}

const ctx = { installVersion: '0.1.75', installFingerprint: 'x'.repeat(64) }

describe('manifest schema', () => {
  it('exposes the floor + 0024 boundary constants', () => {
    expect(BACKUP_FLOOR_VERSION).toBe('0.1.55')
    expect(typeof MIGRATION_0024_BOUNDARY).toBe('number')
  })
  it('parses a valid manifest', () => {
    expect(ManifestSchema.parse(base).formatVersion).toBe(1)
  })
  it('rejects formatVersion != 1', () => {
    expect(() => ManifestSchema.parse({ ...base, formatVersion: 2 })).toThrow()
  })
  it('rejects unknown migratorEncoding', () => {
    expect(() =>
      ManifestSchema.parse({ ...base, database: { ...base.database, migratorEncoding: 'weird' } }),
    ).toThrow()
  })
})

describe('evaluateCompat', () => {
  it('ok for same-version forward', () => {
    const v = evaluateCompat(ManifestSchema.parse(base), ctx)
    expect(v.refuse).toBe(false)
  })
  it('REFUSE below floor 0.1.55', () => {
    const v = evaluateCompat(
      ManifestSchema.parse({ ...base, cavecms: { ...base.cavecms, version: '0.1.40' } }),
      ctx,
    )
    expect(v.refuse).toBe(true)
    expect(v.reason).toMatch(/too old/i)
  })
  it('REFUSE downgrade (backup newer than install)', () => {
    const v = evaluateCompat(
      ManifestSchema.parse({ ...base, cavecms: { ...base.cavecms, version: '0.1.80' } }),
      ctx,
    )
    expect(v.refuse).toBe(true)
    expect(v.reason).toMatch(/newer/i)
  })
  it('REFUSE filename migrator encoding', () => {
    const v = evaluateCompat(
      ManifestSchema.parse({ ...base, database: { ...base.database, migratorEncoding: 'filename' } }),
      ctx,
    )
    expect(v.refuse).toBe(true)
    expect(v.reason).toMatch(/incompatible/i)
  })
  it('WARN below 0024 boundary', () => {
    const v = evaluateCompat(ManifestSchema.parse({ ...base, cavecms: { ...base.cavecms, version: '0.1.55' } }), {
      ...ctx,
      installMigrationIndex: 25,
      backupMigrationIndex: 20,
    })
    expect(v.refuse).toBe(false)
    expect(v.warnings.join(' ')).toMatch(/older content/i)
  })
})
