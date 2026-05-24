'use client'
import { useRef, useState } from 'react'
import { Check, Type } from 'lucide-react'
import {
  FONT_FAMILY_TOKENS,
  type FontFamilyToken,
} from '@/lib/cms/designTokens'
import { Popover } from './Popover'

// Elementor-style family picker. Single trigger button that opens a
// popover listing every family — each option styled in ITS OWN FACE
// so the operator picks visually, not by name.
//
// BWC ships two families (display + body) but both currently resolve
// to Montserrat (per globals.css comment "hierarchy is built via
// weight"). The picker still surfaces both because future brand
// expansion may diverge. Elementor exposes 1000+ Google Fonts; the
// BWC luxury system is intentionally tight — token-locked, no
// arbitrary Google Font picker.
//
// `value` is undefined when the block uses its render-default family.
// "Use default" is the first chooser entry so the operator can revert
// to whatever the renderer ships.

interface FontFamilyPickerFieldProps {
  label: string
  help?: string
  value: FontFamilyToken | undefined
  onChange: (v: FontFamilyToken | undefined) => void
}

export function FontFamilyPickerField({
  label,
  help,
  value,
  onChange,
}: FontFamilyPickerFieldProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)

  const current = value ? FONT_FAMILY_TOKENS[value] : null
  const families = Object.entries(FONT_FAMILY_TOKENS) as Array<
    [FontFamilyToken, (typeof FONT_FAMILY_TOKENS)[FontFamilyToken]]
  >

  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
        {label}
      </span>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl border border-cream-50/15 bg-cream-50/[0.04] px-3 py-2.5 text-left transition-all duration-quick hover:border-copper-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
      >
        <Type className="h-4 w-4 shrink-0 text-cream-50/55" aria-hidden />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[15px] text-cream-50"
            style={{ fontFamily: current?.stack ?? 'inherit' }}
          >
            {current ? current.previewName : 'Use renderer default'}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">
            {current ? current.label : 'No override'}
          </div>
        </div>
      </button>

      {help && (
        <span className="mt-1 block text-[11px] text-warm-stone/80">
          {help}
        </span>
      )}

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        width={296}
        ariaLabel={`${label} picker`}
      >
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
          Brand families
        </div>

        <ul className="mt-2 space-y-1" role="listbox" aria-label={label}>
          {/* Default sentinel — clears the override so renderer falls
              back to its built-in family. */}
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === undefined}
              onClick={() => {
                onChange(undefined)
                setOpen(false)
              }}
              className={
                'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-all duration-quick ' +
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
                (value === undefined
                  ? 'bg-copper-400/15 text-cream-50'
                  : 'text-cream-50/85 hover:bg-cream-50/10 hover:text-cream-50')
              }
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-dashed border-cream-50/15 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">
                —
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] text-current">
                  Use renderer default
                </div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">
                  Inherits whatever the block defines
                </div>
              </div>
              {value === undefined && (
                <Check className="h-4 w-4 text-copper-300" aria-hidden />
              )}
            </button>
          </li>

          {families.map(([token, meta]) => {
            const isActive = value === token
            return (
              <li key={token}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onChange(token)
                    setOpen(false)
                  }}
                  className={
                    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-all duration-quick ' +
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
                    (isActive
                      ? 'bg-copper-400/15 text-cream-50'
                      : 'text-cream-50/85 hover:bg-cream-50/10 hover:text-cream-50')
                  }
                >
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-cream-50/15 bg-cream-50/[0.04] text-[18px] font-bold text-cream-50"
                    style={{ fontFamily: meta.stack }}
                  >
                    Aa
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-[15px] text-current"
                      style={{ fontFamily: meta.stack }}
                    >
                      {meta.previewName}
                    </div>
                    <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">
                      {meta.label} · weights{' '}
                      {meta.shippedWeights
                        .map(
                          (w) =>
                            ({
                              regular: 400,
                              medium: 500,
                              semibold: 600,
                              bold: 700,
                              black: 900,
                            }[w]),
                        )
                        .join('/')}
                    </div>
                  </div>
                  {isActive && (
                    <Check
                      className="h-4 w-4 text-copper-300"
                      aria-hidden
                    />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </Popover>
    </div>
  )
}
