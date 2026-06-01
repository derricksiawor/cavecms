'use client'

import { useState } from 'react'
import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import { MediaImg } from '../MediaImg'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'

// Flip box (Elementor: Flip Box). A card that flips to reveal a back
// face with copy + an optional CTA.
//
// Accessibility model (the front toggle and the back link live in
// SEPARATE faces — siblings, never nested, so no interactive-in-
// interactive violation):
//   • hover mode — flips on pointer enter/leave AND on focus entering
//     the card (keyboard parity). The front toggle is NOT in the tab
//     order; keyboard users Tab straight to the back CTA, whose focus
//     flips the card into view (no focus-loss jank). Touch/click users
//     can also tap the front toggle.
//   • tap mode — the front toggle button flips on click / Enter; the
//     back CTA enters the tab order only once flipped.
// prefers-reduced-motion snaps instantly (motion-reduce:transition-none).

const HEIGHT: Record<BlockData<'lx_flip_box'>['height'], string> = {
  sm: 'h-64',
  md: 'h-80',
  lg: 'h-96',
}

export function LxFlipBox({
  data,
  media,
  outerClass,
}: {
  data: BlockData<'lx_flip_box'>
  media: RenderContext['media']
  outerClass?: string
}) {
  const [flipped, setFlipped] = useState(false)
  const isHover = data.trigger === 'hover'
  const hasCta = !!(data.backCtaLabel && data.backCtaHref)

  const flipHandlers = isHover
    ? {
        onMouseEnter: () => setFlipped(true),
        onMouseLeave: () => setFlipped(false),
        onFocus: () => setFlipped(true),
        onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFlipped(false)
        },
      }
    : {}

  const composed = (
    <div className={clsx('mx-auto w-full max-w-sm', outerClass)} style={{ perspective: '1200px' }}>
      <div className={clsx('group relative', HEIGHT[data.height])} {...flipHandlers}>
        <div
          className="relative h-full w-full transition-transform duration-700 ease-standard motion-reduce:transition-none"
          style={{
            transformStyle: 'preserve-3d',
            transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
          }}
        >
          {/* Front */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl bg-obsidian px-8 py-10 text-center"
            style={{ backfaceVisibility: 'hidden' }}
          >
            {data.frontImage ? (
              <MediaImg
                media={media.get(data.frontImage.media_id)}
                alt={data.frontImage.alt}
                variant="md"
                className="absolute inset-0 h-full w-full object-cover opacity-40"
              />
            ) : (
              <div aria-hidden="true" className="lx-glow-champagne absolute inset-0 opacity-50" />
            )}
            <div className="relative flex flex-col items-center gap-3">
              {data.frontIcon && (
                <IconByName name={data.frontIcon} className="h-9 w-9 text-champagne" strokeWidth={1.5} aria-hidden="true" />
              )}
              <h3 className="font-serif text-2xl font-bold tracking-tight text-ivory">
                {data.frontHeadline}
              </h3>
              {data.frontBody && (
                <p className="font-sans text-sm leading-relaxed text-ivory/75">{data.frontBody}</p>
              )}
            </div>
            {/* Full-face flip toggle (transparent overlay). */}
            <button
              type="button"
              aria-label={flipped ? 'Show front' : 'Show details'}
              aria-pressed={flipped}
              aria-hidden={isHover || flipped}
              tabIndex={isHover || flipped ? -1 : 0}
              onClick={() => setFlipped((f) => !f)}
              className={clsx(
                'absolute inset-0 z-10 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-champagne',
                flipped && 'pointer-events-none',
              )}
            />
          </div>
          {/* Back */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-2xl bg-champagne px-8 py-10 text-center"
            style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
          >
            {/* Tap mode: a full-face flip-BACK toggle so the back face is
                never a dead end (works even when there's no CTA). Sits
                BELOW the CTA in z-order (z-0 vs the CTA's z-10) so the CTA
                stays clickable; covers the non-interactive headline/body
                so tapping anywhere else returns to the front. */}
            {!isHover && (
              <button
                type="button"
                aria-label="Show front"
                aria-hidden={!flipped}
                tabIndex={flipped ? 0 : -1}
                onClick={() => setFlipped(false)}
                className={clsx(
                  'absolute inset-0 z-0 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-obsidian',
                  !flipped && 'pointer-events-none',
                )}
              />
            )}
            <h3 className="font-serif text-2xl font-bold tracking-tight text-obsidian">
              {data.backHeadline}
            </h3>
            {data.backBody && (
              <p className="font-sans text-sm leading-relaxed text-obsidian/80">{data.backBody}</p>
            )}
            {hasCta && (
              <a
                href={data.backCtaHref}
                tabIndex={isHover ? 0 : flipped ? 0 : -1}
                aria-hidden={!isHover && !flipped}
                className={clsx(
                  'relative z-10 mt-2 inline-flex items-center gap-2 rounded-full bg-obsidian px-6 py-2.5 font-sans text-xs font-semibold uppercase tracking-[0.18em] text-ivory transition-colors hover:bg-near-black focus:outline-none focus-visible:ring-2 focus-visible:ring-obsidian',
                  !flipped && 'pointer-events-none',
                )}
              >
                {data.backCtaLabel}
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
