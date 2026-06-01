'use client'

// Shared Embla carousel primitives for the luxury slider blocks
// (lx_carousel, lx_testimonial_carousel). One hook + two presentational
// subcomponents so each carousel renderer composes its own slides while
// the navigation chrome, autoplay wiring, and prefers-reduced-motion
// handling live in exactly one place.
//
// Embla is headless: it owns the scroll mechanics + a11y-friendly
// keyboard/drag, we own the markup + styling. The viewport is the
// `ref` element; its single child is the flex track; each track child
// is one slide. See https://www.embla-carousel.com/.

import { useCallback, useEffect, useState } from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import Autoplay from 'embla-carousel-autoplay'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export interface EmblaLuxuryOptions {
  loop: boolean
  autoplay: boolean
  intervalMs: number
}

export function useEmblaLuxury({ loop, autoplay, intervalMs }: EmblaLuxuryOptions) {
  // Autoplay plugin is installed at init when requested. prefers-reduced-
  // motion is honoured AFTER mount by stopping the plugin (we can't read
  // matchMedia during SSR, and plugins are fixed at hook-init time).
  const plugins = autoplay
    ? [Autoplay({ delay: intervalMs, stopOnInteraction: false, stopOnMouseEnter: true })]
    : []
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop, align: 'center' }, plugins)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollSnaps, setScrollSnaps] = useState<number[]>([])

  const onSelect = useCallback(() => {
    if (!emblaApi) return
    setSelectedIndex(emblaApi.selectedScrollSnap())
  }, [emblaApi])

  useEffect(() => {
    if (!emblaApi) return
    setScrollSnaps(emblaApi.scrollSnapList())
    onSelect()
    emblaApi.on('select', onSelect).on('reInit', onSelect)
    // prefers-reduced-motion: kill autoplay (decorative motion). Manual
    // navigation still works — the slides are content, not decoration.
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) {
      const ap = emblaApi.plugins() as { autoplay?: { stop?: () => void } }
      ap.autoplay?.stop?.()
    }
    return () => {
      emblaApi.off('select', onSelect).off('reInit', onSelect)
    }
  }, [emblaApi, onSelect])

  const scrollTo = useCallback((i: number) => emblaApi?.scrollTo(i), [emblaApi])
  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi])
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi])

  return { emblaRef, selectedIndex, scrollSnaps, scrollTo, scrollPrev, scrollNext }
}

// Arrow tone — ghost buttons with a translucent backdrop that reads on
// both photo (carousel) and flat (testimonial) grounds.
const ARROW_TONE: Record<string, string> = {
  obsidian: 'bg-obsidian/40 text-ivory hover:bg-obsidian/60 ring-ivory/20',
  ivory: 'bg-ivory/70 text-obsidian hover:bg-ivory ring-obsidian/10',
}

export function CarouselArrows({
  onPrev,
  onNext,
  tone,
}: {
  onPrev: () => void
  onNext: () => void
  tone: string
}) {
  const cls = ARROW_TONE[tone] ?? ARROW_TONE.obsidian
  return (
    <>
      <button
        type="button"
        onClick={onPrev}
        aria-label="Previous slide"
        className={clsx(
          'absolute left-3 top-1/2 z-10 -translate-y-1/2 grid h-11 w-11 place-items-center rounded-full ring-1 backdrop-blur-sm transition-colors',
          cls,
        )}
      >
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onNext}
        aria-label="Next slide"
        className={clsx(
          'absolute right-3 top-1/2 z-10 -translate-y-1/2 grid h-11 w-11 place-items-center rounded-full ring-1 backdrop-blur-sm transition-colors',
          cls,
        )}
      >
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </button>
    </>
  )
}

export function CarouselDots({
  count,
  selected,
  onDot,
}: {
  count: number
  selected: number
  onDot: (i: number) => void
}) {
  if (count <= 1) return null
  return (
    <div className="mt-6 flex items-center justify-center gap-2.5">
      {Array.from({ length: count }).map((_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onDot(i)}
          aria-label={`Go to slide ${i + 1}`}
          aria-current={i === selected ? 'true' : undefined}
          className={clsx(
            'h-2 rounded-full transition-all duration-standard ease-standard',
            i === selected ? 'w-6 bg-champagne' : 'w-2 bg-warm-stone/40 hover:bg-warm-stone/70',
          )}
        />
      ))}
    </div>
  )
}

export const RATIO_CLASS: Record<string, string> = {
  '21:9': 'aspect-[21/9]',
  '16:9': 'aspect-[16/9]',
  '4:3': 'aspect-[4/3]',
  '4:5': 'aspect-[4/5]',
  '1:1': 'aspect-square',
}
