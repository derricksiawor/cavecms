import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

// Detect whether this CaveCMS install has completed first-boot setup.
//
// Two signals, checked together:
//
//   1. settings.install_state.completedAt — set by the install
//      wizard's final "Finish" step. Primary signal: this is what
//      flips the middleware from "redirect everything to /install"
//      to "lock /install permanently".
//
//   2. At least one active admin user exists — secondary check.
//      Catches the case where settings hasn't been written yet (or
//      was manually cleared) but an admin is somehow on file.
//
// Both must be present for "installed" — the middleware decides
// based on signal #1, but signal #2 backstops the API endpoints to
// prevent a second admin being created via the wizard if someone
// hand-cleared the settings row.
//
// Cached in-memory for 5s. Installation is a one-time event; once
// installed we'd never naturally regress.

interface CacheEntry {
  isInstalled: boolean
  expiresAt: number
}
let cache: CacheEntry | null = null
const TTL_MS = 5_000

interface CountRow {
  n: number | string
}

interface SettingsRow {
  value: unknown
}

export async function isInstalled(): Promise<boolean> {
  if (cache && cache.expiresAt > Date.now()) return cache.isInstalled
  let installed = false
  let dbReachable = true

  // Step 1: count active admins. This is the canonical signal — if
  // no admin exists, we're pre-install regardless of any settings
  // row.
  let adminCount = 0
  try {
    const [adminRows] = (await db.execute(sql`
      SELECT COUNT(*) AS n FROM users
      WHERE active = TRUE AND role = 'admin'
    `)) as unknown as [Array<{ n: number | string }>]
    adminCount = Number(adminRows[0]?.n ?? 0)
  } catch (err) {
    // Distinguish "users table doesn't exist yet" (truly fresh
    // deploy pre-migrations) from "DB hiccup" (transient outage on
    // a healthy install). The former should show the wizard; the
    // latter must NEVER show the wizard to live users.
    const code = (err as NodeJS.ErrnoException & { code?: string }).code
    const message = err instanceof Error ? err.message.toLowerCase() : ''
    const tableMissing =
      code === 'ER_NO_SUCH_TABLE' ||
      /no such table|table.*doesn't exist|table.*does not exist/.test(message)
    if (tableMissing) {
      // Pre-migrations → truly fresh deploy → wizard.
      installed = false
      dbReachable = true
    } else {
      // Connection issue / unknown error on a previously-working
      // DB → conservative: treat as installed so existing visitors
      // never see the wizard during a hiccup. Cache briefly so we
      // re-probe fast once the DB recovers.
      installed = true
      dbReachable = false
    }
    cache = {
      isInstalled: installed,
      expiresAt: Date.now() + (dbReachable ? TTL_MS : 1_000),
    }
    return installed
  }

  // Step 2: trust the install_state.completedAt field if it exists.
  // The CRITICAL invariant: while the install wizard is mid-flow,
  // adminCount === 1 but completedAt is NOT set. We must NOT auto-flip
  // completedAt during the wizard — doing so locks the wizard out of
  // its own optional follow-up steps (branding, contact, smtp,
  // security-baseline) because /api/install/* refuses once installed.
  //
  // Legacy auto-migrate: ONLY fires when there is no install_state row
  // at all (truly pre-wizard install upgrading to this code, where an
  // admin exists but the install_state machinery was never run). If the
  // row exists, we trust whatever it says — empty completedAt means the
  // wizard is mid-flow.
  if (adminCount > 0) {
    try {
      const [rows] = (await db.execute(sql`
        SELECT value FROM settings WHERE \`key\` = 'install_state'
      `)) as unknown as [SettingsRow[]]
      const row = rows[0]
      if (!row) {
        // Legacy install: no row at all. Synthesize one with completedAt
        // set so middleware locks /install. THIS PATH is for upgrades from
        // a CaveCMS that predates the install_state machinery — current
        // installs always have at least the pending row from admin-create.
        const value = JSON.stringify({
          completedAt: new Date().toISOString(),
          migratedFromLegacy: true,
        })
        await db.execute(sql`
          INSERT INTO settings (\`key\`, value, version, updated_by)
          VALUES ('install_state', ${value}, 1, NULL)
          ON DUPLICATE KEY UPDATE
            value = VALUES(value),
            version = version + 1
        `)
        installed = true
      } else {
        const raw = row.value
        const parsed =
          typeof raw === 'string'
            ? (() => {
                try {
                  return JSON.parse(raw) as { completedAt?: string }
                } catch {
                  return null
                }
              })()
            : (raw as { completedAt?: string } | null | undefined)
        // Row exists: trust completedAt. Empty/missing means wizard is
        // mid-flow → NOT installed.
        installed = Boolean(parsed?.completedAt)
      }
    } catch {
      // Settings write/read failed. Conservative: if an admin exists
      // but we can't read install_state, treat as installed so live
      // visitors never bounce to /install during a hiccup. The
      // wizard-mid-flow case here is rare (DB error between admin
      // creation and the next step) and the operator can retry.
      installed = true
    }
  }

  cache = { isInstalled: installed, expiresAt: Date.now() + TTL_MS }
  return installed
}

/**
 * Stricter check used by /api/install/admin-create: even if the
 * settings flag isn't yet set, refuse to create a second admin if
 * one already exists. Race guard.
 */
export async function hasAnyActiveAdmin(): Promise<boolean> {
  try {
    const [rows] = (await db.execute(sql`
      SELECT COUNT(*) AS n FROM users WHERE active = TRUE AND role = 'admin'
    `)) as unknown as [CountRow[]]
    return Number(rows[0]?.n ?? 0) > 0
  } catch {
    return false
  }
}

/** Test-only cache buster. */
export function __resetInstallStateCache(): void {
  cache = null
}
