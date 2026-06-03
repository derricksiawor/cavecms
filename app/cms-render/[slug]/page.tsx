// Dynamic render route for the pages CMS (spec §2.5). Reachable
// ONLY via the middleware Block 2 rewrite — direct hits on
// `/_page/{anything}` are 404'd by middleware Block 1. The visitor's
// URL bar shows `/{slug}`; this file resolves it.
//
// Cache discipline (load-bearing): `force-dynamic` means every
// request re-queries the DB. Cache invalidation via tags (PR-3 wires
// `tag.page(slug)`) is therefore not yet wired here; published pages
// re-fetch on every render. This is the spec's explicit fallback
// path for post-build pages — a page created on a deployed build
// renders 200 via the rewrite + per-request fetch without any
// `generateStaticParams` regeneration.
//
// Wix-style edit-mode wiring mirrors `app/page.tsx`: when the visitor
// has an admin/editor session AND the edit-mode cookie is set,
// blocks are wrapped in `<EditableBlock>` and clicking opens
// `<EditDrawer>` IN PLACE on the public layout. No navigation to
// `/admin/pages/[id]` required — the spec's headline operator UX.

import { notFound, permanentRedirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { hydratePage } from '@/lib/cms/hydrate'
import { getSession, resolveEditableMode } from '@/lib/auth/getSession'
import { EditableMain } from '@/components/inline-edit/EditableMain'
import {
  mintPublicPreCsrfForBlocks,
  pageHasVisibleH1,
  parseLoopPage,
} from '@/app/_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { safeJsonForScript } from '@/lib/seo/escape'
import { jsonLdForPage } from '@/lib/seo/page-jsonld'
import { verifyPreviewToken } from '@/lib/cms/verifyPreviewToken'
import { SLUG_MAX, SLUG_MIN, SLUG_RE } from '@/lib/cms/slug'
import type { PageRawRow } from '@/lib/cms/types'

export const dynamic = 'force-dynamic'

// Pinned per spec §2.5. With `dynamic = 'force-dynamic'` the runtime
// is already fully dynamic; `dynamicParams = true` is the Next 15
// default but pinned explicitly so a future "for safety" PR doesn't
// flip it off and break post-build pages that need to render via the
// rewrite without re-build.
export const dynamicParams = true

type Params = Promise<{ slug: string }>
type SearchParams = Promise<Record<string, string | string[] | undefined>>

// Defence in depth — middleware Block 2 has already validated the
// captured segment against SLUG_RE + RESERVED + LOGIN_PATH. A direct
// invocation of this route via some bypass path (e.g. a future
// internal rewrite that lands here) MUST not crash; we revalidate
// the slug shape and bail with 404 on any mismatch.
function validSlug(input: string): string | null {
  if (input.length < SLUG_MIN || input.length > SLUG_MAX) return null
  return SLUG_RE.test(input) ? input : null
}

export async function generateMetadata({ params }: { params: Params }) {
  const { slug: raw } = await params
  const slug = validSlug(raw)
  if (!slug) {
    return resolveMetadata({
      title: null,
      description: null,
      fallbackTitle: 'CaveCMS',
      canonicalPath: '/',
    })
  }
  // Filter by `published = 1` to avoid leaking draft SEO metadata
  // when a probe hits an unpublished slug. The render path 404s on
  // unpublished; metadata likewise falls through to the site default.
  const [rows] = (await db.execute(sql`
    SELECT title, seo_title, seo_description, url_path
    FROM pages
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND is_home = 0
      AND published = 1
      -- A bare-slug hit on a hidden post-body page must NOT leak its
      -- metadata (spec §4.4); kind='page' excludes them.
      AND kind = 'page'
    LIMIT 1
  `)) as unknown as [
    Array<{
      title: string | null
      seo_title: string | null
      seo_description: string | null
      url_path: string | null
    }>,
  ]
  const r = rows[0]
  // Fallback chain (audit V10 fix): seo_title → "{title} — Best World
  // Properties" → "CaveCMS". The audit found every CMS
  // page sharing the same <title>CaveCMS</title> when
  // seo_title wasn't set; pulling page.title into the fallback string
  // gives every page a distinct tab/SERP label without forcing
  // operators to also fill in seo_title every time they create a page.
  const titleFallback =
    r?.title && r.title.trim().length > 0
      ? `${r.title} — CaveCMS`
      : 'CaveCMS'
  return resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? null,
    fallbackTitle: titleFallback,
    // Canonical reads url_path (the STORED generated column) — never
    // hand-built `/' + slug` per the spec §2.8 url discipline.
    canonicalPath: r?.url_path ?? `/${slug}`,
  })
}

// NOTE: do NOT wrap the body of this function in try/catch. Next.js
// signals redirects/notFounds via thrown errors (NEXT_REDIRECT,
// NEXT_NOT_FOUND). A naive try/catch would swallow these and produce
// a 200 with broken markup. Mirrors the pattern in
// app/blog/[slug]/page.tsx and app/projects/[slug]/page.tsx.
export default async function PageRoute({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { slug: raw } = await params
  const slug = validSlug(raw)
  if (!slug) notFound()

  const search = await searchParams
  const previewRaw = search['preview']
  const previewToken =
    typeof previewRaw === 'string' && previewRaw.length > 0 ? previewRaw : null

  // Preview-token branch. Strict-slug match — never follow
  // slug_redirects in preview mode. On any failure the route 404s
  // and emits a structured log with the requestSlug (NEVER the
  // reason — that's spec §4.7 step 5 LOCKED logging discipline).
  if (previewToken) {
    const verified = await verifyPreviewToken({
      token: previewToken,
      requestSlug: slug,
    })
    if (!verified.ok) {
      console.info(
        JSON.stringify({
          level: 'info',
          msg: 'preview_token_rejected',
          requestSlug: slug,
        }),
      )
      notFound()
    }
    // Preview-mode rendering — preview is valid regardless of the
    // page's published state (per §4.7: "?preview= forces preview
    // mode regardless of publish state").
    return renderResolvedPage(verified.page, { preview: true, search })
  }

  // Project-scoped slug fallthrough. When a project exists at this
  // slug, the canonical URL is `/projects/<slug>` — the project
  // detail route now prefers the matching `pages` CMS tree where one
  // exists, so the same block content serves at /projects/<slug>.
  // Serving the same page at TWO URLs would split SEO signals and
  // confuse the operator; 308-redirect the bare slug to the
  // project-scoped URL so /projects/<slug> is the single source.
  const [projectRows] = (await db.execute(sql`
    SELECT id FROM projects
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND published = 1
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  if (projectRows[0]) permanentRedirect(`/projects/${slug}`)

  // Public branch. Single row by slug, soft-delete filter, AND
  // is_home = 0 so a renamed home row does NOT double-serve at its
  // slug URL (it 308s to `/` via the fall-through below).
  const [rows] = (await db.execute(sql`
    SELECT * FROM pages
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND is_home = 0
      -- A bare-slug hit on a hidden post-body page (its internal
      -- __post-body-<id> slug, or a forged guess) must 404, never render
      -- the body tree at a public URL (spec §4.4).
      AND kind = 'page'
    LIMIT 1
  `)) as unknown as [PageRawRow[]]
  const page = rows[0]

  if (page) {
    // Snake_case + numeric comparison — raw mysql2 returns TINYINT(1)
    // as `0|1`, NOT `true|false`. Matches lib/cms/hydrate.ts:327
    // codebase convention.
    if (page.published !== 1) notFound()
    return renderResolvedPage(page, { preview: false, search })
  }

  // Home-rename fall-through (spec §2.5 step 4):
  //   1. The home row owns this slug → 308 to `/`.
  //   2. slug_redirects has a row → 308 to target page's url_path.
  //   3. Otherwise 404.
  //
  // The home-row check and the slug_redirects lookup are independent
  // — fire them in parallel. The 308-to-home branch (homeRows[0]
  // present) wins regardless of any redirect row because a renamed
  // home owns its slug AND its canonical url_path stays `/`.
  const [homeRowsResult, redirRowsResult] = await Promise.all([
    db.execute(sql`
      SELECT id FROM pages
      WHERE slug = ${slug}
        AND is_home = 1
        AND deleted_at IS NULL
      LIMIT 1
    `),
    db.execute(sql`
      SELECT new_slug FROM slug_redirects
      WHERE resource_type = 'page' AND old_slug = ${slug}
      LIMIT 1
    `),
  ])
  const [homeRows] = homeRowsResult as unknown as [Array<{ id: number }>]
  const [redirRows] = redirRowsResult as unknown as [
    Array<{ new_slug: string }>,
  ]
  if (homeRows[0]) permanentRedirect('/')

  const redirect = redirRows[0]
  if (redirect) {
    // Resolve target's url_path (the canonical column). Target may
    // itself be soft-deleted, unpublished, or missing — broken chain
    // → 404. Filtering `published = 1` on the target prevents a 308
    // → 404 loop where the operator unpublished the renamed target
    // to redraft it (the inbound link gets a 404 directly rather
    // than caching a stale 308 to a 404).
    const [targetRows] = (await db.execute(sql`
      SELECT url_path FROM pages
      WHERE slug = ${redirect.new_slug}
        AND deleted_at IS NULL
        AND published = 1
        -- A redirect can never legitimately target a hidden body page
        -- (its slug is the internal sentinel); exclude defensively.
        AND kind = 'page'
      LIMIT 1
    `)) as unknown as [Array<{ url_path: string | null }>]
    const target = targetRows[0]
    if (target?.url_path) permanentRedirect(target.url_path)
    notFound()
  }

  notFound()
}

async function renderResolvedPage(
  page: PageRawRow,
  opts: {
    preview: boolean
    search: Record<string, string | string[] | undefined>
  },
): Promise<React.ReactElement> {
  // Session resolution wrapped — a bad cookie should never block
  // public render. Same defensive pattern as app/page.tsx.
  let session: Awaited<ReturnType<typeof getSession>> = null
  try {
    session = await getSession()
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'page_session_resolve_failed',
        slug: page.slug,
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }
  const c = await cookies()
  const editable = resolveEditableMode(session, c, opts.search)

  // hydratePage is wrapped defensively — a single corrupt media row or
  // block-parse failure (e.g. tampered DB cell, post-write schema bump)
  // returns null + logs a structured signal rather than 500-ing the
  // whole route. Mirrors the home page's pattern at app/page.tsx.
  let hydrated: Awaited<ReturnType<typeof hydratePage>> | null = null
  try {
    // Thread the loop cursor so a loop-mode lx_posts block on this page (an
    // editor-preview/preview-token render of the /blog page) gets the slice
    // for the visitor's ?page=. Cheap elsewhere — hydrate only runs the loop
    // query when a loop block exists.
    hydrated = await hydratePage(page.id, { loopPage: parseLoopPage(opts.search) })
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'page_hydrate_failed',
        page_id: page.id,
        slug: page.slug,
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }
  if (!hydrated) notFound()
  const { blocks, media, projects, posts, postsLoop, postCardsByBlock, themeMode } = hydrated
  const csrf = await mintPublicPreCsrfForBlocks(blocks, page.slug)

  const { getSiteOrigin } = await import('@/lib/cms/getSiteOrigin')
  const ld = jsonLdForPage({ page, baseUrl: (await getSiteOrigin()) ?? '' })

  return (
    <EditableMain
      pageId={page.id}
      pageVersion={page.version}
      blocks={blocks}
      media={media}
      projects={projects}
      posts={posts}
      postsLoop={postsLoop}
      postCardsByBlock={postCardsByBlock}
      themeMode={themeMode}
      session={session}
      editable={editable}
      preview={opts.preview}
      csrf={csrf}
    >
      {/* sr-only page H1 — only when the tree has no visible <h1>
          (lx_heading at level h1, or lx_cover_image with a title). A
          duplicate sr-only h1 above an existing visible one would
          create the SEO duplicate-heading penalty. When the page is
          built from lx_text / lx_figure widgets only, this sr-only H1
          is the page's semantic top-level heading. */}
      {!pageHasVisibleH1(blocks) && (
        <h1 className="sr-only">{page.title}</h1>
      )}
      {/* Per-page JSON-LD. safeJsonForScript escapes </script>, --> and
          U+2028/U+2029 so admin-controlled fields (title, seoDescription)
          can never break out of the script tag. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
      />
    </EditableMain>
  )
}
