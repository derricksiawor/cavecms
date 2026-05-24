// Elementor-parity Spacer widget. Canonical Elementor fields per
// `includes/widgets/spacer.php`:
//   - space: responsive px/em/rem/vh slider (default 50px, max 600px / 20em)
//   - Style tab is INTENTIONALLY empty — the widget exists purely to
//     inject vertical whitespace.
//
// BWC collapses Elementor's free-form pixel slider into the 6-tier
// SPACING_TIERS scale from lib/cms/spacingTokens (xs/sm/md/lg/xl/2xl).
// The 'none' tier from SPACING_TIERS is excluded — a zero-height spacer
// is degenerate; if the operator wants no space they should remove the
// widget. Operators who need finer control compose multiple Spacers.
//
// Padding exception: this is the one widget that explicitly opts OUT of
// the universal natural padding (Chunk D's py-12 sm:py-16). Its entire
// purpose is to add exactly N pixels of vertical whitespace — wrapping
// itself in 48-64px of additional padding defeats the widget. Horizontal
// padding is omitted too; vertical-only.
//
// Reference URLs:
//   - https://elementor.com/help/spacer-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/spacer.php
//   - https://developer.wordpress.org/block-editor/reference-guides/core-blocks/

interface SpacerData {
  height: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
}

// Heights mirror lib/cms/spacingTokens SPACING_TIERS px values so an
// "M spacer" reads the same height as the "M padding" tier the operator
// sees in the Chunk E spacing toolbar. Static literal strings so
// Tailwind v4's JIT scanner picks them all up at build time — a
// computed `${prefix}${value}` would silently drop classes from the
// generated stylesheet.
const HEIGHT_CLASS: Record<SpacerData['height'], string> = {
  xs: 'h-2', //   8 px
  sm: 'h-4', //  16 px
  md: 'h-8', //  32 px
  lg: 'h-16', // 64 px
  xl: 'h-24', // 96 px
  '2xl': 'h-32', // 128 px
}

export function Spacer({
  data,
  outerClass,
}: {
  data: SpacerData
  outerClass?: string
}) {
  // Two-element wrap: outer carries outerClass (the per-side spacing
  // override from Chunk E's toolbar); inner carries the fixed height
  // tier. With Tailwind's default `box-sizing: border-box`, putting
  // both classes on the same element would mean `h-8 !pt-16` renders
  // as 64px total (padding wins, height includes padding) instead of
  // the operator's expected "8px spacer + 64px extra top padding"
  // semantics. The wrap pattern keeps height and spacing additive.
  return (
    <div className={outerClass}>
      <div aria-hidden="true" className={HEIGHT_CLASS[data.height]} />
    </div>
  )
}
