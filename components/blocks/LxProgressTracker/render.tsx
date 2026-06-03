import clsx from 'clsx'
import { Check } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Luxury progress tracker / stepper (Elementor: Progress Tracker) — an
// ordered list of steps with done / current / upcoming states, laid
// vertical or horizontal. Champagne nodes for done/current, muted for
// upcoming. Server component.

type Step = BlockData<'lx_progress_tracker'>['steps'][number]

const TONE_TITLE: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_DESC: Record<string, string> = { obsidian: 'text-warm-stone', ivory: 'text-ivory/65' }

function nodeClasses(state: Step['state']): string {
  switch (state) {
    case 'done':
      return 'bg-champagne text-obsidian border-champagne'
    case 'current':
      return 'bg-transparent text-champagne border-champagne ring-4 ring-champagne/20'
    case 'upcoming':
      return 'bg-transparent text-warm-stone/60 border-warm-stone/30'
  }
}

export function LxProgressTracker({
  data,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_progress_tracker'>
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const titleClass = isToken ? TONE_TITLE[tone] : undefined
  const descClass = isToken ? TONE_DESC[tone] : undefined
  const custom = !isToken ? resolveColorValue(tone) : undefined
  const horizontal = data.orientation === 'horizontal'

  const composed = (
    <ol
      className={clsx(
        'mx-auto w-full',
        horizontal
          ? 'flex max-w-5xl flex-col gap-8 sm:flex-row sm:gap-4'
          : 'flex max-w-2xl flex-col',
        outerClass,
      )}
    >
      {data.steps.map((step, i) => {
        const isLast = i === data.steps.length - 1
        return (
          <li
            key={i}
            className={clsx(
              'relative flex',
              horizontal ? 'flex-1 flex-col items-center text-center' : 'gap-4 pb-8 last:pb-0',
            )}
          >
            {/* connector */}
            {!isLast && (
              <span
                aria-hidden="true"
                className={clsx(
                  step.state === 'done' ? 'bg-champagne/60' : 'bg-warm-stone/20',
                  horizontal
                    ? 'absolute left-1/2 top-5 hidden h-px w-full sm:block'
                    : 'absolute left-5 top-11 h-[calc(100%-1.5rem)] w-px',
                )}
              />
            )}
            <span
              className={clsx(
                'relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border font-sans text-sm font-semibold',
                nodeClasses(step.state),
              )}
            >
              {step.state === 'done' ? (
                <Check className="h-5 w-5" strokeWidth={2.5} aria-hidden="true" />
              ) : (
                i + 1
              )}
            </span>
            <div className={clsx(horizontal ? 'mt-3' : 'pt-1.5')}>
              <p
                className={clsx('font-serif text-base font-semibold tracking-tight', titleClass)}
                style={custom ? { color: custom } : undefined}
              >
                {step.title}
              </p>
              {step.description && (
                <p className={clsx('mt-1 font-sans text-sm leading-relaxed', descClass)}>
                  {step.description}
                </p>
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
