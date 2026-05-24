import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { PageEditor } from './PageEditor'
import type { PageRawRow } from '@/lib/cms/types'

export const dynamic = 'force-dynamic'

// /admin/pages/[id] — canonical editor for a single page. Per spec
// §3.5 + §7: this is a FALLBACK surface; the primary editing flow is
// the public-side inline drawer (Wix-style). Operators reach this
// view from the list page when they need bulk block reorder, audit
// inspection, or the explicit "Move to Trash" action.
//
// Role gating mirrors adminPolicy('editPage') — admin + editor + viewer
// all reach the surface; viewer is read-only (every input disabled).

interface AuditRow {
  id: number
  user_id: number | null
  action: string
  created_at: Date | string
  user_email: string | null
}

interface BlockRow {
  id: number
  block_key: string | null
  block_type: string
  position: number
  data: string
  version: number
}

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

type Params = Promise<{ id: string }>

export default async function PageEditorRoute({ params }: { params: Params }) {
  const { id: rawId } = await params
  if (!ID_PATTERN.test(rawId)) notFound()
  const id = Number(rawId)

  const ctx = await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const allowed = adminPolicy('editPage')
  if (!allowed.includes(ctx.role)) notFound()

  const [pageRows] = (await db.execute(sql`
    SELECT * FROM pages WHERE id = ${id}
  `)) as unknown as [PageRawRow[]]
  const page = pageRows[0]
  if (!page) notFound()
  // Viewer cannot reach a trashed page even by direct URL — same
  // hidden-surface treatment as /admin/pages (spec §3.2). Admin
  // and editor see the editor; viewer 404s.
  if (page.deleted_at !== null && ctx.role === 'viewer') notFound()

  const [blockRows] = (await db.execute(sql`
    SELECT id, block_key, block_type, position, data, version
    FROM content_blocks
    WHERE page_id = ${id} AND deleted_at IS NULL
    ORDER BY position, id
  `)) as unknown as [BlockRow[]]

  // mysql2 returns JSON columns as strings via raw execute. Parse on
  // the server so the client receives runtime trees and a downstream
  // typo (`JSON.parse(b.data)`) doesn't bubble into the editor as a
  // hydration-mismatch surprise.
  const blocksWithData = blockRows.map((b) => {
    let parsedData: unknown = {}
    try {
      parsedData = JSON.parse(b.data)
    } catch {
      // Corrupted cell — surface as empty so the editor can still
      // render the row (operator deletes + re-creates if needed).
    }
    return {
      id: b.id,
      blockKey: b.block_key,
      blockType: b.block_type,
      position: b.position,
      version: b.version,
      data: parsedData,
    }
  })

  // Recent audit entries surfaced in the right-side metadata strip.
  // LEFT JOIN users so a row created by a since-deleted operator
  // still renders (with email NULL → "—" in the UI).
  const [auditRows] = (await db.execute(sql`
    SELECT a.id, a.user_id, a.action, a.created_at, u.email AS user_email
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.resource_type = 'page' AND a.resource_id = ${String(id)}
    ORDER BY a.id DESC
    LIMIT 5
  `)) as unknown as [AuditRow[]]

  return (
    <PageEditor
      role={ctx.role}
      page={page}
      blocks={blocksWithData}
      audit={auditRows.map((a) => ({
        id: a.id,
        action: a.action,
        createdAt: a.created_at,
        email: a.user_email,
      }))}
    />
  )
}
