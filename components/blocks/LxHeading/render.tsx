import type { CSSProperties, ReactNode } from 'react'
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
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'
import { gradientTextStyle } from '@/lib/cms/gradient'
import { ResponsiveStyle, hasResponsive } from '@/components/blocks/_shared/ResponsiveStyle'

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
  // Size-aware leading: display type wants TIGHT leading (premium sites —
  // Apple / Stripe / Linear — set display headlines ~1.05–1.1; the old
  // blanket `leading-tight` = 1.25 read loose + tall on big headings).
  // Larger sizes get tighter leading; smaller ones loosen slightly for
  // readability. A per-block `lineHeight` override still wins over these.
  'display-2xl': 'text-5xl sm:text-6xl md:text-7xl leading-[1.05]',
  'display-xl':  'text-4xl sm:text-5xl md:text-6xl leading-[1.07]',
  'display-lg':  'text-3xl sm:text-4xl md:text-5xl leading-[1.1]',
  'display-md':  'text-2xl sm:text-3xl md:text-4xl leading-[1.14]',
  'display-sm':  'text-xl sm:text-2xl md:text-3xl leading-[1.2]',
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

// Two-tone highlight: wrap the FIRST occurrence of `match` in an accent
// span. Pure React-node splitting (no HTML), so nothing user-supplied is
// ever parsed as markup. No match / no highlight → the plain string.
function renderHighlighted(
  text: string,
  match: string | undefined,
  color: string,
): ReactNode {
  if (!match || match.trim() === '') return text
  const idx = text.indexOf(match)
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color }}>{match}</span>
      {text.slice(idx + match.length)}
    </>
  )
}

export function LxHeading({
  data,
  inlineEdit,
  outerClass,
  sectionMeta,
  blockId,
}: {
  data: BlockData<'lx_heading'>
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
  blockId?: number
}) {
  const Tag = data.level
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  // Responsive per-breakpoint typography (E17) — a scoped <style> overrides
  // the base size at tablet/mobile via a unique class.
  const rTablet = { fontSize: data.fontSizeTablet, lineHeight: data.lineHeightTablet }
  const rMobile = { fontSize: data.fontSizeMobile, lineHeight: data.lineHeightMobile }
  const responsive = blockId != null && hasResponsive(rTablet, rMobile)
  const rClass = responsive ? `cms-r-${blockId}` : undefined

  // Resolve tone. If it's a brand token, emit the Tailwind utility
  // (cacheable, themable). If it's a custom hex, fall back to an
  // inline style — no Tailwind utility can express arbitrary hex.
  const toneClass = isColorToken(tone) ? TOKEN_TEXT_CLASS[tone] : undefined
  // Merge tone color + exact typographic overrides into one inline style.
  // Inline style beats the size / leading-tight / tracking-tight utility
  // classes, so any set override wins to the pixel; unset = class baseline.
  const styleObj: CSSProperties = {}
  if (!isColorToken(tone)) styleObj.color = resolveColorValue(tone)
  if (data.fontSize) styleObj.fontSize = data.fontSize
  if (data.lineHeight) styleObj.lineHeight = data.lineHeight
  if (data.letterSpacing) styleObj.letterSpacing = data.letterSpacing
  // Gradient text wins over the solid tone colour when set (it sets
  // background-clip:text + transparent fill).
  Object.assign(styleObj, gradientTextStyle(data.textGradient))
  const toneStyle = Object.keys(styleObj).length > 0 ? styleObj : undefined
  // When gradient text is active, drop the tone utility class so its
  // `color` can't fight the transparent fill (utility color + inline
  // transparent: inline wins, but the class is dead weight + confusing).
  const toneClassEffective = data.textGradient ? undefined : toneClass

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
    // Leading now lives per-size in SIZE_CLASS (display type → tight).
    'tracking-tight',
    italic,
    SIZE_CLASS[data.size],
    ALIGN_CLASS[data.alignment],
    toneClassEffective,
    rClass,
  )
  const responsiveStyle = responsive ? (
    <ResponsiveStyle id={blockId!} tablet={rTablet} mobile={rMobile} />
  ) : null

  if (inlineEdit) {
    return (
      <div className={outerClass}>
        {responsiveStyle}
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

  // Highlight colour: explicit override, else the champagne accent.
  // Skipped under gradient text — the span's solid colour would punch a
  // flat patch into the gradient fill.
  const highlightColor =
    resolveColorValue(data.highlightColor) ?? 'var(--color-champagne)'
  const headingContent = data.textGradient
    ? data.text
    : renderHighlighted(data.text, data.highlightText, highlightColor)

  const heading = (
    <Tag className={className} style={{ ...toneStyle, ...fam.style }}>
      {headingContent}
    </Tag>
  )

  if (data.animation === 'none') {
    return (
      <div className={outerClass}>
        {responsiveStyle}
        {heading}
      </div>
    )
  }
  return (
    <div className={outerClass}>
      {responsiveStyle}
      <MotionTarget preset={data.animation}>{heading}</MotionTarget>
    </div>
  )
}
