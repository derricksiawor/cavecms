import 'server-only'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { hydratePage, MAX_LOOP_PAGE } from '@/lib/cms/hydrate'
import { getSession, resolveEditableMode } from '@/lib/auth/getSession'
import { ensurePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { EditableMain } from '@/components/inline-edit/EditableMain'
import { BlockTreeRenderer } from '@/components/inline-edit/BlockTreeRenderer'
import { blogIndexUrl } from '@/lib/blog/urls'
// blog-system worktree (Phase 5): segment-aware breadcrumb "Blog" link.
import { resolveSegments } from '@/lib/blog/resolveSegments'

// Block types that submit to a public lead endpoint. When any one of
// these appears in a page's hydrated tree, the page-level renderer
// mints a preCsrf nonce and threads it through RenderContext so the
// form submits cleanly on the first interaction. Listed centrally here
// so adding a new form block (newsletter, brochure, inquiry, etc) is
// one line — not a tree-scanning expression in three places.
const FORM_BLOCK_TYPES = new Set<string>([
  'contact_form',
  // Project lead forms — both submit to /api/leads/* and need the
  // public preCsrf nonce minted page-level. Present on migrated
  // project pages (app/projects/[slug]); harmless on any other page.
  'lx_inquiry_form',
  'lx_brochure_form',
])

/**
 * Walk a hydrated block list looking for any form-bearing block; if
 * one exists, mint a public preCsrf nonce and return it. Returns
 * `undefined` when the page has no public form (most pages). The
 * mint is wrapped in try/catch so a transient failure degrades the
 * form (block renders a "use email / phone" hint) rather than
 * 500-ing the whole page — mirrors the resilience pattern the
 * legacy /contact route used before this surface was unified.
 *
 * Exported so the dynamic /_page/[slug] route and the home route can
 * call the same helper. The cmsPage.tsx renderer for the four named
 * system pages (home/about/services/contact) uses it inline.
 */
export async function mintPublicPreCsrfForBlocks(
  blocks: Array<{ blockType: string }>,
  contextSlug: string,
): Promise<string | undefined> {
  const hasForm = blocks.some((b) => FORM_BLOCK_TYPES.has(b.blockType))
  if (!hasForm) return undefined
  try {
    return await ensurePublicPreCsrf()
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'cms_page_precsrf_mint_failed',
        slug: contextSlug,
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
    return undefined
  }
}

/**
 * True when the hydrated block tree already emits a visible top-level
 * <h1> — either an `lx_heading` whose level is 'h1', or an
 * `lx_cover_image` carrying a title (its renderer wraps the title in
 * <h1>). The public page shims call this to decide whether to add a
 * fallback sr-only <h1>: when a visible h1 already exists, a second
 * sr-only one would trip the SEO duplicate-heading penalty; when none
 * exists (page built from body text / figures only), the sr-only h1 is
 * the page's semantic top-level heading. Shared by app/page.tsx,
 * app/cms-render/[slug]/page.tsx and renderCmsPage below so the rule
 * stays identical across every public render path.
 */
export function pageHasVisibleH1(
  blocks: Array<{ blockType: string; data: unknown }>,
): boolean {
  return blocks.some((b) => {
    if (b.blockType === 'lx_heading') {
      return (b.data as { level?: string }).level === 'h1'
    }
    if (b.blockType === 'lx_cover_image') {
      const title = (b.data as { title?: string }).title
      return typeof title === 'string' && title.trim().length > 0
    }
    return false
  })
}

export type CmsPageSlug =
  | 'home'
  | 'about'
  | 'services'
  | 'contact'
  | 'projects'
  | 'blog'
  | 'privacy'
  | 'terms'

/** Parse the 1-based `?page=` loop cursor from a route's searchParams.
 *  Tolerant: a missing / non-numeric / <1 value resolves to page 1.
 *  Clamped to [1, MAX_LOOP_PAGE] — the SAME upper bound the loop renderer
 *  applies inside the keyset fetch — so generateMetadata's canonical/pager
 *  never points past the rendered clamp. Arrays (?page=1&page=2) take the
 *  first entry. */
export function parseLoopPage(
  search: Record<string, string | string[] | undefined> | undefined,
): number {
  const raw = search?.['page']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string') return 1
  const n = Number.parseInt(v, 10)
  const page = Number.isFinite(n) ? n : 1
  return Math.min(MAX_LOOP_PAGE, Math.max(1, page))
}

// Shared server-component renderer for the six CMS-edited public
// pages. Adds the global Organization JSON-LD, wires up edit-mode
// affordances for admins/editors, and reuses the same renderBlock
// dispatcher as the home page.
//
// Caller is responsible for `generateMetadata` (per route, with its
// own seo_title / fallback). This helper handles RENDER only.
//
// Returns null when the page row is missing — callers should
// notFound() in that case (a missing page is a seed/deploy bug, not a
// user-facing 404).
export async function renderCmsPage(
  slug: CmsPageSlug,
  opts?: {
    /** URL searchParams from the calling route. Surfaces the `?edit=1`
     *  override for admins who follow a shared edit-link without first
     *  toggling the edit-mode cookie. canEdit() still gates the override
     *  inside resolveEditableMode — non-admins see anonymous render. */
    search?: Record<string, string | string[] | undefined>
  },
): Promise<React.ReactElement | null> {
  // Session resolution is wrapped — a bad cookie should never block
  // public render. The home page applies the same defensive pattern.
  let session: Awaited<ReturnType<typeof getSession>> = null
  try {
    session = await getSession()
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'cms_page_session_resolve_failed',
        slug,
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }
  const c = await cookies()
  const editable = resolveEditableMode(session, c, opts?.search)

  // Also pull `version` so EditableBlock can supply the page-side
  // optimistic-lock token to the dual-axis saveBlock TX (spec §3.5).
  // Filter on deleted_at IS NULL AND published = 1 so a soft-deleted
  // or unpublished system row stops rendering publicly — closes the
  // PR-2 cmsPage.tsx published-filter gap the rev-7 notes called out.
  const [pageRows] = (await db.execute(sql`
    SELECT id, title, version FROM pages
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND published = 1
  `)) as unknown as [Array<{ id: number; title: string; version: number }>]
  const row = pageRows[0]
  if (!row) return null
  const pageId = row.id
  const pageVersion = row.version
  const pageTitle = row.title

  // Thread the loop cursor so a loop-mode lx_posts block on this page (the
  // /blog index) gets the slice for the visitor's ?page=. Cheap for every
  // other page — hydrate only runs the loop query when a loop block exists.
  const hydrated = await hydratePage(pageId, { loopPage: parseLoopPage(opts?.search) })
  if (!hydrated) return null

  // Organization JSON-LD is emitted by app/layout.tsx for every
  // public route, so we don't duplicate it here. Per-entity LD
  // (Residence, BlogPosting) lives on the route that knows about
  // the entity.
  const { blocks, media, projects, posts, postsLoop, postCardsByBlock, themeMode } = hydrated

  const csrf = await mintPublicPreCsrfForBlocks(blocks, slug)

  // Same sr-only <h1> pattern as app/page.tsx + app/cms-render/[slug]/
  // page.tsx — guarantees every CMS-driven page has a semantic
  // top-level heading for SEO + screen readers even when operators
  // built the page from lx_text / lx_figure widgets only. Skipped when
  // the tree already emits a visible <h1> (lx_heading at level h1, or
  // lx_cover_image with a title); a duplicate sr-only would trip the
  // SEO duplicate-heading penalty.
  const hasVisibleH1 = pageHasVisibleH1(blocks)

  // EditableMain centralises the BlockTreeRenderer + EditModePill +
  // OutlinePanel + ToastProvider/MediaPickerProvider chain that
  // previously lived in this file (and divergently in app/page.tsx
  // + app/%5Fpage/[slug]/page.tsx). showEmptyState=false preserves
  // this surface's legacy behaviour of rendering nothing on an empty
  // template page (the seeded system rows always have blocks; an
  // empty `/contact` is a deploy-time bug surfaced via the seed
  // assertion, not via UI).
  return (
    <EditableMain
      pageId={pageId}
      pageVersion={pageVersion}
      blocks={blocks}
      media={media}
      projects={projects}
      posts={posts}
      postsLoop={postsLoop}
      postCardsByBlock={postCardsByBlock}
      themeMode={themeMode}
      session={session}
      editable={editable}
      showEmptyState={false}
      csrf={csrf}
    >
      {!hasVisibleH1 && <h1 className="sr-only">{pageTitle}</h1>}
    </EditableMain>
  )
}

// ── blog-system worktree: taxonomy archive render (do not interleave) ────────
export interface BlogArchiveTerm {
  kind: 'category' | 'tag'
  slug: string
  name: string
  description?: string | null
}

/**
 * Renders a category/tag ARCHIVE page. Reuses the operator-styled `/blog`
 * system page shell verbatim — same hero/intro/CTA blocks the operator edits
 * under /admin/pages — but (a) pins the page's loop-mode `lx_posts` block to
 * the archive's term via hydratePage's `loopFilter` override, and (b) prepends
 * an archive header (breadcrumb + term name + description). This is the
 * "renderCmsPage('blog') with a loop-filter override" path the spec offers;
 * chosen over duplicating the loop markup so the archive inherits the
 * operator's styling for free and a /blog redesign carries to archives with
 * zero extra work.
 *
 * The archive is READ-ONLY (rendered via BlockTreeRenderer, not EditableMain):
 * it's a virtual view of the /blog page filtered to a term — there is nothing
 * to inline-edit here (the operator edits the underlying /blog page itself).
 *
 * Returns null when the `blog` system page row is missing (a seed/deploy bug,
 * surfaced as notFound() by the caller). The term itself is resolved + 404'd by
 * the route BEFORE calling this.
 */
export async function renderCmsBlogArchive(
  term: BlogArchiveTerm,
  opts?: { search?: Record<string, string | string[] | undefined> },
): Promise<React.ReactElement | null> {
  const [pageRows] = (await db.execute(sql`
    SELECT id, title FROM pages
    WHERE slug = 'blog'
      AND deleted_at IS NULL
      AND published = 1
      AND kind = 'page'
    LIMIT 1
  `)) as unknown as [Array<{ id: number; title: string }>]
  const row = pageRows[0]
  if (!row) return null

  const loopFilter =
    term.kind === 'category'
      ? ({ category: term.slug } as const)
      : ({ tag: term.slug } as const)

  const hydrated = await hydratePage(row.id, {
    loopPage: parseLoopPage(opts?.search),
    loopFilter,
  })
  if (!hydrated) return null
  const { blocks, media, projects, posts, postsLoop, postCardsByBlock, themeMode } = hydrated

  // An undefined postsLoop means the operator's `/blog` system page has no
  // loop-mode lx_posts block, so the archive can't list any posts (it still
  // renders the shell + header). That's a misconfiguration, not a crash —
  // warn (structured, diagnosable) so it surfaces in logs without breaking
  // the page.
  if (postsLoop === undefined) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'blog_archive_no_loop_block',
        term_kind: term.kind,
        term_slug: term.slug,
      }),
    )
  }

  const csrf = await mintPublicPreCsrfForBlocks(blocks, 'blog')

  // Phase 5: segment-aware "Blog" breadcrumb link.
  const segments = await resolveSegments()

  const kindLabel = term.kind === 'category' ? 'Category' : 'Tag'

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-12 sm:py-16">
      {/* Archive header — breadcrumb + term name + optional description. The
          <h1> is the archive's semantic top-level heading (the /blog shell's
          own heading, if any, renders below as an h2-level section). */}
      {/* Theme-aware chrome (FIX 3): this archive header sits on the PAGE
          background, which flips light↔dark with the operator's theme
          (--brand-base-bg/fg). So primary text INHERITS the body foreground
          (no fixed text-near-black, which would be invisible on a dark theme);
          the eyebrow uses the theme accent (champagne → --brand-accent); muted
          text stays warm-stone (already theme-aware → --brand-secondary). */}
      <header className="mb-10">
        <nav aria-label="Breadcrumb" className="mb-4">
          <ol className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-eyebrow text-warm-stone">
            <li>
              <Link href="/" className="transition-colors hover:text-champagne">
                Home
              </Link>
            </li>
            <li aria-hidden className="text-warm-stone/50">
              /
            </li>
            <li>
              <Link
                href={blogIndexUrl(1, segments)}
                className="transition-colors hover:text-champagne"
              >
                Blog
              </Link>
            </li>
            <li aria-hidden className="text-warm-stone/50">
              /
            </li>
            {/* Inherits body foreground (theme-flips) — no fixed dark token. */}
            <li>{term.name}</li>
          </ol>
        </nav>
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-champagne">
          {kindLabel}
        </p>
        <h1 className="mt-3 font-serif text-4xl font-bold tracking-tight sm:text-5xl">
          {term.name}
        </h1>
        {term.description && term.description.trim() !== '' && (
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-warm-stone">
            {term.description}
          </p>
        )}
      </header>

      <BlockTreeRenderer
        blocks={blocks}
        media={media}
        projects={projects}
        posts={posts}
        postsLoop={postsLoop}
        postCardsByBlock={postCardsByBlock}
        themeMode={themeMode}
        csrf={csrf}
      />
    </main>
  )
}
// ── end blog-system worktree taxonomy archive render ─────────────────────────
