import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  fontWeightClass,
  isColorToken,
  resolveColorValue,
  resolveFamilyRender,
} from '@/lib/cms/designTokens'

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
// font-sans is the default body face; a per-element `family` override
// (role or catalog font) replaces it via badgeClass below.
const BADGE_BASE =
  'inline-flex items-center px-4 py-1.5 rounded-full text-xs uppercase tracking-eyebrow text-center md:text-left'

export function LxEyebrow({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_eyebrow'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const toneValue = data.tone
  const isToken = isColorToken(toneValue)
  const tonePalette = isToken ? TONE_TOKEN_CLASS[toneValue] : null
  const resolved = !isToken ? resolveColorValue(toneValue) : undefined

  // Custom hex tone: bg is a 15%-alpha tint computed via the resolved
  // colour, text uses the same colour solid. Tailwind can't express
  // arbitrary hex alpha as a utility, so this falls back to inline
  // style on both surfaces.
  const customStyle = resolved
    ? {
        backgroundColor: `color-mix(in srgb, ${resolved} 15%, transparent)`,
        color: resolved,
      }
    : undefined

  const overrideWeight = data.weight
  const weightClass = overrideWeight
    ? fontWeightClass(overrideWeight)
    : 'font-semibold'

  // Family override: role token → Tailwind class; catalog font → inline
  // font-family var (merged into the badge style below). Default font-sans.
  const fam = resolveFamilyRender(data.family)
  const badgeStyle =
    customStyle || fam.style ? { ...customStyle, ...fam.style } : undefined

  const badgeClass = clsx(
    BADGE_BASE,
    fam.className ?? 'font-sans',
    weightClass,
    tonePalette?.bg,
    tonePalette?.text,
  )
  const flexClass = clsx('flex w-full', ALIGN_FLEX[data.alignment])

  if (inlineEdit) {
    return (
      <div className={outerClass}>
        <div className={flexClass}>
          <span className={badgeClass} style={badgeStyle}>
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
      <span className={badgeClass} style={badgeStyle}>
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
