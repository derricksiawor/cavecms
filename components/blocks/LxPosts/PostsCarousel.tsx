'use client'

import { useCallback } from 'react'
import clsx from 'clsx'
import {
  useEmblaLuxury,
  CarouselArrows,
  CarouselDots,
} from '../_shared/embla'
import { MediaImg } from '../MediaImg'
import { ArrowRight } from 'lucide-react'
import type { RenderContext, HydratedPostCardCtx } from '..'
import {
  ASPECT_CLASS,
  cardSizes,
  clampClass,
  textTones,
  type ImageAspect,
  type ImageAspect as Aspect,
} from './styles'
import type { PostCardToggles } from './PostCard'

// Carousel template — horizontal swipeable post cards (#1). The ONLY template
// that needs a client component (interactivity). The server passes pre-
// hydrated card data into this shell (data-fetch stays at hydrate; only the
// carousel mechanics are client-side). Reduced-motion: the embla hook stops
// autoplay when the user prefers reduced motion; manual nav + cards stay fully
// usable. Keyboard: ←/→ move slides; each card is a focusable real <a>.
//
// We show ~1 card on mobile, 2 on sm, 3 on lg via per-slide basis so the track
// scrolls a meaningful step. The card visuals mirror the grid card (image-top,
// meta, title, excerpt) so the carousel reads as the same product.

const SLIDE_BASIS = 'flex-[0_0_88%] sm:flex-[0_0_48%] lg:flex-[0_0_32%]'

function fmtDate(value: Date | string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function PostsCarousel({
  cards,
  media,
  toggles,
  aspect,
  onDark,
  autoplay,
  intervalMs,
  loop,
  showArrows,
  showDots,
}: {
  cards: HydratedPostCardCtx[]
  media: RenderContext['media']
  toggles: PostCardToggles
  aspect: ImageAspect
  onDark: boolean
  autoplay: boolean
  intervalMs: number
  loop: boolean
  showArrows: boolean
  showDots: boolean
}) {
  const { emblaRef, selectedIndex, scrollSnaps, scrollTo, scrollPrev, scrollNext } =
    useEmblaLuxury({ loop, autoplay, intervalMs })
  const tones = textTones(onDark)

  // Keyboard nav on the viewport — ←/→ step the carousel. (Cards themselves
  // are focusable links; this adds carousel-level arrow control.)
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        scrollPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        scrollNext()
      }
    },
    [scrollPrev, scrollNext],
  )

  return (
    <section
      className="relative mx-auto w-full max-w-6xl"
      aria-roledescription="carousel"
      aria-label="Posts carousel"
    >
      <div className="relative">
        <div
          className="overflow-hidden"
          ref={emblaRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          role="group"
          aria-label="Use the left and right arrow keys to browse posts"
        >
          <div className="flex gap-6">
            {cards.map((c, i) => {
              const m = c.hero_image_id ? media.get(c.hero_image_id) : undefined
              const date = toggles.showDate ? fmtDate(c.published_at) : null
              return (
                <div
                  key={c.id}
                  className={clsx('min-w-0', SLIDE_BASIS)}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} of ${cards.length}`}
                >
                  <div className="group flex h-full flex-col">
                    <a
                      href={c.url}
                      className={clsx(
                        'block h-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-champagne focus-visible:ring-offset-2',
                        onDark ? 'focus-visible:ring-offset-obsidian' : 'focus-visible:ring-offset-cream-50',
                      )}
                    >
                      {toggles.showImage && (
                        <div className={clsx('relative w-full overflow-hidden rounded-2xl', ASPECT_CLASS[aspect as Aspect])}>
                          {m && m.variants ? (
                            <MediaImg
                              media={m}
                              alt={c.title}
                              variant="md"
                              sizes={cardSizes(3)}
                              className="absolute inset-0 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-standard motion-safe:ease-standard motion-safe:group-hover:scale-[1.03]"
                            />
                          ) : (
                            <div className={clsx('absolute inset-0 grid place-items-center', tones.fallback)} aria-hidden>
                              <span className="font-serif text-5xl font-bold">
                                {(c.title.trim().charAt(0) || '·').toUpperCase()}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="pt-4">
                        {date && (
                          <time
                            className="font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne"
                            dateTime={new Date(c.published_at as string | Date).toISOString()}
                          >
                            {date}
                          </time>
                        )}
                        <h3 className={clsx('mt-2 font-serif text-xl font-bold tracking-tight sm:text-2xl', tones.title, clampClass(toggles.titleClamp))}>
                          {c.title}
                        </h3>
                        {toggles.showExcerpt && c.excerpt && (
                          <p className={clsx('mt-2 font-sans text-base leading-relaxed', tones.excerpt, clampClass(toggles.excerptClamp))}>
                            {c.excerpt}
                          </p>
                        )}
                        {toggles.showReadMore && (
                          <span className="mt-4 inline-flex w-fit items-center gap-1.5 font-sans text-sm font-semibold tracking-wide text-champagne" aria-hidden>
                            {toggles.readMoreLabel?.trim() || 'Read more'}
                            <ArrowRight className="h-4 w-4 motion-safe:transition-transform motion-safe:group-hover:translate-x-1" strokeWidth={2} />
                          </span>
                        )}
                      </div>
                    </a>
                    {toggles.showCategory && c.categories.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {c.categories.map((cat) => (
                          <a
                            key={cat.slug}
                            href={cat.url}
                            className={clsx(
                              'inline-flex w-fit items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-eyebrow ring-1 transition-colors',
                              tones.pill,
                            )}
                          >
                            {cat.name}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {showArrows && cards.length > 1 && (
          <CarouselArrows onPrev={scrollPrev} onNext={scrollNext} tone={onDark ? 'ivory' : 'obsidian'} />
        )}
      </div>
      {showDots && (
        <CarouselDots count={scrollSnaps.length} selected={selectedIndex} onDot={scrollTo} />
      )}
    </section>
  )
}
