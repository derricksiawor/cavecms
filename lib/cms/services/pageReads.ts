import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

// Read-side page services, extracted from app/api/cms/pages/route.ts (GET) and
// app/api/cms/pages/[id]/route.ts (GET) verbatim so the MCP tools and the HTTP
// routes return identical shapes. Mirrors the saveBlock → thin-route precedent.

export interface PageListItem {
  id: number
  slug: string
  title: string
  is_home: number
  system: number
  published: number
  published_at: Date | string | null
  deleted_at: Date | string | null
  updated_at: Date | string | null
  url_path: string | null
  updated_by_email: string | null
}

export async function listPages(opts: {
  trashed?: boolean
}): Promise<PageListItem[]> {
  const trashed = opts.trashed === true
  const [rows] = (await db.execute(
    trashed
      ? sql`
          SELECT p.id, p.slug, p.title, p.is_home, p.system, p.published,
                 p.published_at, p.deleted_at, p.updated_at, p.url_path,
                 u.email AS updated_by_email
          FROM pages p
          LEFT JOIN users u ON u.id = p.updated_by
          WHERE p.deleted_at IS NOT NULL
            AND p.deleted_at > NOW(3) - INTERVAL 30 DAY
          ORDER BY p.deleted_at DESC, p.id DESC
          LIMIT 50
        `
      : sql`
          SELECT p.id, p.slug, p.title, p.is_home, p.system, p.published,
                 p.published_at, p.deleted_at, p.updated_at, p.url_path,
                 u.email AS updated_by_email
          FROM pages p
          LEFT JOIN users u ON u.id = p.updated_by
          WHERE p.deleted_at IS NULL
          ORDER BY p.is_home DESC, p.updated_at DESC, p.id DESC
          LIMIT 50
        `,
  )) as unknown as [PageListItem[]]
  return rows
}

export interface PageEditBlock {
  id: number
  parent_id: number | null
  kind: 'section' | 'column' | 'widget'
  block_key: string | null
  block_type: string
  position: number
  data: unknown
  meta: unknown
  version: number
}

export interface PageForEdit {
  page: Record<string, unknown>
  blocks: PageEditBlock[]
}

// The flat page row + non-deleted blocks (ids + versions + data) an agent needs
// to do read-before-edit. Returns null when the page row is absent. Trashed-row
// visibility is the caller's policy (the MCP tool applies the same viewer cap).
export async function getPageForEdit(
  pageId: number,
): Promise<PageForEdit | null> {
  const [pageRows] = (await db.execute(sql`
    SELECT * FROM pages WHERE id = ${pageId}
  `)) as unknown as [Array<Record<string, unknown>>]
  const page = pageRows[0]
  if (!page) return null
  const [blockRows] = (await db.execute(sql`
    SELECT id, parent_id, kind, block_key, block_type, position, data, meta, version
    FROM content_blocks
    WHERE page_id = ${pageId} AND deleted_at IS NULL
    ORDER BY position
  `)) as unknown as [PageEditBlock[]]
  return { page, blocks: blockRows }
}

// The PUBLIC site theme (palette + header/footer branding) — what every page
// renders with. Read-only, non-secret (it's visible on the live site), so the
// MCP `get_theme` tool exposes it with no scope so an agent can MATCH the brand
// before composing. Returns parsed JSON per key (raw db.execute → strings).
export async function readSiteTheme(): Promise<Record<string, unknown>> {
  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value FROM settings
    WHERE \`key\` IN ('theme_palette', 'site_header', 'footer', 'typography')
  `)) as unknown as [Array<{ key: string; value: unknown }>]
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      out[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value
    } catch {
      out[r.key] = r.value
    }
  }
  return out
}
