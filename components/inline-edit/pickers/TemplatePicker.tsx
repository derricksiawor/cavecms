'use client'

import clsx from 'clsx'

// Visual layout-template picker (#0.59) for the Posts widget. Renders a grid of
// clickable tiles, each drawing a MINI DIAGRAM of the layout it produces — the
// operator sees the actual shape (grid / cards / list / magazine / carousel),
// NOT a <select> of names. Matches the EditDrawer's dark surface treatment
// (cream-50 tints + copper accent on the active tile).

interface TemplatePickerFieldProps {
  label: string
  help?: string
  options: Array<{ value: string; label: string }>
  value: string | undefined
  onChange: (v: string) => void
}

// Mini-diagram per template value. Pure SVG (no asset), scales to the tile.
// Uses currentColor so it inherits the tile's active/inactive tint.
function TemplateDiagram({ value }: { value: string }) {
  const stroke = 'currentColor'
  const fill = 'currentColor'
  switch (value) {
    case 'grid':
      return (
        <svg viewBox="0 0 48 32" className="h-8 w-12" aria-hidden>
          {[0, 1, 2].map((c) => (
            <g key={c} transform={`translate(${c * 16 + 1},0)`}>
              <rect x="0" y="1" width="13" height="9" rx="1.5" fill={fill} opacity="0.85" />
              <rect x="0" y="12" width="13" height="2" rx="1" fill={fill} opacity="0.55" />
              <rect x="0" y="15.5" width="10" height="1.5" rx="0.75" fill={fill} opacity="0.35" />
            </g>
          ))}
        </svg>
      )
    case 'cards':
      return (
        <svg viewBox="0 0 48 32" className="h-8 w-12" aria-hidden>
          {[0, 1].map((c) => (
            <g key={c} transform={`translate(${c * 24 + 2},2)`}>
              <rect x="0" y="0" width="20" height="28" rx="3" fill="none" stroke={stroke} strokeWidth="1.2" opacity="0.5" />
              <rect x="2.5" y="2.5" width="15" height="9" rx="1.5" fill={fill} opacity="0.85" />
              <rect x="2.5" y="14" width="15" height="2" rx="1" fill={fill} opacity="0.55" />
              <rect x="2.5" y="17.5" width="11" height="1.5" rx="0.75" fill={fill} opacity="0.35" />
            </g>
          ))}
        </svg>
      )
    case 'list':
      return (
        <svg viewBox="0 0 48 32" className="h-8 w-12" aria-hidden>
          {[0, 1].map((r) => (
            <g key={r} transform={`translate(1,${r * 15 + 1})`}>
              <rect x="0" y="0" width="14" height="13" rx="1.5" fill={fill} opacity="0.85" />
              <rect x="17" y="2" width="28" height="2" rx="1" fill={fill} opacity="0.55" />
              <rect x="17" y="6" width="22" height="1.5" rx="0.75" fill={fill} opacity="0.35" />
              <rect x="17" y="9" width="24" height="1.5" rx="0.75" fill={fill} opacity="0.35" />
            </g>
          ))}
        </svg>
      )
    case 'magazine':
      return (
        <svg viewBox="0 0 48 32" className="h-8 w-12" aria-hidden>
          {/* large lead */}
          <rect x="1" y="1" width="28" height="20" rx="2" fill={fill} opacity="0.85" />
          <rect x="1" y="23" width="22" height="2.5" rx="1" fill={fill} opacity="0.55" />
          <rect x="1" y="27" width="16" height="1.5" rx="0.75" fill={fill} opacity="0.35" />
          {/* secondary rail */}
          {[0, 1].map((i) => (
            <g key={i} transform={`translate(32,${i * 11 + 1})`}>
              <rect x="0" y="0" width="15" height="7" rx="1.5" fill={fill} opacity="0.7" />
              <rect x="0" y="8" width="12" height="1.5" rx="0.75" fill={fill} opacity="0.4" />
            </g>
          ))}
        </svg>
      )
    case 'carousel':
      return (
        <svg viewBox="0 0 48 32" className="h-8 w-12" aria-hidden>
          <rect x="9" y="2" width="13" height="20" rx="2" fill={fill} opacity="0.85" />
          <rect x="24" y="2" width="13" height="20" rx="2" fill={fill} opacity="0.85" />
          <rect x="1" y="6" width="5" height="12" rx="2" fill={fill} opacity="0.4" />
          <rect x="40" y="6" width="5" height="12" rx="2" fill={fill} opacity="0.4" />
          {/* dots */}
          {[0, 1, 2].map((d) => (
            <circle key={d} cx={20 + d * 4} cy={27} r={d === 1 ? 1.5 : 1} fill={fill} opacity={d === 1 ? 0.9 : 0.4} />
          ))}
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 48 32" className="h-8 w-12" aria-hidden>
          <rect x="2" y="2" width="44" height="28" rx="2" fill={fill} opacity="0.4" />
        </svg>
      )
  }
}

export function TemplatePickerField({
  label,
  help,
  options,
  value,
  onChange,
}: TemplatePickerFieldProps) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
        {label}
      </span>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-2">
        {options.map((o) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.value)}
              className={clsx(
                'flex flex-col items-center gap-2 rounded-xl border px-2 py-3 transition-all duration-quick focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70',
                active
                  ? 'border-copper-400/70 bg-copper-400/10 text-champagne'
                  : 'border-cream-50/12 bg-cream-50/[0.04] text-cream-50/55 hover:border-copper-400/40 hover:text-cream-50',
              )}
            >
              <TemplateDiagram value={o.value} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">
                {o.label}
              </span>
            </button>
          )
        })}
      </div>
      {help && <span className="mt-1 block text-[11px] text-warm-stone/80">{help}</span>}
    </div>
  )
}
