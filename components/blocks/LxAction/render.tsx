import type { CSSProperties, ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowUpRight } from 'lucide-react'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import { compileGradient, gradientTextStyle } from '@/lib/cms/gradient'
import { resolveColorValue } from '@/lib/cms/designTokens'

// Luxury CTA — per ~/.claude/CLAUDE.md: "Buttons: Always w-fit with
// padding (px-6/px-8), never flex-1 or full width." Bold Montserrat,
// champagne fill on obsidian text (primary), or tinted-fill variants
// — NEVER border-only chrome (the "secondary-outline" variant from
// the schema renders as a translucent champagne tint, not as a gold
// outline, because borders are forbidden).
//
// `magnetic` animation pulls the button toward the cursor on hover;
// reserved for the single canonical hero CTA. The `lx-pulse-champagne`
// CSS animation supplies a soft glow halo that pulses outward at
// 2.4s intervals — applied to the primary variant by default to draw
// attention.

const SIZE_CLASS: Record<BlockData<'lx_action'>['size'], string> = {
  sm: 'px-5 py-2 text-[10px]',
  md: 'px-6 py-2.5 text-[11px]',
  lg: 'px-8 py-3 text-[13px]',
}

const VARIANT_CLASS: Record<BlockData<'lx_action'>['variant'], string> = {
  // Primary — champagne fill, obsidian text. Pulses by default.
  'primary-gold':
    'bg-champagne text-obsidian hover:bg-antique-gold hover:text-ivory shadow-lg shadow-champagne/20 lx-pulse-champagne',
  // Tinted — translucent champagne with champagne text (no border).
  // The "outline" mental model becomes a soft tinted pill.
  'secondary-outline':
    'bg-champagne/10 text-champagne hover:bg-champagne/25',
  // Ghost — type only, no chrome. Lights up on hover.
  ghost: 'bg-transparent text-ivory hover:text-champagne',
  // Link-arrow — handled separately below.
  'link-arrow': '',
}

const ALIGN_CONTAINER: Record<BlockData<'lx_action'>['alignment'], string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

// In EDIT mode the renderer wraps label + href editors in a vertical
// `flex flex-col` — `text-align` cascades to inline children but a
// `w-fit` button child collapses against the FLEX cross-axis (default
// `stretch`) and lands at the start. Mirror the configured alignment
// onto `items-{start|center|end}` so the pill renders where the
// operator picked it. Bug surfaced: button stayed left in edit mode
// regardless of alignment; the public render path was fine because it
// has no flex wrapper.
const ALIGN_ITEMS: Record<BlockData<'lx_action'>['alignment'], string> = {
  left: 'items-start',
  center: 'items-center',
  right: 'items-end',
}

// External-href detection. The earlier draft over-tightened to
// require `://`; we keep that strictness here so `https:foo`
// (ambiguous) doesn't classify as external.
const EXTERNAL_HREF_RE = /^https?:\/\//i
function linkRel(href: string, openInNew?: boolean): string | undefined {
  const external = EXTERNAL_HREF_RE.test(href)
  const parts: string[] = []
  if (openInNew) parts.push('noopener', 'noreferrer')
  if (external) parts.push('nofollow')
  return parts.length ? parts.join(' ') : undefined
}

export function LxAction({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_action'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const isLinkArrow = data.variant === 'link-arrow'

  // Button-style variants — rounded-full pill, w-fit per CLAUDE.md
  // ("Always w-fit with padding"), bold typography, smooth color
  // transition. Magnetic + pulse animations layer on top.
  // Per-corner radius overrides the single `radius`; any corner set drops
  // the full pill and emits a 4-value border-radius.
  const perCorner = [data.radiusTopLeft, data.radiusTopRight, data.radiusBottomRight, data.radiusBottomLeft]
  const hasPerCorner = perCorner.some((v) => typeof v === 'number')
  const baseR = typeof data.radius === 'number' ? data.radius : 0
  const radiusInline = hasPerCorner
    ? `${data.radiusTopLeft ?? baseR}px ${data.radiusTopRight ?? baseR}px ${data.radiusBottomRight ?? baseR}px ${data.radiusBottomLeft ?? baseR}px`
    : typeof data.radius === 'number'
      ? `${data.radius}px`
      : undefined
  const customRadius = !!radiusInline

  // Hover-state overrides via CSS custom properties + the `cms-hover` class.
  const hoverBg = data.hoverFillColor ? resolveColorValue(data.hoverFillColor) : undefined
  const hoverFg = data.hoverTextColor ? resolveColorValue(data.hoverTextColor) : undefined
  const hoverScale = typeof data.hoverScale === 'number' ? data.hoverScale / 100 : undefined
  const hasHover = !!(hoverBg || hoverFg || hoverScale || data.transitionMs)

  const buttonClass = clsx(
    'inline-flex items-center justify-center gap-2 w-fit font-sans font-semibold uppercase tracking-[0.22em] min-h-[44px] transition-all duration-base ease-luxury',
    // Default full pill; a custom px radius overrides via inline style.
    !customRadius && 'rounded-full',
    hasHover && 'cms-hover',
    SIZE_CLASS[data.size],
    VARIANT_CLASS[data.variant],
  )

  // Link-arrow — type + animated arrow. No pill chrome. The arrow
  // translates +4px right on hover via group-hover.
  const linkClass =
    'group inline-flex items-center gap-2 w-fit font-sans font-semibold text-ivory text-base min-h-[44px] hover:text-champagne transition-colors duration-base ease-luxury'

  const containerClass = clsx(ALIGN_CONTAINER[data.alignment], outerClass)

  // Gradient FILL on the pill (background-image layers over the variant's
  // solid bg). Not applicable to link-arrow (it's text, no pill).
  const fillCss = !isLinkArrow ? compileGradient(data.backgroundGradient) : undefined
  // Solid fill colour (e.g. a white button) — overrides the variant fill; a
  // gradient wins over it. Plus an exact corner radius (px).
  const solidFill =
    !isLinkArrow && !fillCss && data.fillColor ? resolveColorValue(data.fillColor) : undefined
  const pillStyle: CSSProperties | undefined =
    fillCss || solidFill || customRadius || hasHover
      ? ({
          ...(fillCss ? { backgroundImage: fillCss } : {}),
          ...(solidFill ? { backgroundColor: solidFill } : {}),
          ...(radiusInline ? { borderRadius: radiusInline } : {}),
          ...(hoverBg ? { '--cms-hover-bg': hoverBg } : {}),
          ...(hoverFg ? { '--cms-hover-fg': hoverFg } : {}),
          ...(hoverScale ? { '--cms-hover-scale': String(hoverScale) } : {}),
          ...(data.transitionMs ? { '--cms-hover-dur': `${data.transitionMs}ms` } : {}),
        } as CSSProperties)
      : undefined
  // Gradient LABEL — only when there's no fill gradient (a single element
  // can't background-clip:text AND show a fill gradient at once). Wraps the
  // label text in a span so the surrounding pill chrome is untouched.
  const labelGradStyle = !fillCss ? gradientTextStyle(data.textGradient) : {}
  const renderLabel = (text: string): ReactNode =>
    Object.keys(labelGradStyle).length > 0 ? <span style={labelGradStyle}>{text}</span> : text

  if (inlineEdit) {
    // Paired href editor for both variants — sits below the button /
    // link so the operator can retarget without opening the drawer.
    const hrefEditor = (
      <InlineEditable
        blockId={inlineEdit.blockId}
        blockVersion={inlineEdit.blockVersion}
        pageId={inlineEdit.pageId}
        pageVersion={inlineEdit.pageVersion}
        initialData={data}
        field="href"
        kind="plain"
        initialValue={data.href}
        as="span"
        className="font-sans text-xs text-warm-stone"
        placeholder="/contact"
      />
    )
    if (isLinkArrow) {
      return (
        <div className={clsx(containerClass, 'flex flex-col gap-1', ALIGN_ITEMS[data.alignment])}>
          <span className={linkClass}>
            <InlineEditable
              blockId={inlineEdit.blockId}
              blockVersion={inlineEdit.blockVersion}
              pageId={inlineEdit.pageId}
              pageVersion={inlineEdit.pageVersion}
              initialData={data}
              field="label"
              kind="plain"
              initialValue={data.label}
              as="span"
              className=""
              placeholder="Action label…"
            />
            <ArrowUpRight size={20} strokeWidth={2.5} aria-hidden="true" />
          </span>
          {hrefEditor}
        </div>
      )
    }
    return (
      <div className={clsx(containerClass, 'flex flex-col gap-1', ALIGN_ITEMS[data.alignment])}>
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="label"
          kind="plain"
          initialValue={data.label}
          as="span"
          className={buttonClass}
          style={pillStyle}
          placeholder="Action label…"
        />
        {hrefEditor}
      </div>
    )
  }

  const node = isLinkArrow ? (
    <a
      href={data.href}
      target={data.openInNew ? '_blank' : undefined}
      rel={linkRel(data.href, data.openInNew)}
      className={linkClass}
    >
      <span>{renderLabel(data.label)}</span>
      <ArrowUpRight
        size={20}
        strokeWidth={2.5}
        aria-hidden="true"
        className="transition-transform duration-base ease-luxury group-hover:translate-x-1 group-hover:-translate-y-0.5"
      />
    </a>
  ) : (
    <a
      href={data.href}
      target={data.openInNew ? '_blank' : undefined}
      rel={linkRel(data.href, data.openInNew)}
      className={buttonClass}
      style={pillStyle}
    >
      {renderLabel(data.label)}
    </a>
  )

  if (data.animation === 'none') {
    return <div className={containerClass}>{node}</div>
  }
  return (
    <div className={containerClass}>
      <MotionTarget preset={data.animation}>{node}</MotionTarget>
    </div>
  )
}
