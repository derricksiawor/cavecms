import { sql, type SQL } from 'drizzle-orm'

// Drizzle SQL fragment for the day-count portion of `INTERVAL N DAY`.
// Usage:
//   sql`(NOW(3) - INTERVAL ${intervalDays(SOFT_DAYS)} DAY)`
//
// Why a helper instead of `sql.raw(String(n))` at the call site:
//   - Centralises the integer-range validation so a stray
//     `LOGIN_ATTEMPTS_RETENTION_DAYS=` (empty → NaN → `INTERVAL NaN DAY`)
//     cannot reach the DB and silently delete every row.
//   - `sql.raw` interpolates whatever string it's given as a SQL token,
//     no parameterisation. Concentrating that risk behind a validating
//     helper makes review easier — any `sql.raw` outside this file is a
//     red flag.
//
// Bounds: 1 ≤ n ≤ 3650 (one day to ten years). Retention windows above
// ten years almost certainly indicate a config typo; reject loudly.
// Zero-day retention (`intervalDays(0)` → `INTERVAL 0 DAY` → "every
// row where deleted_at < NOW") is a footgun — a single typo'd `=0`
// would hard-delete every soft-deleted row in the table on the next
// cron run. The script-level retention-vars validator at
// `scripts/cron-purge.ts` already rejects `< 1`; this matches that
// floor at the helper layer so a future caller can't bypass it.
//
// Future extensions (`intervalHours`, `intervalSeconds`, `intervalMinutes`)
// live alongside in this file as SEPARATE helpers, each with their own
// per-unit bounds — NOT a generic `interval(unit, n)`, since the
// reasonable bound is unit-specific and a hostile or typo'd unit string
// would itself become a `sql.raw` injection surface.
export function intervalDays(n: number): SQL {
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new Error(
      `intervalDays: expected integer in [1, 3650], got: ${String(n)}`,
    )
  }
  return sql.raw(String(n))
}
