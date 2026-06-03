'use client'

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Progress bars / skill meters (Elementor: Progress Bar). Each bar fills
// from 0 → value% when it scrolls into view (IntersectionObserver);
// prefers-reduced-motion fills instantly. Each bar carries
// role="progressbar" with aria-valuenow/min/max.

const TONE_LABEL: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_TRACK: Record<string, string> = {
  obsidian: 'bg-obsidian/10',
  ivory: 'bg-ivory/15',
}

export function LxProgress({
  data,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_progress'>
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setRevealed(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setRevealed(true)
          io.disconnect()
        }
      },
      { threshold: 0.3 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const labelClass = isToken ? TONE_LABEL[tone] : undefined
  const trackClass = isToken ? TONE_TRACK[tone] : 'bg-warm-stone/15'
  const custom = !isToken ? resolveColorValue(tone) : undefined

  return (
    <div ref={ref} className={clsx('mx-auto flex w-full max-w-2xl flex-col gap-5', outerClass)}>
      {data.items.map((item, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span
              className={clsx('font-sans text-sm font-medium', labelClass)}
              style={custom ? { color: custom } : undefined}
            >
              {item.label}
            </span>
            {data.showValue && (
              <span className="font-sans text-sm font-semibold tabular-nums text-champagne">
                {item.value}%
              </span>
            )}
          </div>
          <div
            className={clsx('h-2 w-full overflow-hidden rounded-full', trackClass)}
            role="progressbar"
            aria-valuenow={item.value}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={item.label}
          >
            <div
              className="h-full rounded-full bg-champagne transition-[width] duration-elegant ease-standard motion-reduce:transition-none"
              style={{ width: `${revealed ? item.value : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
