import { notFound, permanentRedirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { renderMarkdown } from '@/lib/cms/markdown'
import { hydratePage } from '@/lib/cms/hydrate'
import { BlockTreeRenderer } from '@/components/inline-edit/BlockTreeRenderer'
import { EditableMain } from '@/components/inline-edit/EditableMain'
import { getSession, resolveEditableMode } from '@/lib/auth/getSession'
import { mintPublicPreCsrfForBlocks } from '@/app/_shared/cmsPage'
import { blogPostingLd } from '@/lib/seo/jsonLd'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
// Phase 7: blog_settings (showReadingTime / relatedPostsCount) for the detail chrome.
import { getSetting } from '@/lib/cms/getSettings'
import { resolveMetadata } from '@/lib/seo/resolve'
import { safeJsonForScript } from '@/lib/seo/escape'
import { TaxonomyPills, type TermLink } from '@/components/post-sections/TaxonomyPills'
// blog-system worktree (Phase 7): related-posts rail (mirrors SimilarProjectsRail).
import { SimilarPostsRailSection } from '@/components/post-sections/SimilarPostsRail/render'
// blog-system worktree (Phase 5): resolve the configured permalink segments once
// per request and thread into the URL helpers so canonical / slug-redirect /
// taxonomy-pill URLs honor a custom segment + post-path structure.
import { resolveSegments } from '@/lib/blog/resolveSegments'
import { postUrl, blogIndexUrl, categoryUrl } from '@/lib/blog/urls'
// blog-system worktree (Phase 8): public post-visibility gate. The PUBLIC lookup
// + generateMetadata both apply it (so a scheduled post is hidden until its
// time); the EDITOR PREVIEW branch (admin/editor in edit mode) is deliberately
// LEFT UNGATED so a draft / scheduled post stays previewable in place.
import { publicPostGateSql } from '@/lib/cms/postStatus'
// F14: single source of truth for the reading-time SQL (shared with the Blog
// Loop slice in lib/cms/hydrate) so the formula + magic constant can't drift.
import { readingTimeSql } from '@/lib/cms/readingTime'
// SEO Suite (main): per-entity JSON-LD + post-level SEO meta (og/twitter
// overrides, schema defaults) parsed from the post's seo_meta JSON.
import { extraSchemaForEntity } from '@/lib/seo/schema/forPage'
import { parseSeoMeta, schemaDefaultsFromSetting } from '@/lib/seo/seoMeta'

export const dynamic = 'force-dynamic'

type Params = Promise<{ slug: string }>
type SearchParams = Promise<Record<string, string | string[] | undefined>>

export async function generateMetadata({ params }: { params: Params }) {
  const { slug } = await params
  // Apply the FULL public gate (Phase 8: published + not-trashed + publish time
  // arrived) so a probe on an unpublished OR scheduled slug never leaks draft /
  // scheduled SEO metadata — the render path serves a draft/scheduled post only
  // to an authenticated editor in edit mode (gated below), but metadata falls
  // through to the site default for everyone, including that editor. Mirrors
  // app/cms-render/[slug]/page.tsx's metadata discipline. Aliased `p` so the
  // shared gate fragment applies cleanly.
  const [rows] = (await db.execute(sql`
    SELECT p.title, p.excerpt, p.seo_title, p.seo_description, p.published_at,
           p.robots_noindex, p.robots_nofollow, p.canonical_url, p.seo_meta
    FROM posts p
    WHERE p.slug = ${slug}
      ${publicPostGateSql('p')}
  `)) as unknown as [
    Array<{
      title: string
      excerpt: string | null
      seo_title: string | null
      seo_description: string | null
      published_at: Date | string | null
      robots_noindex: number | null
      robots_nofollow: number | null
      canonical_url: string | null
      seo_meta: unknown
    }>,
  ]
  const r = rows[0]
  const meta = parseSeoMeta(r?.seo_meta)
  // Phase 5: canonical honors the configured permalink segment + post-path structure.
  const segments = await resolveSegments()
  return resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? r?.excerpt ?? null,
    fallbackTitle: r?.title ?? 'Post',
    // Phase 5: segment-aware canonical (honors a custom blog segment +
    // post-path structure). An operator-set canonical_url still wins via
    // canonicalOverride below (resolveMetadata prefers the override).
    canonicalPath: postUrl(slug, segments, r?.published_at ?? null),
    contentType: 'post',
    templateVars: { title: r?.title ?? undefined, excerpt: r?.excerpt ?? undefined },
    noindex: !!r?.robots_noindex,
    nofollow: !!r?.robots_nofollow,
    canonicalOverride: r?.canonical_url,
    ogTitle: meta.ogTitle,
    ogDescription: meta.ogDescription,
    twitterTitle: meta.twitterTitle,
    twitterDescription: meta.twitterDescription,
  })
}

interface PostDetailRow {
  id: number
  slug: string
  title: string
  excerpt: string | null
  body_md: string
  // Hidden body page (kind='post_body') whose content_blocks tree IS the
  // post body. NULL for an un-migrated post → falls back to body_md.
  body_page_id: number | null
  // Raw publish flag — mysql2 returns TINYINT(1) as 0|1. Needed so the
  // editor-draft branch can distinguish "unpublished but authored by an
  // editor in edit mode" from a published row.
  published: number
  // mysql2 may return TIMESTAMP as Date OR ISO string depending on
  // driver config (`dateStrings`). Accept both and convert at use.
  published_at: Date | string | null
  // Phase 7: post last-edit time → drives the "Updated <date>" chrome line +
  // the BlogPosting dateModified JSON-LD. mysql2 may hand it back as Date OR
  // string (dateStrings); normalized at use like published_at.
  updated_at: Date | string | null
  hero_image_id: number | null
  author_name: string | null
  hero_variants: string | { lg?: string } | null
  // Phase 7: ≈200-wpm reading-time estimate computed in SQL from body_md char
  // length via the SHARED readingTimeSql fragment (lib/cms/readingTime, F14) —
  // so the formula + magic constant are IDENTICAL to the Blog Loop hydrate
  // (lib/cms/hydrate.ts) and can't drift. Keeps the body text out of app memory
  // and the estimate consistent with the index card. body_md is retained as the
  // body source of truth even after the
  // block-tree migration, so it stays the word-count source for both surfaces.
  reading_minutes: number | string | bigint
  // SEO Suite (main): post-level SEO description + seo_meta JSON (og/twitter
  // overrides, schema defaults) consumed by the JSON-LD + meta resolution.
  seo_description: string | null
  seo_meta: unknown
}

// NOTE: do NOT wrap the body of this function in try/catch. Next.js
// signals redirects/notFounds via thrown errors (NEXT_REDIRECT,
// NEXT_NOT_FOUND). A naive try/catch would swallow these and produce
// a 200 with broken markup.
export default async function BlogPost({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { slug } = await params
  const search = await searchParams

  // Phase 5: resolve the configured permalink segments once for this render —
  // threaded into the slug-redirect target + taxonomy pills below.
  const segments = await resolveSegments()

  // ─── Session + edit mode (resolved first) ─────────────────────
  // Resolved BEFORE the post lookup so an admin/editor in edit mode can
  // resolve + edit an UNPUBLISHED post (a fresh draft) WITHOUT a preview
  // token — mirroring app/projects/[slug]/page.tsx. Public visitors
  // still 404 on an unpublished post. resolveEditableMode returns true
  // ONLY for an admin/editor session with the edit-mode cookie set or a
  // `?edit=1` URL override (canEdit gates the override); a viewer or an
  // anonymous visitor can never satisfy it, so this never leaks a draft
  // or an edit control to the public.
  let session: Awaited<ReturnType<typeof getSession>> = null
  try {
    session = await getSession()
  } catch (e) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'blog_post_session_resolve_failed',
        slug,
        err_name: e instanceof Error ? e.name : 'unknown',
      }),
    )
  }
  const c = await cookies()
  const editable = resolveEditableMode(session, c, search)

  // ─── Post lookup ──────────────────────────────────────────────
  // Public gate (Phase 8): `published = TRUE AND deleted_at IS NULL AND
  // published_at IS NOT NULL AND published_at <= NOW(3)` — a SCHEDULED post
  // (future published_at) is hidden from the public until its time, then auto-
  // appears (this route is force-dynamic, so no cron). An authorized editor in
  // edit mode drops the ENTIRE publish/schedule gate (keeping only `deleted_at
  // IS NULL`) so a DRAFT or SCHEDULED post body stays reachable + previewable +
  // editable in place. `deleted_at IS NULL` is NEVER dropped — a trashed post is
  // unreachable even to an editor (it's restored from Trash, not edited live).
  const [rows] = (await db.execute(sql`
    SELECT p.id, p.slug, p.title, p.excerpt, p.body_md, p.body_page_id,
           p.published, p.published_at, p.updated_at, p.hero_image_id,
           u.name AS author_name,
           m.variants AS hero_variants,
           p.seo_description, p.seo_meta,
           ${readingTimeSql('p')} AS reading_minutes
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN media m ON m.id = p.hero_image_id AND m.deleted_at IS NULL
    WHERE p.slug = ${slug}
      ${editable ? sql`AND p.deleted_at IS NULL` : publicPostGateSql('p')}
  `)) as unknown as [PostDetailRow[]]
  const post = rows[0]

  if (!post) {
    // Resolution order matches /projects/[slug]: published render →
    // slug_redirects 308 → 404. permanentRedirect throws
    // NEXT_REDIRECT which Next surfaces as HTTP 308.
    // Join the target post so the redirect honors the configured segment +
    // structure (for year-month, the canonical needs the target's published_at).
    const [redirRows] = (await db.execute(sql`
      SELECT sr.new_slug, p.published_at
      FROM slug_redirects sr
      LEFT JOIN posts p
        ON p.slug = sr.new_slug AND p.deleted_at IS NULL
      WHERE sr.resource_type = 'post' AND sr.old_slug = ${slug}
    `)) as unknown as [Array<{ new_slug: string; published_at: Date | string | null }>]
    if (redirRows[0]) {
      permanentRedirect(postUrl(redirRows[0].new_slug, segments, redirRows[0].published_at))
    }
    notFound()
  }

  // Draft-preview marker. True only when an authorized editor is viewing
  // an unpublished post (the only way `post.published !== 1` survives the
  // lookup above is `editable === true`). Threaded into EditableMain so
  // any form-bearing block in the body suppresses live submission while
  // the draft is being QA'd — exactly the projects-route behaviour.
  const isUnpublishedDraft = post.published !== 1

  // mysql2 may return the JSON column as either a parsed object or a
  // raw string depending on driver config — match the projects list
  // page's defensive parse.
  const heroVariants: { lg?: string } | null =
    typeof post.hero_variants === 'string'
      ? (JSON.parse(post.hero_variants) as { lg?: string })
      : (post.hero_variants as { lg?: string } | null)

  // published_at is non-null on every published row because the
  // PATCH route stamps it on first publish; the COALESCE check here
  // is defense-in-depth against a hypothetical row that was
  // published via direct DB edit. Normalize to Date regardless of
  // whether mysql2 returned a string or a Date object.
  const publishedAt = post.published_at
    ? new Date(post.published_at)
    : new Date()

  // ─── Phase 7: reading time + updated date ─────────────────────
  // reading_minutes comes straight from SQL (same formula as the Blog Loop
  // card), normalized to a whole minute ≥ 1. Gated on blog_settings.showReadingTime
  // so an operator who hides it on the index hides it on the detail too — one
  // consistent toggle.
  const blog = await getSetting('blog_settings')
  const readingMinutes = Math.max(1, Number(post.reading_minutes) || 1)
  const showReadingTime = blog.showReadingTime !== false

  // "Updated <date>" shows only when updated_at MATERIALLY post-dates
  // published_at (> 1 day later) — a tiny same-day metadata touch (e.g. a
  // taxonomy reassignment) shouldn't read as a content revision. Both are UTC
  // as stored; compared as epoch ms. updatedAt is also threaded into the
  // BlogPosting dateModified JSON-LD below.
  const updatedAt = post.updated_at ? new Date(post.updated_at) : null
  const ONE_DAY_MS = 24 * 60 * 60 * 1000
  const showUpdated =
    updatedAt !== null &&
    !Number.isNaN(updatedAt.getTime()) &&
    updatedAt.getTime() - publishedAt.getTime() > ONE_DAY_MS

  // Load this post's categories + tags for the cross-link pills + breadcrumb.
  // Two small junction-PK-indexed reads; ordered by category position / tag
  // name so the rendered pills are stable. The FIRST category (lowest
  // position) is the "primary" category for the breadcrumb middle crumb.
  const [[catRows], [tagRows]] = await Promise.all([
    db.execute(sql`
      SELECT c.slug, c.name
      FROM post_categories pc
      JOIN categories c ON c.id = pc.category_id
      WHERE pc.post_id = ${post.id}
      ORDER BY c.position, c.id
    `) as unknown as Promise<[Array<{ slug: string; name: string }>]>,
    db.execute(sql`
      SELECT t.slug, t.name
      FROM post_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE pt.post_id = ${post.id}
      ORDER BY t.name, t.id
    `) as unknown as Promise<[Array<{ slug: string; name: string }>]>,
  ])
  const categories: TermLink[] = catRows
  const tags: TermLink[] = tagRows
  const primaryCategory = categories[0] ?? null

  const siteOrigin = await getSiteOrigin()
  const ld = blogPostingLd({
    title: post.title,
    slug: post.slug,
    publishedAt,
    // Phase 7: dateModified — emitted only when updated_at materially post-dates
    // published_at (same > 1-day gate as the "Updated <date>" chrome line), so
    // the rich-result signal matches what the page visibly claims.
    modifiedAt: showUpdated ? updatedAt : null,
    excerpt: post.excerpt,
    heroImage: heroVariants?.lg ?? null,
    author: post.author_name ?? 'CaveCMS',
    siteOrigin,
  })
  // Per-page structured data (SEO Suite, main) — ADDITIONS-ONLY on top of the
  // legacy blogPostingLd PRIMARY emitted above. This emits ONLY (a) the
  // BreadcrumbList (Home › Blog › Post) and (b) the explicit per-page override
  // shape when the operator flips schemaType (e.g. to FAQPage / NewsArticle).
  // It NEVER emits a default Article — that would duplicate the BlogPosting
  // primary the legacy builder already produced for this URL.
  //
  // MERGE NOTE: the entity + breadcrumb URLs are built from the blog branch's
  // segment-aware helpers (postUrl / blogIndexUrl) so a custom permalink
  // segment + post-path structure carries into the schema graph, AND prefixed
  // with siteOrigin like main did. This SUPERSEDES the branch's separate
  // postBreadcrumbLd emission below (dropped to avoid a duplicate
  // BreadcrumbList): extraSchemaForEntity already builds the breadcrumb here
  // and additionally honors the operator's per-page schema override.
  const seoMeta = parseSeoMeta(post.seo_meta)
  const seoSchema = await getSetting('seo_schema')
  const postPath = postUrl(post.slug, segments, post.published_at ?? null)
  const blogPath = blogIndexUrl(1, segments)
  const postAbsUrl = siteOrigin ? `${siteOrigin}${postPath}` : postPath
  const abs = (path: string) => (siteOrigin ? `${siteOrigin}${path}` : path)
  // Home › Blog › [Primary Category] › Post. The primary-category crumb (the
  // post's lowest-position category) is preserved from the blog branch's
  // postBreadcrumbLd, threaded through main's extraSchemaForEntity so the
  // trail stays category-aware AND segment-aware while also gaining the SEO
  // suite's per-page schema override.
  const breadcrumbs = [
    { name: 'Home', url: abs('/') },
    { name: 'Blog', url: abs(blogPath) },
    ...(primaryCategory
      ? [{ name: primaryCategory.name, url: abs(categoryUrl(primaryCategory.slug, 1, segments)) }]
      : []),
    { name: post.title, url: postAbsUrl },
  ]
  const schemaGraph = extraSchemaForEntity({
    entity: {
      kind: 'post',
      title: post.title,
      description: post.seo_description ?? post.excerpt ?? undefined,
      url: postAbsUrl,
      datePublished: publishedAt,
      dateModified: post.updated_at ? new Date(post.updated_at) : undefined,
      author: post.author_name ?? undefined,
      image: heroVariants?.lg ?? undefined,
    },
    override: { schemaType: seoMeta.schemaType, schemaData: seoMeta.schemaData },
    defaults: schemaDefaultsFromSetting(seoSchema),
    breadcrumbs,
  })

  // Shared post chrome (h1 + byline + hero + JSON-LD). Rendered around the body
  // in BOTH the editable and read-only branches so the two views look identical;
  // only the body render differs.
  const chrome = (
    <>
      <script
        type="application/ld+json"
        // safeJsonForScript escapes </script>, --> and U+2028/U+2029
        // so admin-controlled fields (title, excerpt, author) can
        // never break out of the script tag.
        dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
      />
      {/* Per-page schema ADDITIONS + breadcrumbs (SEO Suite, main).
          extraSchemaForEntity returns an already-filtered ordered array (no
          nulls, no default primary) including the segment-aware BreadcrumbList;
          each object is emitted via safeJsonForScript like the legacy
          BlogPosting primary above. This replaces the branch's standalone
          postBreadcrumbLd <script> (its BreadcrumbList is now produced here,
          additionally honoring the operator's per-page schema override). */}
      {schemaGraph.map((node, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonForScript(node) }}
        />
      ))}
      {/* h1 inherits the body foreground (--brand-base-fg) so the title stays
          readable on BOTH a light and a dark theme — no fixed dark token. */}
      <h1 className="text-3xl font-semibold tracking-tight">{post.title}</h1>
      {/* Byline meta row: published date · author · reading time. Reading time
          gated on blog_settings.showReadingTime (consistent with the index card)
          and rendered with a middot separator only when shown. FIX 3: the byline
          uses the THEME accent (champagne → --brand-accent) instead of fixed
          copper so it flips with the operator's theme and reads on dark. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs uppercase tracking-wide text-champagne">
        <time dateTime={publishedAt.toISOString()}>
          {publishedAt.toISOString().slice(0, 10)}
        </time>
        {post.author_name ? <span>· {post.author_name}</span> : null}
        {showReadingTime ? (
          <span>· {readingMinutes} min read</span>
        ) : null}
      </div>
      {/* "Updated <date>" — only when updated_at materially post-dates
          published_at (> 1 day). Quiet, secondary to the publish date. */}
      {showUpdated && updatedAt ? (
        <p className="mt-1 text-[11px] uppercase tracking-wide text-warm-stone">
          Updated{' '}
          <time dateTime={updatedAt.toISOString()}>
            {updatedAt.toISOString().slice(0, 10)}
          </time>
        </p>
      ) : null}
      {/* Taxonomy cross-link pills — categories + tags link to their archives
          so the post connects into the taxonomy graph (#0.592). Phase 5: pass
          the resolved segments so pill URLs honor a custom blog segment. */}
      <TaxonomyPills categories={categories} tags={tags} segments={segments} className="mt-4" />
      {heroVariants?.lg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={heroVariants.lg}
          alt=""
          className="w-full h-auto mt-6 rounded"
        />
      )}
    </>
  )

  // ─── EDITABLE branch — admin/editor in edit mode ──────────────
  // When the viewer is an authorized editor in edit mode AND the post
  // has a body page, render the body blocks inside <EditableMain> so the
  // SAME Wix-style inline-edit drawer that pages use works IN PLACE on
  // the post body. No separate editor, no navigation to /admin — the
  // body page is page_id-keyed exactly like any page, so the existing
  // block-CRUD + InlineEditable plumbing edits it unchanged.
  //
  // EditableMain owns the <main> element, so the post chrome renders as
  // a sibling BEFORE it (mirroring how app/projects/[slug] renders its
  // chrome around the EditableMain shell). The body page's `version` is
  // the optimistic-lock token EditableMain threads into the dual-axis
  // saveBlock TX — fetched here because hydratePage doesn't return it.
  if (editable && post.body_page_id !== null) {
    const [pageRows] = (await db.execute(sql`
      SELECT id, version FROM pages
      WHERE id = ${post.body_page_id}
        AND deleted_at IS NULL
        AND kind = 'post_body'
      LIMIT 1
    `)) as unknown as [Array<{ id: number; version: number }>]
    const bodyPage = pageRows[0]

    if (bodyPage) {
      // currentPostId lets a posts widget IN the body resolve source:'related'
      // + excludeCurrent relative to THIS post.
      const hydrated = await hydratePage(bodyPage.id, { currentPostId: post.id })
      if (hydrated) {
        const { blocks, media, projects, posts, postsLoop, postCardsByBlock, themeMode } = hydrated
        // Mint the public pre-CSRF for the body blocks EXACTLY as
        // cms-render does — covers a form-bearing block dropped into the
        // body. Identical helper, identical contract.
        const csrf = await mintPublicPreCsrfForBlocks(blocks, post.slug)
        return (
          <div className="py-12 max-w-3xl mx-auto px-4">
            {chrome}
            <EditableMain
              pageId={bodyPage.id}
              pageVersion={bodyPage.version}
              blocks={blocks}
              media={media}
              projects={projects}
              posts={posts}
              postsLoop={postsLoop}
              postCardsByBlock={postCardsByBlock}
              themeMode={themeMode}
              session={session}
              editable={editable}
              // A form block in the body suppresses live submission while
              // an editor QAs an unpublished draft — same posture the
              // projects preview branch uses.
              preview={isUnpublishedDraft}
              showEmptyState
              csrf={csrf}
            />
          </div>
        )
      }
    }
    // Body page vanished (orphaned link) — fall through to the read-only
    // render below, which has its own markdown fallback.
  }

  // ─── READ-ONLY branch — public + non-edit-mode admin ──────────
  // Body render — CMS block tree (preferred) with a markdown fallback.
  //
  // When body_page_id is set, the post body lives as a content_blocks
  // tree on a hidden body page (kind='post_body'); render it through the
  // SAME server-only BlockTreeRenderer the cms-render route uses, so a
  // post body composed of lx_richtext + any other block (hero, gallery,
  // CTA, quote) renders identically to a normal CMS page. The body page
  // is hydrated regardless of its own published flag — it is never routed
  // by slug; the PUBLIC gate (published + not-trashed + publish time arrived,
  // Phase 8) is applied to the POST lookup above, so a scheduled post's body is
  // unreachable on the public path until its time (and remains previewable on
  // the editor path, which dropped the gate).
  //
  // FALLBACK: an un-migrated post (body_page_id NULL, mid-migration)
  // keeps rendering renderMarkdown(post.body_md) so nothing breaks while
  // the backfill runs. body_md is retained (never dropped) for exactly
  // this reversibility.
  let bodyNode: React.ReactNode = null
  if (post.body_page_id !== null) {
    // Resolve the body page with the SAME guard the editable branch uses
    // (deleted_at IS NULL AND kind='post_body') BEFORE hydrating, so a body
    // page ever soft-deleted out of lockstep can't render its blocks on the
    // public hot path. hydratePage itself is kind/deleted_at-agnostic.
    const [bodyPageRows] = (await db.execute(sql`
      SELECT id FROM pages
      WHERE id = ${post.body_page_id}
        AND deleted_at IS NULL
        AND kind = 'post_body'
      LIMIT 1
    `)) as unknown as [Array<{ id: number }>]
    const hydrated = bodyPageRows[0]
      ? await hydratePage(bodyPageRows[0].id, { currentPostId: post.id })
      : null
    if (hydrated) {
      const { blocks, media, projects, posts, postsLoop, postCardsByBlock, themeMode } = hydrated
      // Mint a public preCsrf nonce in case the body tree contains a
      // form-bearing block (e.g. a contact_form an operator dropped into
      // a post) — harmless + unused when none is present.
      const csrf = await mintPublicPreCsrfForBlocks(blocks, post.slug)
      bodyNode = (
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
      )
    }
    // hydrated === null means the body page row vanished (orphaned link).
    // Fall through with bodyNode null rather than 500 — the chrome + the
    // markdown fallback below still render the post.
    if (!hydrated) {
      const html = await renderMarkdown(post.body_md)
      bodyNode = (
        <article
          className="prose prose-theme mt-8"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )
    }
  } else {
    const html = await renderMarkdown(post.body_md)
    bodyNode = (
      <article
        className="prose prose-theme mt-8"
        // body_md is server-rendered via the rehype-sanitize pipeline in
        // lib/cms/markdown.ts. The sanitizer is the only trust boundary;
        // the editor surface posts plain markdown.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <>
      <main className="py-12 max-w-3xl mx-auto px-4">
        {chrome}
        {bodyNode}
      </main>
      {/* Phase 7: related-posts rail — a page-level discovery surface placed
          OUTSIDE <main> (like app/projects/[slug]'s SimilarProjectsRail), so it
          spans full width with its own max-w-7xl container instead of being
          clamped to the article's max-w-3xl measure. The component self-gates:
          renders nothing when blog_settings.relatedPostsCount is 0 or no other
          published post exists. Only on the read-only (public + non-edit-mode)
          path — the editable branch above is a focused authoring view. */}
      <SimilarPostsRailSection postId={post.id} />
    </>
  )
}
