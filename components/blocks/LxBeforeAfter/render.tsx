'use client'

import { useState } from 'react'
import clsx from 'clsx'
import { MoveHorizontal } from 'lucide-react'
import { MediaImg } from '../MediaImg'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'

// Before/after image comparison slider ("even better than Elementor").
// The reveal is driven by a real <input type="range"> so it is fully
// keyboard-operable + screen-reader labeled; the "after" image is
// clipped by clip-path inset tied to the range value.

const RATIO_CLASS: Record<BlockData<'lx_before_after'>['ratio'], string> = {
  '16:9': 'aspect-[16/9]',
  '4:3': 'aspect-[4/3]',
  '3:2': 'aspect-[3/2]',
  '1:1': 'aspect-square',
}

export function LxBeforeAfter({
  data,
  media,
  outerClass,
}: {
  data: BlockData<'lx_before_after'>
  media: RenderContext['media']
  outerClass?: string
}) {
  const [pos, setPos] = useState(50)

  return (
    <div className={clsx('mx-auto w-full max-w-4xl', outerClass)}>
      <div className={clsx('relative overflow-hidden rounded-2xl select-none', RATIO_CLASS[data.ratio])}>
        {/* before (full) */}
        <MediaImg
          media={media.get(data.before.media_id)}
          alt={data.before.alt}
          variant="lg"
          className="absolute inset-0 h-full w-full object-cover"
        />
        {data.beforeLabel && (
          <span className="absolute left-4 top-4 rounded-full bg-obsidian/70 px-3 py-1 font-sans text-xs font-semibold uppercase tracking-eyebrow text-ivory backdrop-blur-sm">
            {data.beforeLabel}
          </span>
        )}
        {/* after (clipped to the right of the handle) */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
          <MediaImg
            media={media.get(data.after.media_id)}
            alt={data.after.alt}
            variant="lg"
            className="absolute inset-0 h-full w-full object-cover"
          />
          {data.afterLabel && (
            <span className="absolute right-4 top-4 rounded-full bg-obsidian/70 px-3 py-1 font-sans text-xs font-semibold uppercase tracking-eyebrow text-ivory backdrop-blur-sm">
              {data.afterLabel}
            </span>
          )}
        </div>
        {/* handle line + grip */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-champagne"
          style={{ left: `${pos}%` }}
        >
          <span className="absolute top-1/2 left-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-champagne text-obsidian shadow-lg">
            <MoveHorizontal className="h-5 w-5" strokeWidth={2} />
          </span>
        </div>
        {/* the range input overlays the whole image, transparent */}
        <input
          type="range"
          min={0}
          max={100}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Reveal the after image"
          className="absolute inset-0 z-20 h-full w-full cursor-ew-resize opacity-0"
        />
      </div>
    </div>
  )
}
