import { notFound, permanentRedirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { hydratePage } from '@/lib/cms/hydrate'
import { hydrateProject } from '@/lib/cms/hydrate'
import { getProjectRow } from '@/lib/cms/getProjectRow'
import { verifyPreviewJwt } from '@/lib/auth/jwt'
import { renderSection } from '@/components/project-sections'
import { SummarySection } from '@/components/project-sections/Summary/render'
import { FactsStripSection } from '@/components/project-sections/FactsStrip/render'
import { SimilarProjectsRailSection } from '@/components/project-sections/SimilarProjectsRail/render'
import { StickyHeader } from '@/components/project-sections/StickyHeader/render'
import { WhatsAppBubble } from '@/components/project-sections/WhatsAppBubble/render'
import type {
  HeroData,
  PricingData,
} from '@/components/project-sections/_shared/types'
import { residenceLd } from '@/lib/seo/jsonLd'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { resolveMetadata } from '@/lib/seo/resolve'
import { safeJsonForScript } from '@/lib/seo/escape'
import { ensurePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { getSession, resolveEditableMode } from '@/lib/auth/getSession'
import { getSetting } from '@/lib/cms/getSettings'
import { EditableMain } from '@/components/inline-edit/EditableMain'
import { mintPublicPreCsrfForBlocks } from '@/app/_shared/cmsPage'

// Layout already forces dynamic via headers(); declaring here is
// belt-and-braces and documents intent.
export const dynamic = 'force-dynamic'

type Params = Promise<{ slug: string }>
type SearchParams = Promise<{ preview?: string }>

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { slug } = await params
  const sp = await searchParams

  // Shared cached read — getProjectRow is wrapped in React's
  // cache(), so when the page body's hydrateProject calls it later
  // in the same request the row is already memoised.
  const p = await getProjectRow(slug)
  const base = await resolveMetadata({
    title: p?.seo_title ?? null,
    description: p?.seo_description ?? null,
    fallbackTitle: p?.name ?? 'Project',
    fallbackDescription: p?.tagline ?? undefined,
    canonicalPath: `/projects/${slug}`,
  })
  if (sp.preview) {
    return { ...base, robots: { index: false, follow: false } }
  }
  return base
}

// /projects/[slug] — CMS-FIRST rendering.
//
// Resolution order:
//   1. Verify the project exists (slug → projects row).
//   2. If a `pages` row exists at the same slug AND is published →
//      render that block tree via EditableMain. This is the
//      preferred path; project_sections is being phased out.
//   3. Else fall back to the legacy project_sections render. This
//      branch survives only until each project gets its own block
//      tree migrated through /admin/pages.
//
// In all cases the page is wrapped with the project-context chrome
// (StickyHeader + WhatsAppBubble pinned by client; SimilarProjects
// rail at the bottom) so the navigation experience stays consistent
// across CMS-rendered and legacy-rendered projects.
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { slug } = await params
  const sp = await searchParams

  // ─── Session + edit mode (resolved first) ─────────────────────
  // Resolved BEFORE the project lookup so an admin in edit mode can
  // resolve + edit an UNPUBLISHED project (a new draft, or a project
  // being prepared for launch) without a preview token — public
  // visitors still 404 on an unpublished project. Also gates the page
  // lookup below (draft / dark-launch block tree reachable for editors).
  let session: Awaited<ReturnType<typeof getSession>> = null
  try {
    session = await getSession()
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'project_cms_page_session_resolve_failed',
        slug,
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }
  const c = await cookies()
  const editable = resolveEditableMode(session, c, sp)

  // ─── Project lookup (always) ──────────────────────────────────
  // The project row drives SEO, the sticky header, the WhatsApp
  // bubble's CTA copy, and the SimilarProjects rail's exclusion
  // filter — so we resolve it FIRST regardless of which render
  // branch wins. Editors (edit mode on) may resolve an unpublished
  // project so they can build its page before publishing; everyone
  // else is published-only.
  let hydratedProject = await hydrateProject(slug, { allowUnpublished: editable })
  let previewMode = false

  if (!hydratedProject) {
    // Renamed-project fallback. permanentRedirect throws NEXT_REDIRECT
    // which the runtime surfaces as HTTP 308.
    const [redirRows] = (await db.execute(sql`
      SELECT new_slug FROM slug_redirects
      WHERE resource_type = 'project' AND old_slug = ${slug}
    `)) as unknown as [Array<{ new_slug: string }>]
    if (redirRows[0]) permanentRedirect(`/projects/${redirRows[0].new_slug}`)

    // Preview-token branch — admin QA against unpublished rows.
    if (sp.preview) {
      const unpublished = await hydrateProject(slug, { allowUnpublished: true })
      if (!unpublished) notFound()
      try {
        await verifyPreviewJwt(sp.preview, {
          type: 'project',
          id: unpublished.project.id,
          epoch: unpublished.project.preview_epoch,
        })
      } catch {
        notFound()
      }
      hydratedProject = unpublished
      previewMode = true
    } else {
      notFound()
    }
  }

  // ─── CMS page lookup (preferred render path) ──────────────────
  // A `pages` row matching the project slug is the canonical render —
  // the project_sections path below is dead for this project.
  // published=1 is required for PUBLIC visitors; editors (edit mode) and
  // preview get the row regardless so the draft / dark-launch block tree
  // is reachable + editable. (A public visitor never reaches here for an
  // unpublished PROJECT — that 404s above unless a preview token was
  // presented, so this only ever serves an unpublished page row to an
  // admin/preview.)
  const allowUnpublishedPage = editable || previewMode
  const [pageRows] = (await db.execute(sql`
    SELECT id, version FROM pages
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND is_home = 0
      ${allowUnpublishedPage ? sql`` : sql`AND published = 1`}
    LIMIT 1
  `)) as unknown as [Array<{ id: number; version: number }>]
  const pageRow = pageRows[0]

  // Contact info for the WhatsApp click-to-chat bubble.
  const contactInfo = await getSetting('contact_info')

  if (pageRow) {
    // CMS block-tree render. Same wiring as renderCmsPage in
    // app/_shared/cmsPage.tsx but inlined here because (a) we already
    // have the project resolved for chrome, (b) we want the
    // SimilarProjects rail rendered AFTER the EditableMain shell,
    // and (c) the bare slug union in cmsPage.tsx doesn't include
    // arbitrary project slugs.
    const hydratedPage = await hydratePage(pageRow.id)
    if (!hydratedPage) notFound()
    const { blocks, media, projects, posts } = hydratedPage
    const csrf = await mintPublicPreCsrfForBlocks(blocks, slug)

    // JSON-LD still uses the project's structured-data shape — the
    // pages-CMS render doesn't change what THIS URL represents.
    const heroVariants = hydratedProject.project.hero_image_id
      ? hydratedProject.media.get(hydratedProject.project.hero_image_id)
          ?.variants
      : null
    // Pricing for the residence JSON-LD + FactsStrip reads from the
    // migrated `lx_pricing` BLOCK — the editable source of truth on a
    // CMS project — so editing the pricing block updates the rich-result
    // AggregateOffer + the facts strip in lockstep (the legacy section
    // accordion is hidden once a page row exists). Falls back to the
    // legacy project_sections.pricing only if no lx_pricing block is on
    // the tree (defence for an unexpectedly-shaped migration), and that
    // legacy row is also what the not-yet-migrated legacy branch reads.
    const pricingBlock = blocks.find((b) => b.blockType === 'lx_pricing')
    const legacyPricing = hydratedProject.sections.find(
      (s) => s.sectionKey === 'pricing',
    )?.data as PricingData | undefined
    const pricingData =
      (pricingBlock?.data as PricingData | undefined) ?? legacyPricing
    const siteOrigin = await getSiteOrigin()
    const ld = residenceLd({
      name: hydratedProject.project.name,
      tagline: hydratedProject.project.tagline,
      slug: hydratedProject.project.slug,
      heroImage: heroVariants?.lg ?? null,
      location: hydratedProject.project.location,
      priceMin: pricingData?.price_min,
      priceMax: pricingData?.price_max,
      priceCurrency: pricingData?.price_currency,
      siteOrigin,
    })

    return (
      <>
        <EditableMain
          pageId={pageRow.id}
          pageVersion={pageRow.version}
          blocks={blocks}
          media={media}
          projects={projects}
          posts={posts}
          session={session}
          editable={editable}
          preview={previewMode}
          showEmptyState={false}
          csrf={csrf}
          project={{
            id: hydratedProject.project.id,
            slug: hydratedProject.project.slug,
            name: hydratedProject.project.name,
            tagline: hydratedProject.project.tagline,
            status: hydratedProject.project.status,
            location: hydratedProject.project.location,
            brochure_pdf_id: hydratedProject.project.brochure_pdf_id,
            // Resolved pricing (from the lx_pricing block) so the
            // auto-derived lx_project_facts band reads the same source
            // as the JSON-LD AggregateOffer.
            pricing: pricingData ?? null,
          }}
        >
          <h1 className="sr-only">{hydratedProject.project.name}</h1>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
          />
        </EditableMain>

        {/* FactsStrip is NOT rendered page-level on the CMS branch —
           it's an in-tree lx_project_facts block (auto-derived from the
           project context) the backfill places right after the hero, so
           it sits in the legacy under-hero position instead of at the
           bottom of the page. */}

        {/* Cross-promotion rail — lives outside <main> as a
           page-level discovery surface, analogous to <footer>. Same
           positioning the legacy render used; lifted out so the
           CMS-tree branch and the legacy branch share one
           bottom-of-page experience. */}
        <SimilarProjectsRailSection
          projectId={hydratedProject.project.id}
          projectStatus={hydratedProject.project.status}
          projectLocation={hydratedProject.project.location}
        />

        <StickyHeader
          projectName={hydratedProject.project.name}
          projectStatus={hydratedProject.project.status}
        />
        {contactInfo.phone && (
          <WhatsAppBubble
            phone={contactInfo.phone}
            projectName={hydratedProject.project.name}
          />
        )}
      </>
    )
  }

  // ─── Legacy project_sections render ───────────────────────────
  // Surviving path for projects that don't yet have a CMS block
  // tree (Mantebea, Anowaa as of this writing). Each project should
  // migrate by getting a `pages` row at its slug with the block tree
  // editors expect; once migrated this branch becomes unreachable
  // for that project. When ALL projects are migrated, this block
  // and every project-sections import above can be deleted.

  // Pre-CSRF nonce for the brochure + inquiry forms.
  const preCsrf = previewMode ? '' : await ensurePublicPreCsrf()

  const heroSection = hydratedProject.sections.find(
    (s) => s.sectionKey === 'hero',
  )
  const pricingSection = hydratedProject.sections.find(
    (s) => s.sectionKey === 'pricing',
  )
  const heroData = heroSection?.data as HeroData | undefined
  const pricingData = pricingSection?.data as PricingData | undefined

  const heroVariants = hydratedProject.project.hero_image_id
    ? hydratedProject.media.get(hydratedProject.project.hero_image_id)?.variants
    : null
  const siteOrigin = await getSiteOrigin()
  const ld = residenceLd({
    name: hydratedProject.project.name,
    tagline: hydratedProject.project.tagline,
    slug: hydratedProject.project.slug,
    heroImage: heroVariants?.lg ?? null,
    location: hydratedProject.project.location,
    priceMin: pricingData?.price_min,
    priceMax: pricingData?.price_max,
    priceCurrency: pricingData?.price_currency,
    siteOrigin,
  })

  const ctx = {
    preCsrf,
    previewMode,
    projectId: hydratedProject.project.id,
    projectName: hydratedProject.project.name,
    projectTagline: hydratedProject.project.tagline,
    projectStatus: hydratedProject.project.status,
  }

  const remainingSections = hydratedProject.sections.filter(
    (s) => s.sectionKey !== 'hero',
  )

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
      />
      <h1 className="sr-only">{hydratedProject.project.name}</h1>

      {heroSection &&
        renderSection(
          heroSection.sectionKey,
          heroSection.data,
          hydratedProject.media,
          ctx,
        )}

      <FactsStripSection
        status={hydratedProject.project.status}
        location={hydratedProject.project.location}
        pricing={pricingData ?? null}
      />

      {heroData && <SummarySection data={heroData} />}

      {remainingSections.map((s) => (
        <div key={s.id}>
          {renderSection(s.sectionKey, s.data, hydratedProject.media, ctx)}
        </div>
      ))}

      <SimilarProjectsRailSection
        projectId={hydratedProject.project.id}
        projectStatus={hydratedProject.project.status}
        projectLocation={hydratedProject.project.location}
      />

      <StickyHeader
        projectName={hydratedProject.project.name}
        projectStatus={hydratedProject.project.status}
      />
      {contactInfo.phone && (
        <WhatsAppBubble
          phone={contactInfo.phone}
          projectName={hydratedProject.project.name}
        />
      )}
    </main>
  )
}
