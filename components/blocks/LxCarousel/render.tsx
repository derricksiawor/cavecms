'use client'

import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { MediaImg } from '../MediaImg'
import {
  useEmblaLuxury,
  CarouselArrows,
  CarouselDots,
  RATIO_CLASS,
} from '../_shared/embla'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Luxury image/media carousel — the lx_ successor to Elementor's Image
// Carousel + Slides. Embla owns the swipe/drag/keyboard mechanics; we
// render a full-bleed-capable rounded viewport with champagne dots and
// ghost arrows. Captions sit on a bottom gradient scrim; an optional
// per-slide href makes the whole slide a link.

export function LxCarousel({
  data,
  media,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_carousel'>
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const { emblaRef, selectedIndex, scrollSnaps, scrollTo, scrollPrev, scrollNext } =
    useEmblaLuxury({
      loop: data.loop,
      autoplay: data.autoplay,
      intervalMs: data.intervalMs,
    })

  const ratioClass = RATIO_CLASS[data.ratio] ?? RATIO_CLASS['16:9']

  const composed = (
    <section
      className={clsx('relative mx-auto w-full max-w-5xl px-4 sm:px-0', outerClass)}
      aria-roledescription="carousel"
      aria-label="Image carousel"
    >
      <div className="relative overflow-hidden rounded-2xl">
        <div className="overflow-hidden" ref={emblaRef}>
          <div className="flex">
            {data.slides.map((slide, i) => {
              const img = (
                <div className={clsx('relative w-full', ratioClass)}>
                  <MediaImg
                    media={media.get(slide.image.media_id)}
                    alt={slide.image.alt}
                    variant="lg"
                    priority={i === 0}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  {slide.caption && (
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-obsidian/80 via-obsidian/20 to-transparent px-6 py-5">
                      <p className="font-sans text-sm font-medium italic text-ivory">
                        {slide.caption}
                      </p>
                    </div>
                  )}
                </div>
              )
              return (
                <div
                  key={i}
                  className="min-w-0 flex-[0_0_100%]"
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} of ${data.slides.length}`}
                >
                  {slide.href ? (
                    <a
                      href={slide.href}
                      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-champagne"
                    >
                      {img}
                    </a>
                  ) : (
                    img
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {data.showArrows && data.slides.length > 1 && (
          <CarouselArrows onPrev={scrollPrev} onNext={scrollNext} tone={tone} />
        )}
      </div>
      {data.showDots && (
        <CarouselDots count={scrollSnaps.length} selected={selectedIndex} onDot={scrollTo} />
      )}
    </section>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
