import clsx from 'clsx'
import { Quote as QuoteIcon } from 'lucide-react'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { RenderContext } from '..'
import {
  resolveFamilyRender,
  fontWeightClass,
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury testimonial — portrait + pull-quote + attribution (name +
// optional title). The premium cousin of lx_quote: same restraint,
// with a portrait square anchoring the human voice. Portrait-less
// composition is supported (renders without the avatar column, the
// quote takes the full width).

const ALIGN_CLASS: Record<BlockData<'lx_testimonial'>['alignment'], string> = {
  left: 'text-left items-start',
  center: 'text-center items-center mx-auto',
}

const TONE_QUOTE: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

const TONE_ATTRIB: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/70',
}

export function LxTestimonial({
  data,
  media,
  outerClass,
}: {
  data: BlockData<'lx_testimonial'>
  media: RenderContext['media']
  outerClass?: string
  inlineEdit?: InlineEditContext
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const quoteTone = isToken ? TONE_QUOTE[tone] : undefined
  const attribTone = isToken ? TONE_ATTRIB[tone] : undefined
  const toneStyle = !isToken ? { color: resolveColorValue(tone) } : undefined

  const fam = resolveFamilyRender(data.family)
  const familyClass = fam.className ?? 'font-serif'
  const overrideWeight = data.weight
  const weightClass = overrideWeight ? fontWeightClass(overrideWeight) : 'font-semibold'

  const portraitEntry = data.portrait ? media.get(data.portrait.media_id) : null
  const hasPortrait = !!portraitEntry?.variants

  const body = (
    <div
      className={clsx(
        'flex flex-col gap-6',
        ALIGN_CLASS[data.alignment],
      )}
    >
      <div className="relative inline-flex h-12 w-12 items-center justify-center">
        <div aria-hidden="true" className="lx-glow-champagne-icon absolute inset-0" />
        <QuoteIcon className="relative h-10 w-10 text-champagne" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <blockquote
        className={clsx(
          familyClass,
          weightClass,
          'tracking-tight leading-snug max-w-2xl',
          'text-2xl sm:text-3xl md:text-4xl',
          quoteTone,
        )}
        style={{ ...toneStyle, ...fam.style }}
      >
        {data.quote}
      </blockquote>
      <div
        className={clsx(
          'font-sans text-xs font-semibold uppercase tracking-eyebrow',
          attribTone,
        )}
        style={
          !isToken && resolveColorValue(tone)
            ? { color: resolveColorValue(tone), opacity: 0.7 }
            : undefined
        }
      >
        <div>— {data.attribution}</div>
        {data.attribution_title && (
          <div className="mt-1 text-warm-stone font-normal normal-case tracking-normal text-sm">
            {data.attribution_title}
          </div>
        )}
      </div>
    </div>
  )

  const composed = hasPortrait && portraitEntry ? (
    <div className="flex flex-col md:flex-row gap-8 md:gap-12 items-start">
      <div className="relative w-32 h-32 sm:w-40 sm:h-40 md:w-48 md:h-48 shrink-0 overflow-hidden">
        <MediaImg
          media={portraitEntry}
          alt={data.portrait!.alt}
          variant="md"
          className="h-full w-full object-cover"
        />
      </div>
      <div className="flex-1">{body}</div>
    </div>
  ) : (
    body
  )

  const wrapped = (
    <div className={clsx(outerClass)}>
      {composed}
    </div>
  )

  if (data.animation === 'none') return wrapped
  return <MotionTarget preset={data.animation}>{wrapped}</MotionTarget>
}
