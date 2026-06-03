import clsx from 'clsx'
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

// Luxury heading — Playfair Display serif for titles, bold weight,
// tracking-tight. Body text (lx_text) stays Montserrat so the
// classic serif/sans pairing matches the client's brand identity.
// Default level is h2; default size is display-lg. Hero placements
// step to h1 + display-2xl.

const SIZE_CLASS: Record<BlockData<'lx_heading'>['size'], string> = {
  // Mobile bumps one tier down so phones don't burn the viewport on
  // hero-tier sizes. Bold Montserrat takes more vertical space than
  // the previous serif draft; sizes calibrated so a Display-2XL h1
  // still fits comfortably on a 375px viewport.
  'display-2xl': 'text-5xl sm:text-6xl md:text-7xl',
  'display-xl':  'text-4xl sm:text-5xl md:text-6xl',
  'display-lg':  'text-3xl sm:text-4xl md:text-5xl',
  'display-md':  'text-2xl sm:text-3xl md:text-4xl',
  'display-sm':  'text-xl sm:text-2xl md:text-3xl',
}

const ALIGN_CLASS: Record<BlockData<'lx_heading'>['alignment'], string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

// Token-name tone fields fall back to the matching `text-*` utility so
// the rendered DOM stays cacheable. Ad-hoc hex values bypass the
// utility lookup and emit an inline style — the only path that can't
// be precomputed at build time. resolveColorValue() returns either a
// `var(--color-*)` string or the raw hex literal.
// Headings map the dark-text tone to `text-primary` (the operator's
// Primary brand color, default #050505 = obsidian) so Primary colors
// headings on light surfaces. ivory keeps the light-surface flip (the
// insert pipeline stores ivory for headings dropped onto dark sections);
// champagne keeps the gold accent. Body text (lx_text) is unaffected —
// it owns a separate map.
const TOKEN_TEXT_CLASS: Record<string, string> = {
  obsidian: 'text-primary',
  ivory: 'text-ivory',
  champagne: 'text-champagne',
}

export function LxHeading({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_heading'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const Tag = data.level
  const tone = data.tone

  // Resolve tone. If it's a brand token, emit the Tailwind utility
  // (cacheable, themable). If it's a custom hex, fall back to an
  // inline style — no Tailwind utility can express arbitrary hex.
  const toneClass = isColorToken(tone) ? TOKEN_TEXT_CLASS[tone] : undefined
  const toneStyle = !isColorToken(tone)
    ? { color: resolveColorValue(tone) }
    : undefined

  // Family override is opt-in — when undefined the renderer defaults
  // to font-serif (the serif role) per the client brand pairing. A role
  // token yields a Tailwind class; a catalog font yields an inline
  // font-family var (merged into the element style below).
  const fam = resolveFamilyRender(data.family)
  const familyClass = fam.className ?? 'font-serif'

  // Weight default is bold (luxury heading baseline per CLAUDE.md).
  // Operator overrides via the FontWeightPicker.
  const weight = data.weight
  const weightClass = weight ? fontWeightClass(weight) : 'font-bold'

  const italic = data.italic ? 'italic' : undefined

  const className = clsx(
    familyClass,
    weightClass,
    'leading-tight tracking-tight',
    italic,
    SIZE_CLASS[data.size],
    ALIGN_CLASS[data.alignment],
    toneClass,
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
          field="text"
          kind="plain"
          initialValue={data.text}
          as={Tag}
          className={className}
          style={{ ...toneStyle, ...fam.style }}
          placeholder="Type a heading…"
        />
      </div>
    )
  }

  const heading = (
    <Tag className={className} style={{ ...toneStyle, ...fam.style }}>
      {data.text}
    </Tag>
  )

  if (data.animation === 'none') {
    return <div className={outerClass}>{heading}</div>
  }
  return (
    <div className={outerClass}>
      <MotionTarget preset={data.animation}>{heading}</MotionTarget>
    </div>
  )
}
