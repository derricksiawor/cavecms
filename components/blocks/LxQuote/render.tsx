import clsx from 'clsx'
import { Quote as QuoteIcon } from 'lucide-react'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  resolveFamilyRender,
  fontWeightClass,
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury closing quote — bold Montserrat, large display size, no
// italics (per ~/.claude/CLAUDE.md the body of the aesthetic is bold
// sans, not editorial serif). A LARGE champagne-tinted lucide quote
// icon sits above the quote on a glow backdrop — replaces the prior
// Unicode " glyph with a proper glowing icon per the
// "Large icons with glow effects" directive.

const ALIGN_CLASS: Record<BlockData<'lx_quote'>['alignment'], string> = {
  left: 'text-left items-start',
  center: 'text-center items-center mx-auto',
}

const TONE_QUOTE_CLASS: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

const TONE_ATTRIBUTION_CLASS: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/70',
}

export function LxQuote({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_quote'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const quoteToneClass = isToken ? TONE_QUOTE_CLASS[tone] : undefined
  const attribToneClass = isToken ? TONE_ATTRIBUTION_CLASS[tone] : undefined
  const toneStyle = !isToken ? { color: resolveColorValue(tone) } : undefined

  const fam = resolveFamilyRender(data.family)
  const familyClass = fam.className ?? 'font-sans'
  const overrideWeight = data.weight
  const weightClass = overrideWeight ? fontWeightClass(overrideWeight) : 'font-bold'

  const quoteClass = clsx(
    familyClass,
    weightClass,
    'tracking-tight leading-tight',
    'text-3xl sm:text-4xl md:text-5xl',
    quoteToneClass,
  )

  const quoteElement = inlineEdit ? (
    <InlineEditable
      blockId={inlineEdit.blockId}
      blockVersion={inlineEdit.blockVersion}
      pageId={inlineEdit.pageId}
      pageVersion={inlineEdit.pageVersion}
      initialData={data}
      field="quote"
      kind="plain"
      initialValue={data.quote}
      as="blockquote"
      className={quoteClass}
      style={{ ...toneStyle, ...fam.style }}
      placeholder="A closing thought…"
    />
  ) : (
    <blockquote className={quoteClass} style={{ ...toneStyle, ...fam.style }}>
      {data.quote}
    </blockquote>
  )

  const animatedQuote =
    inlineEdit || data.animation === 'none' ? (
      quoteElement
    ) : (
      <MotionTarget preset={data.animation}>{quoteElement}</MotionTarget>
    )

  return (
    <div
      className={clsx(
        'flex flex-col gap-8',
        ALIGN_CLASS[data.alignment],
        outerClass,
      )}
    >
      {/* Large glowing quote-icon glyph — sits above the quote
         with a champagne halo. */}
      <div className="relative inline-flex h-14 w-14 items-center justify-center">
        <div
          aria-hidden="true"
          className="lx-glow-champagne-icon absolute inset-0"
        />
        <QuoteIcon
          className="relative h-12 w-12 text-champagne"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </div>
      {animatedQuote}
      {inlineEdit ? (
        <p
          className={clsx(
            'font-sans text-xs font-semibold uppercase tracking-eyebrow',
            attribToneClass,
          )}
          style={
            !isToken && resolveColorValue(tone)
              ? { color: resolveColorValue(tone), opacity: 0.7 }
              : undefined
          }
        >
          <span aria-hidden="true">— </span>
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="attribution"
            kind="plain"
            initialValue={data.attribution ?? ''}
            as="span"
            placeholder="Attribution"
          />
        </p>
      ) : (
        data.attribution && (
          <p
            className={clsx(
              'font-sans text-xs font-semibold uppercase tracking-eyebrow',
              attribToneClass,
            )}
            // For custom-hex tones, fade attribution by 70% via inline
            // style. Tailwind utility paths (text-warm-stone, text-ivory/70)
            // already encode the fade for the two known tokens.
            style={
              !isToken && resolveColorValue(tone)
                ? { color: resolveColorValue(tone), opacity: 0.7 }
                : undefined
            }
          >
            — {data.attribution}
          </p>
        )
      )}
    </div>
  )
}
