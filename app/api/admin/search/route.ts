import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'

// Search feed for the Cmd+K command palette. Returns up to 50
// recently-updated entries per kind by default, OR — when the client
// passes `?q=…` — does a server-side LIKE filter and returns the top
// matches. Caps the wire payload + the cmdk client-filter cost so the
// palette stays responsive on a site with thousands of projects/posts.
//
// Auth: admin/editor/viewer (everyone with admin access).
// Rate-limit: existing CMS read limiter — cheap-enough to call on
// every palette open + every typed query.

const DEFAULT_LIMIT = 50
const SEARCH_LIMIT = 30
const MAX_Q_LENGTH = 80

interface Row {
  type: 'project' | 'page' | 'post'
  id: number
  title: string
  slug: string
  published: number
}

// Escape LIKE special characters before interpolating operator-supplied
// text. Drizzle parameterises the value safely, but unescaped `%` would
// make every search match everything.
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  checkReadRate(ctx.userId)

  const url = new URL(req.url)
  const qRaw = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_Q_LENGTH)

  // Two branches: no-query (recent items, alpha sort) vs search
  // (LIKE filter, updated_at sort). Inlined rather than composed via
  // nested sql`` fragments because drizzle's nested-template handling
  // has been unreliable for conditional ORDER BY in this codebase.
  const [[projects], [pages], [posts]] = (qRaw
    ? await (async () => {
        const needle = `%${escapeLike(qRaw)}%`
        return Promise.all([
          db.execute(sql`
            SELECT 'project' AS type, id, name AS title, slug, published
            FROM projects
            WHERE deleted_at IS NULL
              AND (name LIKE ${needle} OR slug LIKE ${needle})
            ORDER BY updated_at DESC
            LIMIT ${SEARCH_LIMIT}
          `),
          db.execute(sql`
            SELECT 'page' AS type, id, seo_title AS title, slug, 1 AS published
            FROM pages
            WHERE deleted_at IS NULL
              -- Hidden post-body pages must never surface in the Cmd+K
              -- palette (spec §4.4).
              AND kind = 'page'
              AND (seo_title LIKE ${needle} OR slug LIKE ${needle})
            ORDER BY updated_at DESC
            LIMIT ${SEARCH_LIMIT}
          `),
          db.execute(sql`
            SELECT 'post' AS type, id, title, slug, published
            FROM posts
            WHERE deleted_at IS NULL
              AND (title LIKE ${needle} OR slug LIKE ${needle})
            ORDER BY updated_at DESC
            LIMIT ${SEARCH_LIMIT}
          `),
        ])
      })()
    : await Promise.all([
        db.execute(sql`
          SELECT 'project' AS type, id, name AS title, slug, published
          FROM projects
          WHERE deleted_at IS NULL
          ORDER BY name
          LIMIT ${DEFAULT_LIMIT}
        `),
        db.execute(sql`
          SELECT 'page' AS type, id, seo_title AS title, slug, 1 AS published
          FROM pages
          WHERE deleted_at IS NULL
            -- Hidden post-body pages must never surface in the Cmd+K
            -- palette (spec §4.4).
            AND kind = 'page'
          ORDER BY slug
          LIMIT ${DEFAULT_LIMIT}
        `),
        db.execute(sql`
          SELECT 'post' AS type, id, title, slug, published
          FROM posts
          WHERE deleted_at IS NULL
          ORDER BY title
          LIMIT ${DEFAULT_LIMIT}
        `),
      ])) as unknown as [[Row[]], [Row[]], [Row[]]]

  return new Response(
    JSON.stringify({
      role: ctx.role,
      query: qRaw,
      projects,
      pages,
      posts,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})
