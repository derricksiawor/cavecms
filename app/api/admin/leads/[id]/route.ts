import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { parseSubmission } from '@/lib/leads/submission'

const IdParam = z.coerce.number().int().positive().max(2 ** 31 - 1)

// Editor-side state machine. Admin bypasses (can move any → any).
// new → contacted: standard happy path.
// contacted → won|lost: terminal sale outcome.
// contacted → new: walk-back ("they need more time").
// won|lost: terminal for editors; only admin can re-open via direct
// PATCH which is an explicit override (the audit row pins them).
const StatusTransitions: Record<string, ReadonlyArray<string>> = {
  new: ['contacted'],
  contacted: ['won', 'lost', 'new'],
  won: [],
  lost: [],
}

const Patch = z
  .object({
    status: z.enum(['new', 'contacted', 'won', 'lost']).optional(),
    notes: z.string().max(8000).optional(),
  })
  .strict()

interface LeadDetailRow {
  id: number
  source: string
  name: string | null
  email: string | null
  phone: string | null
  message: string | null
  payload: unknown
  status: string
  notes: string | null
  project_id: number | null
  project_slug: string | null
  project_name: string | null
  ip: string | null
  user_agent: string | null
  status_changed_at: Date | null
  status_changed_by: number | null
  created_at: Date
}

// Detail view is Admin/Editor only. Viewer can browse the masked list
// but never see the raw row — drawing the role line at the API level
// so a future client mistake (e.g. linking from the list to the
// detail for any role) can't leak PII.
export const GET = withError(
  async (_req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin', 'editor'])
    checkReadRate(ctx.userId)
    const { id } = await params
    const leadId = IdParam.parse(id)
    // Filter `p.deleted_at IS NULL` matches the list endpoint so the
    // drawer for a lead whose project was archived doesn't surface the
    // archived slug/name. Without the filter, /admin/leads showed `—`
    // for archived projects but /admin/leads/[id] would expose them.
    const [rows] = (await db.execute(sql`
      SELECT l.id, l.source, l.name, l.email, l.phone, l.message, l.payload,
             l.status, l.notes, l.project_id, l.ip, l.user_agent,
             l.status_changed_at, l.status_changed_by, l.created_at,
             p.slug AS project_slug, p.name AS project_name
      FROM leads l
      LEFT JOIN projects p
        ON p.id = l.project_id AND p.deleted_at IS NULL
      WHERE l.id = ${leadId} AND l.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as [LeadDetailRow[]]
    if (!rows[0]) throw new HttpError(404, 'not_found')
    // Parse the lx_form submission payload server-side. This route is
    // admin/editor-only (no viewer → no masking needed), and the drawer fetches
    // it lazily on open, keeping the 1000-row list response light.
    const detail = { ...rows[0], payload: parseSubmission(rows[0].payload) }
    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  },
)

export const PATCH = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin', 'editor'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const { id } = await params
    const leadId = IdParam.parse(id)
    const body = Patch.parse(await readJsonBody(req))
    const meta = auditMetaFromRequest(req)

    // No-op PATCHes return early — saves the TX and audit row.
    if (body.status === undefined && body.notes === undefined) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      })
    }

    return db.transaction(async (tx) => {
      // SELECT both `status` AND `notes` under the row lock so we can
      // detect no-op writes (operator clicked Save without changing
      // anything) and skip the UPDATE + audit row — avoids audit-feed
      // noise on idle Save clicks.
      const [rows] = (await tx.execute(sql`
        SELECT status, notes FROM leads
        WHERE id = ${leadId} AND deleted_at IS NULL
        FOR UPDATE
      `)) as unknown as [Array<{ status: string; notes: string | null }>]
      if (!rows[0]) throw new HttpError(404, 'not_found')
      const currentStatus = rows[0].status
      const currentNotes = rows[0].notes

      // RBAC + transition check applied only when status actually
      // changes. Editor follows the state machine; admin bypasses.
      if (body.status && body.status !== currentStatus) {
        if (
          ctx.role !== 'admin' &&
          !StatusTransitions[currentStatus]?.includes(body.status)
        ) {
          throw new HttpError(409, 'invalid_status_transition')
        }
      }

      const statusChanged =
        body.status !== undefined && body.status !== currentStatus
      const notesChanged =
        body.notes !== undefined && body.notes !== currentNotes

      // No-op: status and notes both unchanged (or both undefined).
      // Return 200 without writing the UPDATE or audit row — same
      // shape as the upstream no-op short-circuit so the client
      // sees consistent behavior.
      if (!statusChanged && !notesChanged) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          },
        })
      }

      // Two narrow UPDATEs instead of one dynamically-built SET clause.
      // Drizzle's sql tagged template parameterizes every binding; we
      // never assemble SQL by string concatenation. Both run inside
      // the same TX so partial application is impossible.
      if (statusChanged) {
        await tx.execute(sql`
          UPDATE leads
          SET status = ${body.status},
              status_changed_at = NOW(3),
              status_changed_by = ${ctx.userId}
          WHERE id = ${leadId}
        `)
      }
      if (notesChanged) {
        await tx.execute(sql`
          UPDATE leads SET notes = ${body.notes} WHERE id = ${leadId}
        `)
      }

      const diff: Record<string, unknown> = {}
      if (statusChanged) {
        diff.status = { from: currentStatus, to: body.status }
      }
      if (notesChanged) diff.notes = 'updated'

      // Audit row written inside the same TX as the data write — there
      // is no "lead updated but audit missing" state. Notes are
      // never stored in the diff blob to avoid embedding free-form
      // text (and any PII pasted by the operator) in the audit ledger.
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'update',
        resourceType: 'lead',
        resourceId: String(leadId),
        diff: diff as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

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

// Soft delete. Admin only. Sets `deleted_at = NOW(3)`; the row stays
// recoverable for 30 days via /admin/leads?trashed=1 (Restore button)
// then a future nightly cron will hard-purge expired rows. Matches the
// posts + content_blocks pattern.
//
// Before this changed from hard-delete: a miss-clicked bulk delete of
// 50 leads was unrecoverable — name/email/phone/message were wiped
// and only `{ source, status }` survived in the audit blob.
export const DELETE = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const { id } = await params
    const leadId = IdParam.parse(id)
    const meta = auditMetaFromRequest(req)

    return db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT id, source, status FROM leads
        WHERE id = ${leadId} AND deleted_at IS NULL
        FOR UPDATE
      `)) as unknown as [
        Array<{ id: number; source: string; status: string }>,
      ]
      if (!rows[0]) throw new HttpError(404, 'not_found')
      const row = rows[0]

      await tx.execute(sql`
        UPDATE leads SET deleted_at = NOW(3) WHERE id = ${leadId}
      `)

      // Audit `diff` stores source + last-known status (no PII).
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'delete',
        resourceType: 'lead',
        resourceId: String(leadId),
        diff: { source: row.source, status: row.status } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      return new Response(null, { status: 204 })
    })
  },
)
