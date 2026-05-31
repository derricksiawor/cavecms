// Backup archive manifest (formatVersion 1) — the cross-version compat anchor.
//
// This is the TS-side schema used by the in-app upload-and-restore route to
// validate an operator-supplied archive before any destructive op. A parallel
// zero-dep validator lives in scripts/backup/backup-lib.mjs for the offline
// CLI path; both share the `formatVersion: 1` contract and the field shape —
// keep them in lockstep on any format change.

import { z } from 'zod'

/** Oldest install version a backup can have been made on and still restore. */
export const BACKUP_FLOOR_VERSION = '0.1.55'

/**
 * Applied-migration count at/after which migration
 * `0024_legacy_block_type_to_lx` is present. A dump whose applied-migration
 * count is BELOW this predates the legacy-block conversion: restoring it then
 * forward-migrating runs 0024, which DELETEs six legacy-only block types
 * (hero, services_intro, about_history, stats_row, star_rating, alert) and
 * converts featured_projects (dropping its curated order). 0024 is the 23rd
 * applied migration, so a fully-migrated-through-0024 dump has >= 23 rows in
 * __drizzle_migrations. A non-blocking WARNING, not a refusal.
 */
export const MIGRATION_0024_BOUNDARY = 23

const sha256 = z.string().regex(/^[a-f0-9]{64}$/i)
const semver = z
  .string()
  .max(64)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$/, 'version must be semver')

export const ManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    kind: z.literal('cavecms-backup'),
    createdAt: z.string().min(1).max(40),
    cavecms: z
      .object({
        version: semver,
        commit: z.string().regex(/^[0-9a-f]{7,64}$/i),
      })
      .strict(),
    database: z
      .object({
        name: z.string().min(1).max(128),
        engine: z.string().min(1).max(32),
        serverVersion: z.string().min(1).max(64),
        schemaFingerprint: sha256,
        migratorEncoding: z.enum(['drizzle-hash', 'filename']),
        /** Count of rows in __drizzle_migrations in the dump (applied count). */
        migrationCount: z.number().int().nonnegative().optional(),
        file: z.literal('database.sql.gz'),
        sha256,
        sizeBytes: z.number().int().nonnegative(),
      })
      .strict(),
    uploads: z
      .object({
        file: z.literal('uploads.tar.gz'),
        sha256,
        sizeBytes: z.number().int().nonnegative(),
        fileCount: z.number().int().nonnegative(),
      })
      .strict(),
    env: z.object({ included: z.boolean() }).strict(),
    encryption: z
      .object({
        scheme: z.enum(['none', 'age']),
        recipient: z.string().max(256).optional(),
      })
      .strict(),
  })
  .strict()

export type Manifest = z.infer<typeof ManifestSchema>

export interface CompatContext {
  /** The install we're restoring ONTO. */
  installVersion: string
  installFingerprint: string
  /** Optional migration indices for the 0024 boundary warning. */
  installMigrationIndex?: number
  backupMigrationIndex?: number
}

export interface CompatVerdict {
  refuse: boolean
  reason?: string
  warnings: string[]
}

/** Numeric semver compare: -1 if a<b, 0 if equal, 1 if a>b. Pre-release/build
 *  metadata is ignored (we only gate on major.minor.patch). */
export function compareSemver(a: string, b: string): number {
  const norm = (v: string) =>
    (v.split(/[-+]/)[0] ?? '0')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const pa = norm(a)
  const pb = norm(b)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da < db) return -1
    if (da > db) return 1
  }
  return 0
}

/**
 * Decide whether an archive may be restored onto the given install.
 * REFUSE: below floor 0.1.55, downgrade (backup newer than install),
 * non-drizzle-hash migrator encoding. WARN: predates the 0024 boundary.
 */
export function evaluateCompat(manifest: Manifest, ctx: CompatContext): CompatVerdict {
  const warnings: string[] = []
  const backupVersion = manifest.cavecms.version

  if (compareSemver(backupVersion, BACKUP_FLOOR_VERSION) < 0) {
    return {
      refuse: true,
      reason: `This backup is too old to restore (made before ${BACKUP_FLOOR_VERSION}).`,
      warnings,
    }
  }

  if (compareSemver(backupVersion, ctx.installVersion) > 0) {
    return {
      refuse: true,
      reason:
        'This backup was made on a newer version of CaveCMS. Update this site to the latest version first, then restore.',
      warnings,
    }
  }

  if (manifest.database.migratorEncoding !== 'drizzle-hash') {
    return {
      refuse: true,
      reason:
        "This backup uses an incompatible migration format and can't be restored here.",
      warnings,
    }
  }

  const backupIdx = ctx.backupMigrationIndex ?? manifest.database.migrationCount
  if (typeof backupIdx === 'number' && backupIdx < MIGRATION_0024_BOUNDARY) {
    warnings.push(
      'This backup predates a content-block format change. A few older content sections ' +
        '(hero, services intro, about history, stats row, star rating, alert) can’t be ' +
        'brought back, and featured-project ordering may need to be re-selected.',
    )
  }

  return { refuse: false, warnings }
}
