'use client'

import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { MediaImg } from '../MediaImg'
import { useEmblaLuxury, CarouselArrows, CarouselDots } from '../_shared/embla'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Luxury testimonial carousel — Elementor's Testimonial Carousel as a
// single centered pull-quote per slide (Fraunces italic), with an
// optional portrait + attribution. Shares the Embla engine with
// lx_carousel; navigation chrome is the same champagne dots + ghost
// arrows.

const TONE_QUOTE: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}
const TONE_ATTR: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/70',
}

export function LxTestimonialCarousel({
  data,
  media,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_testimonial_carousel'>
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const { emblaRef, selectedIndex, scrollSnaps, scrollTo, scrollPrev, scrollNext } =
    useEmblaLuxury({
      loop: data.loop,
      autoplay: data.autoplay,
      intervalMs: data.intervalMs,
    })

  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const quoteClass = isToken ? TONE_QUOTE[tone] : undefined
  const attrClass = isToken ? TONE_ATTR[tone] : undefined
  const customColor = !isToken ? resolveColorValue(tone) : undefined

  const composed = (
    <section
      className={clsx('relative mx-auto w-full max-w-3xl px-12 sm:px-14', outerClass)}
      aria-roledescription="carousel"
      aria-label="Testimonials"
    >
      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex">
          {data.items.map((t, i) => (
            <figure
              key={i}
              className="min-w-0 flex-[0_0_100%] px-2 text-center"
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${data.items.length}`}
            >
              {t.portrait && (
                <MediaImg
                  media={media.get(t.portrait.media_id)}
                  alt={t.portrait.alt}
                  variant="thumb"
                  className="mx-auto mb-6 h-16 w-16 rounded-full object-cover ring-1 ring-champagne/40"
                />
              )}
              <blockquote
                className={clsx(
                  'font-serif text-2xl italic leading-relaxed tracking-tight sm:text-3xl',
                  quoteClass,
                )}
                style={customColor ? { color: customColor } : undefined}
              >
                &ldquo;{t.quote}&rdquo;
              </blockquote>
              <figcaption className="mt-6">
                <span
                  className={clsx(
                    'block font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne',
                  )}
                >
                  {t.attribution}
                </span>
                {t.attribution_title && (
                  <span
                    className={clsx('mt-1 block font-sans text-sm', attrClass)}
                    style={customColor ? { color: customColor, opacity: 0.7 } : undefined}
                  >
                    {t.attribution_title}
                  </span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
      {data.showArrows && data.items.length > 1 && (
        <CarouselArrows onPrev={scrollPrev} onNext={scrollNext} tone={tone} />
      )}
      {data.showDots && (
        <CarouselDots count={scrollSnaps.length} selected={selectedIndex} onDot={scrollTo} />
      )}
    </section>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
