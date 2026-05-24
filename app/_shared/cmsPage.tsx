import 'server-only'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { hydratePage } from '@/lib/cms/hydrate'
import { getSession, resolveEditableMode } from '@/lib/auth/getSession'
import { ensurePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { EditableMain } from '@/components/inline-edit/EditableMain'

// Block types that submit to a public lead endpoint. When any one of
// these appears in a page's hydrated tree, the page-level renderer
// mints a preCsrf nonce and threads it through RenderContext so the
// form submits cleanly on the first interaction. Listed centrally here
// so adding a new form block (newsletter, brochure, inquiry, etc) is
// one line — not a tree-scanning expression in three places.
const FORM_BLOCK_TYPES = new Set<string>(['contact_form'])

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

export type CmsPageSlug =
  | 'home'
  | 'about'
  | 'services'
  | 'contact'
  | 'projects'
  | 'privacy'
  | 'terms'

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

  const hydrated = await hydratePage(pageId)
  if (!hydrated) return null

  // Organization JSON-LD is emitted by app/layout.tsx for every
  // public route, so we don't duplicate it here. Per-entity LD
  // (Residence, BlogPosting) lives on the route that knows about
  // the entity.
  const { blocks, media, projects } = hydrated

  const csrf = await mintPublicPreCsrfForBlocks(blocks, slug)

  // Same sr-only <h1> pattern as app/page.tsx + app/_page/[slug]/
  // page.tsx — guarantees every CMS-driven page has a semantic
  // top-level heading for SEO + screen readers even when operators
  // built the page from Text/Heading widgets only. Skipped when a
  // Hero widget is present (Hero emits its own visible <h1> from
  // data.title; a duplicate sr-only would trip the SEO duplicate-
  // heading penalty). Re-audit fix for V3 regression discovered on
  // /contact post-Chunk-K.
  const hasHero = blocks.some((b) => b.blockType === 'hero')

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
      session={session}
      editable={editable}
      showEmptyState={false}
      csrf={csrf}
    >
      {!hasHero && <h1 className="sr-only">{pageTitle}</h1>}
    </EditableMain>
  )
}
