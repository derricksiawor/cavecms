import clsx from 'clsx'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { MediaImg } from '../MediaImg'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'
import { isSectionSurfaceDark, type SectionMeta } from '@/lib/cms/blockMeta'

// Dynamic posts loop (Elementor: Posts / Loop Grid). Two modes — both
// resolved by hydrate.ts (never queried here — same contract as
// lx_featured_projects), so this component stays a PURE SYNCHRONOUS view
// (required: it also renders inside the client editor canvas, where an
// async server component would throw — same constraint as lx_code):
//
//   • recent — the original teaser. Reads RenderContext.posts (the latest
//     published posts, capped 12) and slices to data.limit. Unchanged.
//   • loop   — the paginated blog archive. Reads RenderContext.postsLoop
//     (the keyset-paginated, filtered, bounded page hydrate fetched for the
//     URL ?page=) and renders an accessible prev/next pager.
//
// Text auto-contrasts the ancestor section surface.

const COLS: Record<BlockData<'lx_posts'>['columns'], string> = {
  2: 'grid-cols-1 sm:grid-cols-2 gap-8 sm:gap-10',
  3: 'grid-cols-1 md:grid-cols-3 gap-8 sm:gap-10',
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// Shared card shape for both modes. `readingMinutes` is set only in loop
// mode (hydrate computes it); recent mode passes undefined and the pill is
// omitted regardless of showReadingTime.
interface PostCard {
  id: number
  slug: string
  title: string
  excerpt: string | null
  published_at: Date | string | null
  hero_image_id: number | null
  readingMinutes?: number
  // Permalink-segment-aware detail URL, baked at hydrate (Phase 5) so this
  // synchronous renderer (which also runs in the client editor canvas) never
  // builds a segment-aware URL itself. Recent + loop mode both carry it.
  url: string
  // Loop-mode only: up to 2 categories for the card cross-link pills (#0.592),
  // each with its baked segment-aware archive URL. Recent mode leaves it empty.
  categories?: Array<{ slug: string; name: string; url: string }>
}

// Build the loop pager href off the slice's basePath (the blog index by
// default, or a term archive like /<seg>/category/<slug> when this loop is an
// archive). Phase 5: basePath is baked at hydrate through lib/blog/urls with the
// configured segment, so the pager links are segment-correct here with no async.
// Page 1 → bare base; page >1 → `?page=N`.
function pageHref(base: string, page: number): string {
  return page <= 1 ? base : `${base}?page=${page}`
}

export function LxPosts({
  data,
  posts,
  postsLoop,
  media,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_posts'>
  posts?: RenderContext['posts']
  postsLoop?: RenderContext['postsLoop']
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const onDark = isSectionSurfaceDark(sectionMeta)
  const headingClass = onDark ? 'text-ivory' : 'text-obsidian'
  const titleClass = onDark ? 'text-ivory' : 'text-obsidian'
  const excerptClass = onDark ? 'text-ivory/70' : 'text-warm-stone'
  const metaClass = onDark ? 'text-ivory/60' : 'text-warm-stone'

  const isLoop = data.mode === 'loop'

  // Resolve the card list + pager from the active mode's data source.
  const list: PostCard[] = isLoop
    ? (postsLoop?.items ?? []).map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        excerpt: p.excerpt,
        published_at: p.published_at,
        hero_image_id: p.hero_image_id,
        readingMinutes: p.reading_minutes,
        categories: p.categories,
        url: p.url,
      }))
    : [...(posts?.values() ?? [])].slice(0, data.limit).map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        excerpt: p.excerpt,
        published_at: p.published_at,
        hero_image_id: p.hero_image_id,
        url: p.url,
      }))

  const isList = data.layout === 'list'

  if (list.length === 0) {
    // Loop mode: a real, on-brand empty state — the operator styled this
    // page and a visitor landing on an empty archive (or a category with no
    // posts) should see something intentional, not a blank gap. Recent mode
    // keeps its legacy behaviour of rendering nothing (the home teaser must
    // disappear cleanly when there are no posts yet).
    if (!isLoop) return null
    const empty = (
      <section className={clsx('mx-auto w-full max-w-6xl', outerClass)}>
        {data.heading && (
          <h2 className={clsx('mb-6 font-serif text-3xl font-bold tracking-tight sm:text-4xl', headingClass)}>
            {data.heading}
          </h2>
        )}
        <p className={clsx('font-sans text-base leading-relaxed', excerptClass)}>
          No posts here yet — check back soon.
        </p>
      </section>
    )
    if (data.animation === 'none') return empty
    return <MotionTarget preset={data.animation}>{empty}</MotionTarget>
  }

  const section = (
    <section className={clsx('mx-auto w-full max-w-6xl', outerClass)}>
      {data.heading && (
        <h2 className={clsx('mb-10 font-serif text-3xl font-bold tracking-tight sm:text-4xl', headingClass)}>
          {data.heading}
        </h2>
      )}
      <ul
        className={clsx(
          isList ? 'flex flex-col gap-8' : 'grid',
          !isList && COLS[data.columns],
        )}
      >
        {list.map((p) => {
          const date = data.showDate ? formatDate(p.published_at) : null
          const showReading =
            isLoop && data.showReadingTime && typeof p.readingMinutes === 'number'
          return (
            <li key={p.id}>
              <a
                href={p.url}
                className={clsx('group block', isList && 'flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8')}
              >
                <div className={clsx('overflow-hidden rounded-2xl', isList && 'sm:w-2/5 sm:shrink-0')}>
                  <MediaImg
                    media={p.hero_image_id ? media.get(p.hero_image_id) : undefined}
                    alt={p.title}
                    variant="md"
                    className={clsx(
                      'w-full object-cover transition-transform duration-standard ease-standard group-hover:scale-[1.02]',
                      isList ? 'h-48 sm:h-44' : 'h-56',
                    )}
                  />
                </div>
                <div className={clsx(isList && 'sm:flex-1')}>
                  {(date || showReading) && (
                    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 sm:mt-0">
                      {date && (
                        <time
                          className="block font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne"
                          dateTime={new Date(p.published_at as string | Date).toISOString()}
                        >
                          {date}
                        </time>
                      )}
                      {date && showReading && (
                        <span aria-hidden className={clsx('text-xs', metaClass)}>
                          ·
                        </span>
                      )}
                      {showReading && (
                        <span className={clsx('font-sans text-xs font-medium uppercase tracking-eyebrow', metaClass)}>
                          {p.readingMinutes} min read
                        </span>
                      )}
                    </div>
                  )}
                  <h3 className={clsx('mt-2 font-serif text-xl font-bold tracking-tight sm:text-2xl', titleClass)}>
                    {p.title}
                  </h3>
                  {data.showExcerpt && p.excerpt && (
                    <p className={clsx('mt-2 line-clamp-3 font-sans text-base leading-relaxed', excerptClass)}>
                      {p.excerpt}
                    </p>
                  )}
                </div>
              </a>
              {/* Category cross-link pills — rendered OUTSIDE the card anchor
                  (no nested <a>) so each pill is its own link to the term
                  archive (#0.592). Loop mode only; recent-mode cards omit. */}
              {isLoop && p.categories && p.categories.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {p.categories.map((c) => (
                    <a
                      key={c.slug}
                      href={c.url}
                      className={clsx(
                        'inline-flex w-fit items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-eyebrow ring-1 transition-colors',
                        onDark
                          ? 'bg-ivory/10 text-ivory ring-ivory/20 hover:bg-ivory/15'
                          : 'bg-copper-500/12 text-copper-700 ring-copper-400/30 hover:bg-copper-500/20',
                      )}
                    >
                      {c.name}
                    </a>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {isLoop && postsLoop && (postsLoop.hasPrev || postsLoop.hasNext) && (
        <nav
          aria-label="Blog pagination"
          className="mt-14 flex items-center justify-between gap-4"
        >
          {postsLoop.hasPrev ? (
            <a
              href={pageHref(postsLoop.basePath ?? '/blog', postsLoop.page - 1)}
              rel="prev"
              className={clsx(
                'inline-flex w-fit items-center gap-2 rounded-full px-6 py-3 font-sans text-sm font-semibold tracking-wide transition-colors duration-standard ease-standard min-h-[44px]',
                onDark
                  ? 'bg-ivory/10 text-ivory hover:bg-ivory/15'
                  : 'bg-obsidian/[0.06] text-obsidian hover:bg-obsidian/[0.1]',
              )}
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
              Newer posts
            </a>
          ) : (
            <span />
          )}

          <span className={clsx('font-sans text-xs font-semibold uppercase tracking-eyebrow', metaClass)}>
            Page {postsLoop.page}
          </span>

          {postsLoop.hasNext ? (
            <a
              href={pageHref(postsLoop.basePath ?? '/blog', postsLoop.page + 1)}
              rel="next"
              className={clsx(
                'inline-flex w-fit items-center gap-2 rounded-full px-6 py-3 font-sans text-sm font-semibold tracking-wide transition-colors duration-standard ease-standard min-h-[44px]',
                onDark
                  ? 'bg-champagne text-obsidian hover:bg-champagne/90'
                  : 'bg-obsidian text-ivory hover:bg-obsidian/90',
              )}
            >
              Older posts
              <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  )

  if (data.animation === 'none') return section
  return <MotionTarget preset={data.animation}>{section}</MotionTarget>
}
