import clsx from 'clsx'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext, HydratedPostCardCtx } from '..'
import { isSectionSurfaceDark, type SectionMeta } from '@/lib/cms/blockMeta'
import { GridTemplate, CardsTemplate, ListTemplate, MagazineTemplate } from './templates'
import { PostsCarousel } from './PostsCarousel'
import { PostsLoadMore } from './PostsLoadMore'
import { PostsHeading, PostsEmptyState, PostsItemListJsonLd } from './parts'
import { textTones, type Columns, type PostsTemplate } from './styles'
import type { PostCardToggles } from './PostCard'

// ════════════════════════════════════════════════════════════════════════
// Posts widget — the SYNCHRONOUS top-level dispatcher (server + editor-canvas
// safe; an async server component would throw in the client editor canvas —
// same constraint as lx_code). All data-fetch happens at hydrate; this view
// reads:
//   • self-contained sources (latest/category/tag/author/manual/related) →
//     this block's slice from RenderContext.postCardsByBlock (via `postCards`).
//   • current source (paginated /blog archive) → RenderContext.postsLoop.
//
// It computes the surface-aware tones + presets, then dispatches to one of the
// five layout templates. Pagination (numbered / load-more / none) applies only
// to the `current` source on grid/cards/list; magazine + carousel + every
// self-contained source effectively paginate 'none'.
// ════════════════════════════════════════════════════════════════════════

function NumberedPager({
  postsLoop,
  onDark,
}: {
  postsLoop: NonNullable<RenderContext['postsLoop']>
  onDark: boolean
}) {
  const tones = textTones(onDark)
  const base = postsLoop.basePath ?? '/blog'
  const href = (page: number) => (page <= 1 ? base : `${base}?page=${page}`)
  if (!postsLoop.hasPrev && !postsLoop.hasNext) return null
  return (
    <nav aria-label="Blog pagination" className="mt-14 flex items-center justify-between gap-4">
      {postsLoop.hasPrev ? (
        <a
          href={href(postsLoop.page - 1)}
          rel="prev"
          className={clsx(
            'inline-flex w-fit items-center gap-2 rounded-full px-6 py-3 font-sans text-sm font-semibold tracking-wide transition-colors duration-standard ease-standard min-h-[44px]',
            onDark ? 'bg-ivory/10 text-ivory hover:bg-ivory/15' : 'bg-obsidian/[0.06] text-obsidian hover:bg-obsidian/[0.1]',
          )}
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
          Newer posts
        </a>
      ) : (
        <span />
      )}
      <span className={clsx('font-sans text-xs font-semibold uppercase tracking-eyebrow', tones.meta)}>
        Page {postsLoop.page}
      </span>
      {postsLoop.hasNext ? (
        <a
          href={href(postsLoop.page + 1)}
          rel="next"
          className={clsx(
            'inline-flex w-fit items-center gap-2 rounded-full px-6 py-3 font-sans text-sm font-semibold tracking-wide transition-colors duration-standard ease-standard min-h-[44px]',
            onDark ? 'bg-champagne text-obsidian hover:bg-champagne/90' : 'bg-obsidian text-ivory hover:bg-obsidian/90',
          )}
        >
          Older posts
          <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
        </a>
      ) : (
        <span />
      )}
    </nav>
  )
}

// Map a postsLoop item → the unified card shape (it already carries everything
// except `author`, which the loop slice doesn't resolve → undefined).
function loopItemToCard(it: NonNullable<RenderContext['postsLoop']>['items'][number]): HydratedPostCardCtx {
  return {
    id: it.id,
    slug: it.slug,
    title: it.title,
    excerpt: it.excerpt,
    published_at: it.published_at,
    hero_image_id: it.hero_image_id,
    reading_minutes: it.reading_minutes,
    categories: it.categories,
    url: it.url,
  }
}

export function LxPosts({
  data,
  postsLoop,
  postCards,
  media,
  outerClass,
  sectionMeta,
  themeMode,
}: {
  data: BlockData<'lx_posts'>
  postsLoop?: RenderContext['postsLoop']
  postCards?: HydratedPostCardCtx[]
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
  /** Active theme palette mode (FIX 3). When the widget sits in a section with
   *  NO explicit background and the theme is dark, the surface is the dark page
   *  body — so we resolve onDark=true and the non-card text (heading / empty
   *  state) + card text read light-on-dark instead of dark-on-dark. Absent →
   *  light default (every prior caller). */
  themeMode?: 'light' | 'dark'
}) {
  const onDark = isSectionSurfaceDark(sectionMeta, themeMode)
  const isCurrent = data.source === 'current'

  // Resolve the card list from the active source.
  const cards: HydratedPostCardCtx[] = isCurrent
    ? (postsLoop?.items ?? []).map(loopItemToCard)
    : postCards ?? []

  // ── Effective DISPLAY (FIX 2) ────────────────────────────────────────────
  // For the `current` source the canonical blog index/archive display is
  // AUTHORITATIVELY controlled by Settings → Blog. hydrate.ts no longer bakes
  // those values into `block.data` (so the editor reads/saves raw block
  // values); it carries them on `postsLoop.display` instead. We read the
  // settings-authoritative fields from there for `current`, and fall back to
  // the block's own `data` (e.g. an editor-canvas preview where display may be
  // absent, or the load-more route's slice). Every OTHER source uses its own
  // block data verbatim — those widgets are operator-authored per placement.
  const display = isCurrent ? postsLoop?.display : undefined
  const eff = {
    template: display?.template ?? data.template,
    columns: display?.columns ?? data.columns,
    showImage: display?.showImage ?? data.showImage,
    showExcerpt: display?.showExcerpt ?? data.showExcerpt,
    showDate: display?.showDate ?? data.showDate,
    showAuthor: display?.showAuthor ?? data.showAuthor,
    showCategory: display?.showCategory ?? data.showCategory,
    showReadingTime: display?.showReadingTime ?? data.showReadingTime,
    showReadMore: display?.showReadMore ?? data.showReadMore,
    // readMoreLabel is optional on both sides; a settings display may carry it
    // or not — fall back to the block value, then undefined (renderer default).
    readMoreLabel: display ? display.readMoreLabel : data.readMoreLabel,
    excerptClamp: display?.excerptClamp ?? data.excerptClamp,
    cardStyle: display?.cardStyle ?? data.cardStyle,
    spacing: display?.spacing ?? data.spacing,
    imageAspect: display?.imageAspect ?? data.imageAspect,
    pagination: display?.pagination ?? data.pagination,
  }

  // ── Card content toggles (effective display: settings for `current`,
  //    block data for every other source). titleClamp is NOT settings-backed
  //    (not in the blog_settings reading model) → always the block value. ─────
  const toggles: PostCardToggles = {
    showImage: eff.showImage,
    showDate: eff.showDate,
    showAuthor: eff.showAuthor,
    showCategory: eff.showCategory,
    showExcerpt: eff.showExcerpt,
    showReadingTime: eff.showReadingTime,
    showReadMore: eff.showReadMore,
    readMoreLabel: eff.readMoreLabel,
    titleClamp: data.titleClamp,
    excerptClamp: eff.excerptClamp,
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  if (cards.length === 0) {
    // The legacy recent/home teaser (source:'latest' with no heading on the
    // home page) historically rendered NOTHING when empty so the teaser
    // disappears cleanly. We preserve that ONLY for a headingless latest
    // teaser; every operator-styled surface (anything with a heading, or the
    // canonical archive) gets the designed empty state.
    const isBareTeaser = data.source === 'latest' && !data.heading
    if (isBareTeaser) return null
    const empty = (
      <section className={clsx('mx-auto w-full max-w-6xl', outerClass)}>
        <PostsEmptyState heading={data.heading} onDark={onDark} template={eff.template} />
      </section>
    )
    return data.animation === 'none' ? empty : <MotionTarget preset={data.animation}>{empty}</MotionTarget>
  }

  const columns = eff.columns as Columns
  const template: PostsTemplate = eff.template

  // ── Body — the chosen template ───────────────────────────────────────────
  let body: React.ReactNode
  if (template === 'carousel') {
    body = (
      <PostsCarousel
        cards={cards}
        media={media}
        toggles={toggles}
        aspect={eff.imageAspect}
        onDark={onDark}
        autoplay={data.autoplay}
        intervalMs={data.intervalMs}
        loop={data.carouselLoop}
        showArrows={data.showArrows}
        showDots={data.showDots}
      />
    )
  } else if (template === 'magazine') {
    body = (
      <MagazineTemplate
        cards={cards}
        media={media}
        toggles={toggles}
        cardStyle={eff.cardStyle}
        spacing={eff.spacing}
        aspect={eff.imageAspect}
        columns={columns}
        onDark={onDark}
      />
    )
  } else if (template === 'list') {
    body = (
      <ListTemplate
        cards={cards}
        media={media}
        toggles={toggles}
        cardStyle={eff.cardStyle}
        spacing={eff.spacing}
        aspect={eff.imageAspect}
        columns={1}
        onDark={onDark}
        imageSide="left"
      />
    )
  } else {
    const Template = template === 'cards' ? CardsTemplate : GridTemplate
    // cards template caps at 3 columns (its elevated cards need breathing room).
    const effCols: Columns = template === 'cards' ? (Math.min(3, columns) as Columns) : columns
    const grid = (
      <Template
        cards={cards}
        media={media}
        toggles={toggles}
        cardStyle={eff.cardStyle}
        spacing={eff.spacing}
        aspect={eff.imageAspect}
        columns={effCols}
        onDark={onDark}
      />
    )

    // ── Pagination (current source + grid/cards/list only) ──────────────────
    // Resolve the effective mode: 'auto' → numbered for the current source
    // (SEO-crawlable default), none for everything else. `eff.pagination` is
    // the settings-authoritative value for the current source (FIX 2), so an
    // explicit settings/block 'numbered'/'load-more'/'none' is honoured and the
    // 'auto' sentinel maps to numbered.
    const effectivePagination = isCurrent
      ? eff.pagination === 'auto'
        ? 'numbered'
        : eff.pagination
      : 'none'

    if (isCurrent && effectivePagination === 'load-more' && postsLoop) {
      body = (
        <PostsLoadMore
          media={media}
          toggles={toggles}
          aspect={eff.imageAspect}
          columns={effCols}
          spacing={eff.spacing}
          onDark={onDark}
          initialPage={postsLoop.page}
          initialHasNext={postsLoop.hasNext}
          // perPage is implicit (blog_settings) on the canonical index; pass it
          // only if the block overrode it. We don't have the resolved perPage
          // here, so let the route fall back to blog_settings (its default).
          category={extractTermFromBasePath(postsLoop.basePath, 'category')}
          tag={extractTermFromBasePath(postsLoop.basePath, 'tag')}
        >
          {grid}
        </PostsLoadMore>
      )
    } else {
      body = (
        <>
          {grid}
          {isCurrent && effectivePagination === 'numbered' && postsLoop && (
            <NumberedPager postsLoop={postsLoop} onDark={onDark} />
          )}
        </>
      )
    }
  }

  const section = (
    <section className={clsx('mx-auto w-full max-w-6xl', outerClass)}>
      <PostsHeading heading={data.heading} onDark={onDark} />
      {body}
      {/* ItemList + per-item BlogPosting structured data (#7). */}
      <PostsItemListJsonLd cards={cards} />
    </section>
  )

  return data.animation === 'none' ? section : <MotionTarget preset={data.animation}>{section}</MotionTarget>
}

// The archive load-more needs the term slug to re-query the right filter. The
// pager basePath is /<seg>/category/<slug> or /<seg>/tag/<slug> on an archive,
// or /<seg> on the plain index. Pull the slug back out for the appender's
// fetch. Plain index → undefined (no filter).
function extractTermFromBasePath(
  basePath: string | undefined,
  kind: 'category' | 'tag',
): string | undefined {
  if (!basePath) return undefined
  const parts = basePath.split('/').filter(Boolean)
  const idx = parts.indexOf(kind)
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]
  return undefined
}
