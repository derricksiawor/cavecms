import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { isMissingTable } from '@/lib/db/errors'

// GET /api/cms/posts/search?q=<term>&ids=1,2,3
//
// Lightweight, role-gated post lookup for the Posts-widget MANUAL source
// picker (#0.59 visual multi-select). Returns identity-only rows
// (id/title/slug/published_at) — NOT the body — for two modes:
//   • `q`   — a title substring search (the picker's live filter), newest
//             first, hard-capped at SEARCH_CAP so a huge blog can't blow up
//             the picker DOM (#0.251).
//   • `ids` — resolve a specific set of already-picked ids (so the picker can
//             render the operator's saved selection with titles, in order).
//
// Both are bounded + parameterised. Admin/editor only + read-rate-limited so a
// forged session can't enumerate posts at full bandwidth. Missing-table-safe
// (returns []), so a fresh install without the blog schema doesn't 500 the
// drawer.

const SEARCH_CAP = 30
const IDS_CAP = 50

interface PostSearchRow {
  id: number
  title: string
  slug: string
  published_at: Date | string | null
}

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor'])
  checkReadRate(ctx.userId)

  const url = new URL(req.url)
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 120)
  const idsRaw = url.searchParams.get('ids')

  try {
    // ── ids mode — resolve a specific selection (preserve operator order) ──
    if (idsRaw) {
      const ids = idsRaw
        .split(',')
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, IDS_CAP)
      if (ids.length === 0) return Response.json({ items: [] })
      const [rows] = (await db.execute(sql`
        SELECT id, title, slug, published_at
        FROM posts
        WHERE id IN (${sql.join(ids, sql.raw(','))})
          AND deleted_at IS NULL
        LIMIT ${ids.length}
      `)) as unknown as [PostSearchRow[]]
      const byId = new Map(rows.map((r) => [r.id, r]))
      const ordered = ids.map((id) => byId.get(id)).filter((r): r is PostSearchRow => !!r)
      return Response.json({ items: ordered })
    }

    // ── search mode — title substring (LIKE), newest first, capped ──
    // The LIKE pattern is a BOUND parameter (mysql2 escapes it); we wrap the
    // operator term in %…% server-side. An empty term lists the most recent.
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`
    const [rows] = (await db.execute(sql`
      SELECT id, title, slug, published_at
      FROM posts
      WHERE deleted_at IS NULL
        ${q ? sql`AND title LIKE ${like}` : sql``}
      ORDER BY COALESCE(published_at, updated_at) DESC, id DESC
      LIMIT ${SEARCH_CAP}
    `)) as unknown as [PostSearchRow[]]
    return Response.json({ items: rows })
  } catch (err) {
    if (isMissingTable(err)) return Response.json({ items: [] })
    throw err
  }
})
