import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  fontWeightClass,
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'
import { gradientTextStyle } from '@/lib/cms/gradient'

// Luxury eyebrow — rendered as a BADGE per ~/.claude/CLAUDE.md
// "Badges instead of brackets for labels." Pill-shaped tag with a
// translucent champagne fill (bg-champagne/10) — NO borders, no
// rules. The badge sits above headings as a section kicker.
//
// `prefix` field on the schema is retained for back-compat but
// rendered identically across values; the no-borders constraint
// removes the meaning of the old rule-prefix variant.
//
// Tone controls the badge's tint + text colour. Default champagne
// (signature gold tint on obsidian surfaces); ivory variant for
// champagne-tinted backgrounds.

const TONE_TOKEN_CLASS: Record<string, { bg: string; text: string }> = {
  champagne: { bg: 'bg-champagne/15', text: 'text-champagne' },
  obsidian:  { bg: 'bg-obsidian/10',  text: 'text-obsidian' },
  ivory:     { bg: 'bg-ivory/10',     text: 'text-ivory' },
  'warm-stone': { bg: 'bg-warm-stone/15', text: 'text-warm-stone' },
}

const ALIGN_FLEX: Record<BlockData<'lx_eyebrow'>['alignment'], string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}

// `text-center md:text-left` — on mobile, badges that wrap (long
// labels like "EXTRAORDINARY ACCOMMODATIONS") center their wrapped
// lines so the inner content reads balanced inside the pill. On
// md+ the wrap rarely happens and the operator's saved alignment
// (passed via the outer flex-justify) drives placement.
const BADGE_BASE =
  'inline-flex items-center px-4 py-1.5 rounded-full font-sans text-xs uppercase tracking-eyebrow text-center md:text-left'

// 'plain' variant — a quiet inline label: no pill, no tint, rendered as
// typed (no forced uppercase). Just the tone colour + a touch of tracking.
const PLAIN_BASE = 'inline-block font-sans text-sm tracking-wide'

export function LxEyebrow({
  data,
  inlineEdit,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_eyebrow'>
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const toneValue = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(toneValue)
  const tonePalette = isToken ? TONE_TOKEN_CLASS[toneValue] : null
  const resolved = !isToken ? resolveColorValue(toneValue) : undefined

  // Plain variant = no pill tint, just the tone colour as text.
  const isPlain = data.variant === 'plain'

  // Gradient label (optional) — paints the eyebrow text with a gradient
  // and drops the pill tint (a gradient clipped to text reads cleanest as
  // a bare label, not inside a tinted pill).
  const hasGradient = !!data.textGradient
  const gradStyle = gradientTextStyle(data.textGradient)

  // Custom hex tone: badge bg is a 15%-alpha tint + solid text; plain uses
  // the tone as text colour only (no tint). Tailwind can't express
  // arbitrary hex alpha as a utility, so hex tones fall back to inline style.
  const customStyle = hasGradient
    ? gradStyle
    : resolved
      ? isPlain
        ? { color: resolved }
        : {
            backgroundColor: `color-mix(in srgb, ${resolved} 15%, transparent)`,
            color: resolved,
          }
      : undefined

  const overrideWeight = data.weight
  const weightClass = overrideWeight
    ? fontWeightClass(overrideWeight)
    : isPlain
      ? 'font-medium'
      : 'font-semibold'

  const badgeClass = clsx(
    isPlain ? PLAIN_BASE : BADGE_BASE,
    weightClass,
    // Badge tint only in the pill variant; the text colour token applies
    // to both (plain just skips the background).
    !hasGradient && !isPlain && tonePalette?.bg,
    !hasGradient && tonePalette?.text,
  )
  const flexClass = clsx('flex w-full', ALIGN_FLEX[data.alignment])

  if (inlineEdit) {
    return (
      <div className={outerClass}>
        <div className={flexClass}>
          <span className={badgeClass} style={customStyle}>
            <InlineEditable
              blockId={inlineEdit.blockId}
              blockVersion={inlineEdit.blockVersion}
              pageId={inlineEdit.pageId}
              pageVersion={inlineEdit.pageVersion}
              initialData={data}
              field="text"
              kind="plain"
              initialValue={data.text}
              as="span"
              className=""
              placeholder="BADGE LABEL"
            />
          </span>
        </div>
      </div>
    )
  }

  const content = (
    <div className={flexClass}>
      <span className={badgeClass} style={customStyle}>
        {data.text}
      </span>
    </div>
  )

  if (data.animation === 'none') {
    return <div className={outerClass}>{content}</div>
  }
  return (
    <div className={outerClass}>
      <MotionTarget preset={data.animation}>{content}</MotionTarget>
    </div>
  )
}
