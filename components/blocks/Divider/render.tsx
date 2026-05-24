import clsx from 'clsx'

// Elementor-parity Divider widget. Canonical Elementor fields per
// `includes/widgets/divider.php`:
//   - style: solid | double | dotted | dashed (plus pattern variants:
//     curly / curved / wavy / zigzag / multiple / arrows / pluses)
//   - width: responsive slider (px/%/em/rem/vw, default 100%)
//   - weight: 1–10px slider
//   - colour, align, look (none | text | icon), text, icon, gap
//
// BWC narrows the catalog: solid/dashed/dotted/double only — luxury-RE
// aesthetic favours hairline minimalism; squiggly dividers would read
// as toy-like. Width is collapsed to 4 enum presets (full/half/quarter/
// short). The text/icon embedding variants are out of scope — operators
// stack Heading + Divider for the same effect with stronger typographic
// control.
//
// Padding: NO natural section padding on this widget. A divider is
// punctuation, not a section. Operators stack a Spacer above/below for
// breathing room. Horizontal padding (px-4 sm:px-6) stays so the rule
// never goes flush against the viewport edge on narrow screens.
//
// Reference URLs:
//   - https://elementor.com/help/divider-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/divider.php
//   - https://developer.wordpress.org/block-editor/reference-guides/core-blocks/

interface DividerData {
  style: 'solid' | 'dashed' | 'dotted' | 'double'
  width: 'full' | 'half' | 'quarter' | 'short'
  thickness: 'hairline' | '1px' | '2px' | '4px'
  color: 'copper' | 'warm-stone' | 'near-black'
  alignment: 'left' | 'center' | 'right'
}

const STYLE_CLASS: Record<DividerData['style'], string> = {
  solid: 'border-solid',
  dashed: 'border-dashed',
  dotted: 'border-dotted',
  double: 'border-double',
}

// Hairline uses a 0.5px arbitrary value — on Retina this renders as a
// true half-pixel rule; on standard-density displays the browser rounds
// to 1px (visually identical to the '1px' tier on those devices). The
// 'double' style needs at least a 3px width to render visibly; the
// EditDrawer help text flags this combination for operators.
const THICKNESS_CLASS: Record<DividerData['thickness'], string> = {
  hairline: 'border-t-[0.5px]',
  '1px': 'border-t',
  '2px': 'border-t-2',
  '4px': 'border-t-4',
}

const COLOR_CLASS: Record<DividerData['color'], string> = {
  copper: 'border-copper-500',
  'warm-stone': 'border-warm-stone/40',
  'near-black': 'border-near-black',
}

// Width keys: full = 100%, half = 50%, quarter = 25%, short = a compact
// fixed-pixel rule (w-16 = 64px) for editorial accents under headings.
const WIDTH_CLASS: Record<DividerData['width'], string> = {
  full: 'w-full',
  half: 'w-1/2',
  quarter: 'w-1/4',
  short: 'w-16',
}

const ALIGN_CLASS: Record<DividerData['alignment'], string> = {
  left: 'mr-auto',
  center: 'mx-auto',
  right: 'ml-auto',
}

export function Divider({
  data,
  outerClass,
}: {
  data: DividerData
  outerClass?: string
}) {
  // CSS `border-style: double` requires ≥3px of border-width to render
  // two distinct lines — at hairline/1px/2px the browser collapses the
  // rule to a single solid line (or invisible at 0.5px). Auto-coerce
  // to 4px when the operator picks "double" with a thinner thickness,
  // so the visual output matches their intent. The EditDrawer help
  // text also calls this out for the read site.
  const effectiveThickness =
    data.style === 'double' && data.thickness !== '4px' ? '4px' : data.thickness
  return (
    <div className={clsx('px-4 sm:px-6 max-w-4xl mx-auto', outerClass)}>
      <hr
        className={clsx(
          // border-0 resets the default <hr> styles in browsers that ship
          // a 1px inset rule; the border-t-* utility then provides the
          // explicit top-edge rule with our chosen style + thickness.
          'block border-0',
          STYLE_CLASS[data.style],
          THICKNESS_CLASS[effectiveThickness],
          COLOR_CLASS[data.color],
          WIDTH_CLASS[data.width],
          ALIGN_CLASS[data.alignment],
        )}
      />
    </div>
  )
}
