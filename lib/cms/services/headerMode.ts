import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { isSectionSurfaceDark } from '@/lib/cms/blockMeta'

// Per-page header-mode resolution for the overlay header (0.3.9 follow-up).
//
// The overlay treatment (transparent bar + white logo over the hero) only
// reads on a DARK first section. Real sites mix dark-hero pages with
// light-top pages (forms, legal, maps) — on those, a transparent header
// with white text over a white background is an invisible header. So the
// rendered mode is resolved PER PAGE:
//
//   1. pages.header_mode override ('solid' | 'overlay') — the operator's
//      explicit per-page choice, wins both ways (can force overlay on a
//      page even when the site default is solid, and vice versa).
//   2. Inherit + site default 'solid' → solid. (No probe cost on
//      solid-default sites beyond the single page lookup.)
//   3. Inherit + site default 'overlay' → probe the page's FIRST section
//      surface with isSectionSurfaceDark (same classifier the adaptive
//      widgets use): dark first section → overlay; light → render the
//      solid themed bar from scroll 0 (skip the transparent phase).
//   4. Routes with no probeable page row (project details, archives,
//      search) → solid. A correct-but-conservative bar always beats an
//      invisible one.
//
// Blog posts probe through posts.body_page_id — the post body IS a pages
// row (kind='post_body') carrying the same section tree.

export type HeaderRenderMode = 'solid' | 'overlay'

type ProbeMeta = Parameters<typeof isSectionSurfaceDark>[0]

interface PageProbeRow {
  id: number
  header_mode: string | null
}

// SiteHeader resolves x-pathname AFTER middleware's internal rewrite, so a
// dynamic page arrives here as '/cms-render/<slug>', not '/<slug>'. Map it
// back to the public url_path the `pages` table stores. Real routes (home,
// /contact, /blog/*, /projects/*) are untouched.
const CMS_RENDER_PREFIX = '/cms-render'
function canonicalPath(pathname: string): string {
  if (pathname === CMS_RENDER_PREFIX) return '/'
  if (pathname.startsWith(`${CMS_RENDER_PREFIX}/`)) {
    return pathname.slice(CMS_RENDER_PREFIX.length)
  }
  return pathname
}

async function findPageForPath(pathname: string): Promise<PageProbeRow | null> {
  // Blog post: /blog/<slug> (one extra segment only — /blog itself and
  // /blog/category|tag/* are pages/archives, not posts).
  const postSlug = pathname.match(/^\/blog\/([^/]+)$/)?.[1]
  if (postSlug && postSlug !== 'category' && postSlug !== 'tag') {
    const [rows] = (await db.execute(sql`
      SELECT pg.id, pg.header_mode
      FROM posts po
      JOIN pages pg ON pg.id = po.body_page_id
      WHERE po.slug = ${decodeURIComponent(postSlug)}
        AND po.deleted_at IS NULL AND pg.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as [PageProbeRow[]]
    return rows[0] ?? null
  }
  // Everything else: the STORED-generated canonical url_path ('/' for the
  // home row, '/<slug>' otherwise) — one indexed lookup covers home,
  // system pages, and dynamic pages alike.
  const [rows] = (await db.execute(sql`
    SELECT id, header_mode FROM pages
    WHERE url_path = ${pathname} AND kind = 'page' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [PageProbeRow[]]
  return rows[0] ?? null
}

async function firstSectionIsDark(pageId: number): Promise<boolean> {
  const [rows] = (await db.execute(sql`
    SELECT meta FROM content_blocks
    WHERE page_id = ${pageId} AND kind = 'section'
      AND parent_id IS NULL AND deleted_at IS NULL
    ORDER BY position ASC
    LIMIT 1
  `)) as unknown as [Array<{ meta: unknown }>]
  if (!rows[0]) return false
  let meta: ProbeMeta = null
  const raw = rows[0].meta
  try {
    meta = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ProbeMeta
  } catch {
    meta = null
  }
  let themeMode: 'light' | 'dark' | undefined
  try {
    themeMode = (await getSetting('theme_palette')).mode
  } catch {
    themeMode = undefined
  }
  return isSectionSurfaceDark(meta, themeMode)
}

/**
 * The header mode this REQUEST should render with. Never throws — any
 * lookup failure degrades to 'solid' (the safe, always-readable bar).
 */
export async function resolveHeaderRenderMode(
  pathname: string,
  siteMode: HeaderRenderMode,
): Promise<HeaderRenderMode> {
  try {
    const page = await findPageForPath(canonicalPath(pathname))
    if (page?.header_mode === 'solid' || page?.header_mode === 'overlay') {
      return page.header_mode
    }
    if (siteMode !== 'overlay') return 'solid'
    if (!page) return 'solid'
    return (await firstSectionIsDark(page.id)) ? 'overlay' : 'solid'
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'header_mode_resolve_degraded',
        err_name: err instanceof Error ? err.name : 'unknown',
      }),
    )
    return siteMode === 'overlay' ? 'overlay' : 'solid'
  }
}
