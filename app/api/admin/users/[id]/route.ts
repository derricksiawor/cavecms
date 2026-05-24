import { z } from 'zod'
import { sql } from 'drizzle-orm'
import type { MySqlTransaction } from 'drizzle-orm/mysql-core'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { invalidateUser } from '@/lib/auth/userCache'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'

const IdParam = z.coerce.number().int().positive().max(2 ** 31 - 1)

const Patch = z
  .object({
    role: z.enum(['admin', 'editor', 'viewer']).optional(),
    active: z.boolean().optional(),
    name: z.string().min(1).max(180).optional(),
  })
  .strict()

// Last-admin invariant: at least ONE row in users with role='admin'
// and active=TRUE must remain after the mutation.
//
// Concurrency model: two TXs that each demote a different admin
// (TX1 targets A, TX2 targets B) MUST NOT deadlock. The fix is to
// have BOTH TXs acquire locks in the same deterministic order:
// first the entire admin set ordered by id, THEN the target row.
//
// `lockAdminSetForUpdate` is called from PATCH/DELETE BEFORE the
// target-row SELECT FOR UPDATE so that two concurrent demotes hit
// the admin scan in the same lock-acquisition order. A previous
// attempt that did "lock target THEN lock-all-admins" deadlocked
// because the target lock disrupted the ascending order.
//
// Drizzle's transaction object isn't typed at the cross-driver level
// (mysql2 / planetscale / d1 use different shapes); the `tx`
// parameter here is parameterized as the generic MySqlTransaction.
type Tx = MySqlTransaction<never, never, never, never>

async function lockAdminSetForUpdate(tx: Tx): Promise<Array<{ id: number }>> {
  const [rows] = (await tx.execute(sql`
    SELECT id FROM users
    WHERE role = 'admin' AND active = TRUE
    ORDER BY id
    FOR UPDATE
  `)) as unknown as [Array<{ id: number }>]
  return rows
}

function assertSurvivingAdmin(
  adminRows: Array<{ id: number }>,
  targetId: number,
  willBeAdminActive: boolean,
): void {
  if (willBeAdminActive) return
  const surviving = adminRows.filter((r) => r.id !== targetId).length
  if (surviving === 0) throw new HttpError(409, 'last_admin_required')
}

export const PATCH = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    await requireFreshReauth(ctx.jti)

    const { id } = await params
    const targetId = IdParam.parse(id)
    const body = Patch.parse(await readJsonBody(req))
    const meta = auditMetaFromRequest(req)

    // Self-modification refusal: an admin cannot demote / deactivate
    // themselves through this endpoint. They can change their own
    // name via the future profile flow; for now we keep the rule
    // strict so a tired operator can't accidentally lock themselves
    // out (and so a stolen session can't immediately defang itself
    // by demoting to viewer to evade the rest of the lockdown).
    if (targetId === ctx.userId) {
      throw new HttpError(409, 'cannot_modify_self')
    }

    // No-op PATCH short-circuits before opening a TX.
    if (
      body.role === undefined &&
      body.active === undefined &&
      body.name === undefined
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      })
    }

    return db.transaction(async (tx) => {
      // Lock the admin set FIRST in ascending-id order. This is the
      // global lock-acquisition ordering — both PATCH and DELETE,
      // every TX, takes admin locks via this call BEFORE touching
      // any other user row. Two concurrent demote calls enter the
      // same wait-chain and serialize instead of deadlocking. The
      // target row is locked AFTER, so non-admin targets don't
      // pollute the admin lock order.
      const adminRows = await lockAdminSetForUpdate(tx as unknown as Tx)

      const [rows] = (await tx.execute(sql`
        SELECT id, role, active, name, email
        FROM users
        WHERE id = ${targetId}
        FOR UPDATE
      `)) as unknown as [
        Array<{
          id: number
          role: 'admin' | 'editor' | 'viewer'
          active: number
          name: string | null
          email: string
        }>,
      ]
      if (!rows[0]) throw new HttpError(404, 'not_found')
      const current = rows[0]

      const willBeAdmin =
        body.role !== undefined ? body.role === 'admin' : current.role === 'admin'
      const willBeActive =
        body.active !== undefined ? body.active : current.active === 1
      // Last-admin check fires only when the resulting state is NOT
      // both admin AND active. Uses the snapshot already locked
      // above — no second SELECT needed.
      assertSurvivingAdmin(adminRows, targetId, willBeAdmin && willBeActive)

      // Compute per-field "changed" flags BEFORE the UPDATEs so the
      // diff and the UPDATE-emission decision share one source of
      // truth. A no-op PATCH (operator clicked Save without changing
      // anything) skips both the UPDATE chain and the audit row.
      const roleChanged =
        body.role !== undefined && body.role !== current.role
      const activeChanged =
        body.active !== undefined &&
        (body.active ? 1 : 0) !== current.active
      const nameChanged =
        body.name !== undefined && body.name !== current.name

      if (!roleChanged && !activeChanged && !nameChanged) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          },
        })
      }

      const diff: Record<string, unknown> = {}
      if (roleChanged) diff.role = { from: current.role, to: body.role }
      if (activeChanged) {
        diff.active = { from: current.active === 1, to: body.active }
      }
      if (nameChanged) diff.name = 'changed'

      // Atomic, parameterized updates. Each branch issues one narrow
      // statement instead of building a dynamic SET clause — drizzle's
      // sql template parameterizes every binding and we avoid the
      // string-concatenation risk of `sql.raw(...)` with dynamic keys.
      //
      // Bumping tokens_valid_after on a role/active change invalidates
      // every issued JWT for the target user; their next request gets
      // a 401 and they re-auth. Adding 1 second guards against clock
      // skew where iat==now() could be considered "still valid".
      const invalidateTokens = roleChanged || activeChanged
      if (roleChanged) {
        await tx.execute(sql`
          UPDATE users SET role = ${body.role} WHERE id = ${targetId}
        `)
      }
      if (activeChanged) {
        await tx.execute(sql`
          UPDATE users SET active = ${body.active} WHERE id = ${targetId}
        `)
      }
      if (nameChanged) {
        await tx.execute(sql`
          UPDATE users SET name = ${body.name} WHERE id = ${targetId}
        `)
      }
      if (invalidateTokens) {
        await tx.execute(sql`
          UPDATE users
          SET tokens_valid_after = NOW(3) + INTERVAL 1 SECOND
          WHERE id = ${targetId}
        `)
      }

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'update',
        resourceType: 'user',
        resourceId: String(targetId),
        diff: diff as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      // Bust the user cache so the next request reads the fresh row
      // instead of waiting for the 30s TTL.
      invalidateUser(targetId)

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      })
    })
  },
)

// Hard DELETE. Removes the users row entirely. Audit-trail integrity
// is preserved by FK cascades:
//   * audit_log.user_id, posts.author_id / updated_by, projects.*
//     updated_by, leads.status_changed_by, content_blocks.updated_by,
//     media.uploaded_by, settings.updated_by  → ON DELETE SET NULL
//     (history survives as user_id=NULL but the actor is anonymised)
//   * user_known_ips.user_id → ON DELETE CASCADE (IP allowlist drops
//     with the user; benign — re-learned on next sign-in if recreated)
//
// Guard rails kept from the old soft-disable path:
//   * Self-delete refused (cannot_modify_self)
//   * Last-admin invariant via lockAdminSetForUpdate (deadlock-safe
//     ordering described in PATCH)
//   * Idempotent: a missing row returns 404 not_found
export const DELETE = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    await requireFreshReauth(ctx.jti)

    const { id } = await params
    const targetId = IdParam.parse(id)
    const meta = auditMetaFromRequest(req)

    if (targetId === ctx.userId) {
      throw new HttpError(409, 'cannot_modify_self')
    }

    return db.transaction(async (tx) => {
      // Lock admin set FIRST (deterministic order) before any other
      // user row — see PATCH for the deadlock-avoidance commentary.
      const adminRows = await lockAdminSetForUpdate(tx as unknown as Tx)

      const [rows] = (await tx.execute(sql`
        SELECT id, email, role FROM users WHERE id = ${targetId} FOR UPDATE
      `)) as unknown as [
        Array<{ id: number; email: string; role: string }>,
      ]
      if (!rows[0]) throw new HttpError(404, 'not_found')
      const row = rows[0]
      assertSurvivingAdmin(adminRows, targetId, false)

      // Audit row written BEFORE the DELETE so a hard failure mid-TX
      // never leaves us with a deleted user and no audit record. The
      // diff captures the email + role at deletion time — useful for
      // forensic triage since the FK to users is about to be nulled.
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'delete',
        resourceType: 'user',
        resourceId: String(targetId),
        diff: { email: row.email, role: row.role } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      await tx.execute(sql`DELETE FROM users WHERE id = ${targetId}`)
      invalidateUser(targetId)
      return new Response(null, { status: 204 })
    })
  },
)
