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
}: {
  data: BlockData<'lx_posts'>
  postsLoop?: RenderContext['postsLoop']
  postCards?: HydratedPostCardCtx[]
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const onDark = isSectionSurfaceDark(sectionMeta)
  const isCurrent = data.source === 'current'

  // Resolve the card list from the active source.
  const cards: HydratedPostCardCtx[] = isCurrent
    ? (postsLoop?.items ?? []).map(loopItemToCard)
    : postCards ?? []

  // ── Card content toggles (the block's values; defaults from schema, which
  //    for the current source were overwritten with blog_settings at hydrate) ─
  const toggles: PostCardToggles = {
    showImage: data.showImage,
    showDate: data.showDate,
    showAuthor: data.showAuthor,
    showCategory: data.showCategory,
    showExcerpt: data.showExcerpt,
    showReadingTime: data.showReadingTime,
    showReadMore: data.showReadMore,
    readMoreLabel: data.readMoreLabel,
    titleClamp: data.titleClamp,
    excerptClamp: data.excerptClamp,
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
        <PostsEmptyState heading={data.heading} onDark={onDark} template={data.template} />
      </section>
    )
    return data.animation === 'none' ? empty : <MotionTarget preset={data.animation}>{empty}</MotionTarget>
  }

  const columns = data.columns as Columns
  const template: PostsTemplate = data.template

  // ── Body — the chosen template ───────────────────────────────────────────
  let body: React.ReactNode
  if (template === 'carousel') {
    body = (
      <PostsCarousel
        cards={cards}
        media={media}
        toggles={toggles}
        aspect={data.imageAspect}
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
        cardStyle={data.cardStyle}
        spacing={data.spacing}
        aspect={data.imageAspect}
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
        cardStyle={data.cardStyle}
        spacing={data.spacing}
        aspect={data.imageAspect}
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
        cardStyle={data.cardStyle}
        spacing={data.spacing}
        aspect={data.imageAspect}
        columns={effCols}
        onDark={onDark}
      />
    )

    // ── Pagination (current source + grid/cards/list only) ──────────────────
    // Resolve the effective mode: 'auto' → numbered for the current source
    // (SEO-crawlable default), none for everything else.
    const effectivePagination = isCurrent
      ? data.pagination === 'auto'
        ? 'numbered'
        : data.pagination
      : 'none'

    if (isCurrent && effectivePagination === 'load-more' && postsLoop) {
      body = (
        <PostsLoadMore
          media={media}
          toggles={toggles}
          aspect={data.imageAspect}
          columns={effCols}
          spacing={data.spacing}
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
