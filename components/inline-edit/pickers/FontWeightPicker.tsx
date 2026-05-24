'use client'
import {
  FONT_FAMILY_TOKENS,
  FONT_WEIGHT_TOKENS,
  type FontFamilyToken,
  type FontWeightToken,
} from '@/lib/cms/designTokens'

// Segmented control of font-weight tokens. Greys out any weight the
// currently-selected family doesn't ship — Elementor's GitHub
// issue #5022 calls out that they don't filter, leading to operators
// picking a weight that visually does nothing. We close that gap.
//
// `family` is optional: when undefined (use renderer default), every
// weight is rendered enabled — the renderer's family will resolve
// either Display (all 5 weights) or Body (no Black) at paint time
// and pick the nearest available weight in either case.

interface FontWeightPickerFieldProps {
  label: string
  help?: string
  value: FontWeightToken | undefined
  onChange: (v: FontWeightToken | undefined) => void
  // When set, the picker checks the family's `shippedWeights` and
  // greys out any weight not present. When undefined, every weight is
  // enabled — operator can override regardless of family.
  family?: FontFamilyToken | undefined
}

export function FontWeightPickerField({
  label,
  help,
  value,
  onChange,
  family,
}: FontWeightPickerFieldProps) {
  const familyMeta = family ? FONT_FAMILY_TOKENS[family] : null
  const isShipped = (w: FontWeightToken) =>
    !familyMeta || familyMeta.shippedWeights.includes(w)

  const weights = Object.entries(FONT_WEIGHT_TOKENS) as Array<
    [FontWeightToken, (typeof FONT_WEIGHT_TOKENS)[FontWeightToken]]
  >

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          {label}
        </span>
        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-[10px] uppercase tracking-[0.18em] text-warm-stone/70 hover:text-cream-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 rounded px-1"
            aria-label="Clear weight override"
          >
            Reset
          </button>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex w-full overflow-hidden rounded-xl border border-cream-50/15 bg-cream-50/[0.04]"
      >
        {weights.map(([token, meta]) => {
          const shipped = isShipped(token)
          const isActive = value === token
          return (
            <button
              key={token}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-disabled={!shipped}
              disabled={!shipped}
              onClick={() => onChange(token)}
              title={
                shipped
                  ? meta.label
                  : `${meta.label} — not shipped by ${familyMeta?.label}`
              }
              className={
                'flex-1 px-2 py-2 text-center text-[11px] uppercase tracking-[0.14em] transition-all duration-quick ' +
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-copper-400/70 ' +
                'border-r border-cream-50/10 last:border-r-0 ' +
                (isActive
                  ? 'bg-copper-400/20 text-cream-50'
                  : shipped
                    ? 'text-cream-50/75 hover:bg-cream-50/10 hover:text-cream-50'
                    : 'cursor-not-allowed text-cream-50/25 line-through')
              }
              style={{ fontWeight: meta.weight }}
            >
              {meta.weight}
            </button>
          )
        })}
      </div>

      {/* Surface the currently-selected weight's label so the operator
          knows what 700 maps to (Bold) without needing to remember. */}
      <div className="text-[10.5px] tracking-[0.14em] text-cream-50/55">
        {value
          ? FONT_WEIGHT_TOKENS[value].label
          : familyMeta
            ? `Uses ${familyMeta.label.toLowerCase()} default`
            : 'Uses renderer default'}
      </div>

      {help && (
        <span className="mt-1 block text-[11px] text-warm-stone/80">
          {help}
        </span>
      )}
    </div>
  )
}
