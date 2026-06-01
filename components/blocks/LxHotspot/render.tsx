'use client'

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Plus } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { MediaImg } from '../MediaImg'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'

// Image hotspots (Elementor: Hotspot). Positioned markers over an image,
// each opening an accessible popover (button + aria-expanded, Esc to
// close, one open at a time).

const RATIO_CLASS: Record<BlockData<'lx_hotspot'>['ratio'], string> = {
  '21:9': 'aspect-[21/9]',
  '16:9': 'aspect-[16/9]',
  '4:3': 'aspect-[4/3]',
  '1:1': 'aspect-square',
  auto: '',
}

export function LxHotspot({
  data,
  media,
  outerClass,
}: {
  data: BlockData<'lx_hotspot'>
  media: RenderContext['media']
  outerClass?: string
}) {
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const composed = (
    <figure className={clsx('relative mx-auto w-full max-w-4xl overflow-hidden rounded-2xl', outerClass)}>
      <MediaImg
        media={media.get(data.image.media_id)}
        alt={data.image.alt}
        variant="lg"
        className={clsx('w-full object-cover', RATIO_CLASS[data.ratio])}
      />
      {data.markers.map((m, i) => {
        const isOpen = open === i
        return (
          <div
            key={i}
            className="absolute"
            style={{ left: `${m.x}%`, top: `${m.y}%`, transform: 'translate(-50%, -50%)' }}
          >
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={m.label}
              onClick={() => setOpen(isOpen ? null : i)}
              className={clsx(
                'grid h-8 w-8 place-items-center rounded-full bg-champagne text-obsidian shadow-lg ring-4 ring-champagne/30 transition-transform hover:scale-110',
                !isOpen && 'motion-safe:animate-cavecms-pulse-copper',
              )}
            >
              <Plus className={clsx('h-4 w-4 transition-transform', isOpen && 'rotate-45')} strokeWidth={2.5} aria-hidden="true" />
            </button>
            {isOpen && (
              <div
                role="tooltip"
                className="absolute left-1/2 top-10 z-10 w-56 -translate-x-1/2 rounded-xl bg-obsidian/95 px-4 py-3 text-left shadow-xl ring-1 ring-champagne/20 backdrop-blur-sm animate-cavecms-fade-in"
              >
                <p className="font-serif text-sm font-semibold tracking-tight text-ivory">{m.label}</p>
                {m.body && <p className="mt-1 font-sans text-xs leading-relaxed text-ivory/75">{m.body}</p>}
              </div>
            )}
          </div>
        )
      })}
    </figure>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
