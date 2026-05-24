import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  FAMILY_TAILWIND,
  fontWeightClass,
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury body text — Montserrat at semibold for lead body, regular
// for standard body. Per ~/.claude/CLAUDE.md: "NO light font weights"
// — body never drops below regular (400).
//
// No `prose` plugin — prose injects underlined links, blockquote
// borders, and horizontal rule defaults that contradict the "no
// borders" rule. Inline elements (<strong>, <em>, <a>, <ul>, <li>)
// are styled directly via the className chain.
//
// Public render uses dangerouslySetInnerHTML against body_richtext
// that's already been sanitized through DOMPurify at both the write
// and read boundaries (sanitize-shared.ts + parse.ts RICHTEXT_FIELDS).

const SIZE_CLASS: Record<BlockData<'lx_text'>['size'], string> = {
  'body-lg': 'text-lg sm:text-xl',
  'body-md': 'text-base sm:text-lg',
  'body-sm': 'text-sm sm:text-base',
}

const WEIGHT_CLASS: Record<BlockData<'lx_text'>['size'], string> = {
  // Lead body reads as a subhead — semibold gives the editorial
  // pause-and-read weight. Standard + small body stay at medium
  // (still NOT light per the global rule).
  'body-lg': 'font-semibold',
  'body-md': 'font-medium',
  'body-sm': 'font-medium',
}

const ALIGN_CLASS: Record<BlockData<'lx_text'>['alignment'], string> = {
  left: 'text-left',
  center: 'text-center',
}

const TONE_TOKEN_CLASS: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
  'warm-stone': 'text-warm-stone',
}


const MAX_WIDTH_CLASS: Record<BlockData<'lx_text'>['maxWidth'], string> = {
  // ch units key off the current font's "0" glyph width. Montserrat
  // is wider than Inter — same `ch` count produces a wider line.
  // Slightly tighter measures for the bold body.
  narrow: 'max-w-[40ch] mx-auto',
  medium: 'max-w-[55ch] mx-auto',
  wide: 'max-w-[70ch] mx-auto',
  full: 'max-w-none',
}

export function LxText({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_text'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const tone = data.tone
  const toneClass = isColorToken(tone) ? TONE_TOKEN_CLASS[tone] : undefined
  const toneStyle = !isColorToken(tone)
    ? { color: resolveColorValue(tone) }
    : undefined

  const family = data.family
  const familyClass = family ? FAMILY_TAILWIND[family] : 'font-sans'

  // Override-aware weight. When unset, fall back to the size-driven
  // editorial weight (semibold for lead body, medium otherwise).
  const overrideWeight = data.weight
  const weightClass = overrideWeight
    ? fontWeightClass(overrideWeight)
    : WEIGHT_CLASS[data.size]

  const className = clsx(
    familyClass,
    'leading-relaxed',
    SIZE_CLASS[data.size],
    weightClass,
    ALIGN_CLASS[data.alignment],
    toneClass,
    MAX_WIDTH_CLASS[data.maxWidth],
  )

  if (inlineEdit) {
    return (
      <div className={outerClass}>
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="body_richtext"
          kind="richtext"
          initialValue={data.body_richtext}
          as="div"
          className={className}
          style={toneStyle}
          placeholder="Type to add text…"
        />
      </div>
    )
  }

  if (!data.body_richtext) {
    return null
  }

  const content = (
    <div
      className={className}
      style={toneStyle}
      dangerouslySetInnerHTML={{ __html: data.body_richtext }}
    />
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
