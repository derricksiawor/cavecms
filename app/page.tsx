// Home route — `/`. Layout's `await headers()` already forces dynamic;
// declaring it here too makes the intent explicit and survives layout
// refactors.
export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import nextDynamic from 'next/dynamic'
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { hydratePage } from '@/lib/cms/hydrate'
import { getSession, canEdit, resolveEditableMode } from '@/lib/auth/getSession'
import { EditModePill } from '@/components/inline-edit/EditModePill'
import { OutlinePanel } from '@/components/inline-edit/OutlinePanel'
import { ToastProvider } from '@/components/inline-edit/Toast'
import { EditableMain } from '@/components/inline-edit/EditableMain'
import { mintPublicPreCsrfForBlocks } from '@/app/_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { safeJsonForScript } from '@/lib/seo/escape'
import { jsonLdForPage } from '@/lib/seo/page-jsonld'
import { verifyPreviewToken } from '@/lib/cms/verifyPreviewToken'
import { HomePageEmptyState } from '@/components/HomePageEmptyState'
import type { PageRawRow } from '@/lib/cms/types'

// `nextDynamic` retained for the SplashFallback path (MediaPickerProvider
// wrap on the launch-soon screen for admin-edit-mode visitors). The
// public BlockTreeRenderer path goes through <EditableMain> which
// dynamic-imports MediaPickerProvider itself. DO NOT rename `nextDynamic`
// back to `dynamic` — the local `export const dynamic = 'force-dynamic'`
// route-segment config above claims the `dynamic` identifier. An
// "organize imports" / rename refactor that collides the two would
// silently break the per-request DB fetch contract (Next would
// statically optimise the route).
const MediaPickerProvider = nextDynamic(
  () => import('@/components/inline-edit/MediaPickerProvider').then((m) => m.MediaPickerProvider),
)

type SearchParams = Promise<Record<string, string | string[] | undefined>>

// Home metadata reads the `is_home=1` row (slug coupling is GONE per
// spec §2.3 — a renamed home row still owns `/` via the url_path
// generated column). If the home row is missing or soft-deleted,
// fall back to default site metadata.
export async function generateMetadata() {
  const [rows] = (await db.execute(sql`
    SELECT seo_title, seo_description
    FROM pages
    WHERE is_home = 1 AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [
    Array<{ seo_title: string | null; seo_description: string | null }>,
  ]
  const r = rows[0]
  return resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? null,
    fallbackTitle: 'CaveCMS',
    canonicalPath: '/',
  })
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const search = await searchParams
  const previewRaw = search['preview']
  const previewToken =
    typeof previewRaw === 'string' && previewRaw.length > 0 ? previewRaw : null

  // Preview-token branch (spec §2.5: home-page preview hook).
  //
  // The mint route (PR-3 territory) issues tokens with `sub = page:{id}`
  // bound to the home row's id at mint time. Verification resolves via
  // `is_home=1` (NOT slug) so a renamed home row still verifies — but
  // sub binding pins to the row id, so a leaked token replayed after
  // a different page becomes home fails sub_mismatch.
  if (previewToken) {
    const verified = await verifyPreviewToken({
      token: previewToken,
      isHome: true,
    })
    if (!verified.ok) {
      console.info(
        JSON.stringify({
          level: 'info',
          msg: 'preview_token_rejected',
          isHome: true,
        }),
      )
      notFound()
    }
    return renderHome(verified.page, { preview: true, search })
  }

  // Public branch. Home row lookup keys on `is_home=1 AND published=1
  // AND deleted_at IS NULL` — slug coupling is gone. EmptyHome
  // failsafe fires when ANY of those filters trims the row (soft-
  // deleted, unpublished, or no row at all).
  //
  // DISTINGUISH "row missing" FROM "DB threw" — otherwise a transient
  // MariaDB outage gets papered over as a 200 EmptyHome, hiding the
  // outage from any operator monitoring HTTP status codes. On DB
  // failure we rethrow so Next.js surfaces 500 and ops alerting
  // catches the 5xx spike; on legitimate missing-row we serve
  // EmptyHome at 200.
  let homePage: PageRawRow | null = null
  let lookupFailed = false
  try {
    const [rows] = (await db.execute(sql`
      SELECT * FROM pages
      WHERE is_home = 1 AND published = 1 AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as [PageRawRow[]]
    homePage = rows[0] ?? null
  } catch (e) {
    lookupFailed = true
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'home_page_lookup_failed',
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }

  if (lookupFailed) {
    // Re-throw so Next surfaces 500 and alerting catches the spike.
    // Throwing AFTER the log line so the structured signal is
    // emitted regardless of the error-boundary path Next takes.
    throw new Error('home_page_lookup_failed')
  }

  if (!homePage) {
    // EmptyHome failsafe (spec §2.4). The acceptance test greps the
    // unauthenticated HTML for `/admin` and MUST return zero — the
    // HomePageEmptyState component carries no admin URL. Authenticated
    // admins see the admin bar's separate recovery CTA (rendered above
    // children by app/layout.tsx) which DOES contain `/admin/...`
    // links; that's per-spec intent and is NOT covered by the
    // unauthenticated grep test.
    return <HomePageEmptyState />
  }
  return renderHome(homePage, { preview: false, search })
}

async function renderHome(
  page: PageRawRow,
  opts: {
    preview: boolean
    search: Record<string, string | string[] | undefined>
  },
): Promise<React.ReactElement> {
  // Session resolution wrapped — a bad cookie should never block
  // public render. Preserves the defensive pattern from the pre-PR-2
  // home page.
  let session: Awaited<ReturnType<typeof getSession>> = null
  try {
    session = await getSession()
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'home_session_resolve_failed',
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }
  const c = await cookies()
  const editable = resolveEditableMode(session, c, opts.search)

  let hydrated: Awaited<ReturnType<typeof hydratePage>> | null = null
  try {
    hydrated = await hydratePage(page.id)
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'home_page_render_failed',
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }

  // SplashFallback covers two cases:
  //   1. hydrate threw (DB outage / corruption) — always show splash.
  //   2. zero blocks AND no edit chrome — preserves the launch-soon
  //      experience for unauthenticated visitors and signed-in viewers.
  // When the admin is in edit mode on a zero-block home, fall through to
  // BlockTreeRenderer (returns null) + EditModeEmptyState so the
  // operator can bootstrap content from `/` without the marketing
  // splash hiding the "add your first block" CTA.
  if (!hydrated || (hydrated.blocks.length === 0 && !editable)) {
    return (
      <SplashFallback
        session={session}
        editable={editable}
        pageId={page.id}
      />
    )
  }

  const { blocks, media, projects } = hydrated
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
      session={session}
      editable={editable}
      preview={opts.preview}
      csrf={csrf}
    >
      {/* sr-only page H1 — only when no Hero widget is present. The
          Hero widget emits its own visible <h1>{data.title}</h1>;
          duplicating a sr-only one above it gives the page two H1s
          and an SEO duplicate-heading penalty. When NO Hero exists
          (pages built from Text/Heading widgets only), this sr-only
          H1 is the page's semantic top-level heading. Audit V3 +
          self-review dedup (Chunk K). */}
      {!blocks.some((b) => b.blockType === 'hero') && (
        <h1 className="sr-only">{page.title}</h1>
      )}
      {/* Per-page JSON-LD. safeJsonForScript escapes </script>, --> and
          U+2028/U+2029 so admin-controlled fields (title, seoDescription)
          can never break out of the script tag. The layout emits
          Organization globally; this entry is page-scoped (WebSite for
          home, AboutPage for about, etc — see lib/seo/page-jsonld.ts). */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
      />
    </EditableMain>
  )
}

// Splash fallback — preserves the launch-soon experience for the case
// where the home row exists + is published but has no content blocks
// yet (e.g. fresh install where the seed row is published-by-default
// but no blocks have been authored). All classes, animations, and
// content are preserved exactly from the pre-PR-2 page.tsx.
function SplashFallback({
  session,
  editable,
  pageId,
}: {
  session: Awaited<ReturnType<typeof getSession>>
  editable: boolean
  pageId: number | null
}) {
  const main = (
    <main className="relative min-h-screen overflow-hidden bg-cream">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-[10%] h-[520px] w-[520px] rounded-full bg-copper-200/40 blur-[140px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 right-[5%] h-[480px] w-[480px] rounded-full bg-copper-300/30 blur-[140px]"
      />

      <section className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col items-start justify-center px-8 py-24 sm:px-12">
        <p className="text-xs font-semibold uppercase tracking-[0.42em] text-copper-600 animate-cavecms-rise">
          CaveCMS
        </p>
        <h1 className="mt-8 font-serif text-5xl font-bold tracking-tight text-near-black sm:text-7xl lg:text-[5.5rem] leading-[1.02] animate-cavecms-rise [animation-delay:120ms]">
          Built for those who notice the details.
        </h1>
        <p className="mt-10 max-w-2xl text-base font-medium leading-relaxed text-warm-stone sm:text-lg animate-cavecms-rise [animation-delay:260ms]">
          Luxury residential developments in Accra. The new bestworldproperties.com is
          under construction — three projects, refined craftsmanship, quiet confidence.
        </p>

        <div className="mt-16 flex items-center gap-6 animate-cavecms-rise [animation-delay:380ms]">
          <span className="inline-flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.32em] text-near-black/60">
            <span className="block h-px w-12 bg-copper-500" />
            Launching soon
          </span>
        </div>
      </section>

      {canEdit(session) && <EditModePill on={editable} />}
      {editable && pageId && <OutlinePanel pageId={pageId} initial={[]} />}
    </main>
  )

  return canEdit(session) ? (
    <ToastProvider>
      <MediaPickerProvider>{main}</MediaPickerProvider>
    </ToastProvider>
  ) : (
    main
  )
}
