import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { env } from '@/lib/env'
import { getSetting } from '@/lib/cms/getSettings'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'

// Resolution order (highest priority first):
//
//   1. env.LOGIN_PATH_OVERRIDE — break-glass. Operator sets this
//      after a botched DB save + restart, wins over everything else.
//
//   2. pending-revert — if security_login_path_pending row exists
//      AND expiresAt is in the past AND confirmedAt IS NULL, the
//      operator never confirmed the new path loaded. Auto-revert to
//      previousPath and clear the pending row (one-shot — the next
//      call sees no pending row and falls through to DB).
//
//   3. security_login_path.path from DB — the live admin-editable
//      value.
//
//   4. env.LOGIN_PATH — bootstrap fallback for a fresh deploy with
//      no DB row yet. Also catches the corrupt-row case: if the DB
//      cell fails Zod (already returned default by getSetting), the
//      registry default IS env.LOGIN_PATH, so this branch and #3
//      converge on the same value.
//
// Result is the bare segment (e.g. "baccess"), never leading-slash
// prefixed. Callers (middleware-feeding endpoint, dynamic route
// page, login API) format the URL form themselves.

interface PendingRow {
  previous_path: string
  expires_at: Date | string
  confirmed_at: Date | string | null
}

async function readAndMaybeRevertPending(): Promise<string | null> {
  // Cheap probe with a non-locking SELECT first — most callers see
  // no row at all, no need to open a TX or take a row lock.
  const [probe] = (await db.execute(sql`
    SELECT expires_at, confirmed_at
    FROM security_login_path_pending
    WHERE id = 1
  `)) as unknown as [Array<{ expires_at: Date | string; confirmed_at: Date | string | null }>]
  const probeRow = probe[0]
  if (!probeRow) return null
  if (probeRow.confirmed_at) return null
  const probeExp =
    typeof probeRow.expires_at === 'string'
      ? new Date(probeRow.expires_at).getTime()
      : probeRow.expires_at.getTime()
  if (Date.now() < probeExp) return null

  // Probe says "expired + unconfirmed" → open TX, RE-SELECT with FOR
  // UPDATE to lock the row, RE-VERIFY the state hasn't changed (a
  // concurrent saver could have just committed a fresh pending row
  // between the probe and the TX). Only revert if the row we hold is
  // still the same expired-unconfirmed one we expected.
  //
  // The race we're closing: without this re-check, reader's probe
  // returns expired row R1, reader opens TX, in the meantime a saver
  // commits a NEW pending row R2 (previous=R1.new_path, new=newer),
  // reader UPDATEs settings to R1.previous_path (wrong — clobbers
  // the saver's committed change). The lock + re-verify ensures the
  // revert only runs against the row the probe saw.
  let revertedTo: string | null = null
  await db
    .transaction(async (tx) => {
      const [locked] = (await tx.execute(sql`
        SELECT previous_path, expires_at, confirmed_at
        FROM security_login_path_pending
        WHERE id = 1
        FOR UPDATE
      `)) as unknown as [PendingRow[]]
      const row = locked[0]
      if (!row) return // saver-or-confirmer raced us; bail
      if (row.confirmed_at) return
      const exp =
        typeof row.expires_at === 'string'
          ? new Date(row.expires_at).getTime()
          : row.expires_at.getTime()
      if (Date.now() < exp) return
      // State still expired + unconfirmed → revert + clear, atomically.
      await tx.execute(sql`
        UPDATE settings
        SET value = JSON_OBJECT('path', ${row.previous_path}),
            version = version + 1
        WHERE \`key\` = 'security_login_path'
      `)
      await tx.execute(sql`DELETE FROM security_login_path_pending WHERE id = 1`)
      revertedTo = row.previous_path
    })
    .catch(() => undefined)
  if (revertedTo) {
    // Bust settings cache so middleware + dynamic route see the
    // reverted value on next read.
    safeRevalidate([tag.settings]).catch(() => undefined)
  }
  return revertedTo
}

export async function getResolvedLoginPath(): Promise<string> {
  // (1) Break-glass override — short-circuit before any DB read.
  if (env.LOGIN_PATH_OVERRIDE) return env.LOGIN_PATH_OVERRIDE

  // (2) Pending-revert check. Cheap (PK lookup, often returns 0 rows).
  // Not cached intentionally — the auto-revert window is exactly 10
  // minutes from save and the operator might be checking continuously.
  const reverted = await readAndMaybeRevertPending().catch(() => null)
  if (reverted) return reverted

  // (3) Live DB-stored path. getSetting is cached + tag-revalidated;
  // the PATCH handler busts the 'settings' tag on every save.
  const cfg = await getSetting('security_login_path')

  // (4) Defensive: if for any reason cfg.path came back empty, fall
  // back to env. The registry default IS env.LOGIN_PATH, so this only
  // bites if registry is in an inconsistent state.
  return cfg.path || env.LOGIN_PATH
}
