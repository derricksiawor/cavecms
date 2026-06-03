import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { MediaImg } from '../MediaImg'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Timeline ("even better than Elementor") — a vertical sequence of dated
// events on a champagne rail with nodes. Server component.

const TONE_TITLE: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_BODY: Record<string, string> = { obsidian: 'text-warm-stone', ivory: 'text-ivory/70' }

export function LxTimeline({
  data,
  media,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_timeline'>
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const titleClass = isToken ? TONE_TITLE[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const custom = !isToken ? resolveColorValue(tone) : undefined

  const composed = (
    <ol className={clsx('relative mx-auto w-full max-w-2xl', outerClass)}>
      {data.events.map((ev, i) => {
        const isLast = i === data.events.length - 1
        return (
          <li key={i} className="relative flex gap-6 pb-10 last:pb-0">
            {/* rail + node */}
            <div className="relative flex flex-col items-center">
              <span className="relative z-10 mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full bg-champagne ring-4 ring-champagne/20" />
              {!isLast && (
                <span aria-hidden="true" className="absolute top-1.5 h-full w-px bg-warm-stone/20" />
              )}
            </div>
            <div className="flex-1 pb-1">
              <span className="font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne">
                {ev.date}
              </span>
              <h3
                className={clsx('mt-1 font-serif text-xl font-bold tracking-tight', titleClass)}
                style={custom ? { color: custom } : undefined}
              >
                {ev.title}
              </h3>
              {ev.body && (
                <p className={clsx('mt-2 font-sans text-base leading-relaxed', bodyClass)}>
                  {ev.body}
                </p>
              )}
              {ev.image && (
                <MediaImg
                  media={media.get(ev.image.media_id)}
                  alt={ev.image.alt}
                  variant="md"
                  className="mt-4 w-full rounded-xl object-cover"
                />
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
