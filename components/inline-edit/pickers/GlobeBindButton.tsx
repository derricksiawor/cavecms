'use client'
import { useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { Popover } from './Popover'

// Two-affordance pattern from Elementor: the colour swatch / typography
// pencil represents an AD-HOC value, this Globe button represents the
// design-system TOKEN binding. The globe turns blue when the current
// value resolves to a token (so the operator can see at a glance
// whether the control is brand-locked or hand-rolled), and a hover
// tooltip surfaces the bound token's NAME.
//
// Generic across colour + font-family + font-weight + any future
// token-able control. The picker passes:
//   - `bound`: the token NAME if the current value matches one, else null
//   - `options`: the list of {value,label,preview?} the operator can choose from
//   - `onChooseToken`: callback when a token is picked
//
// The "+ Create New Global" Elementor pattern: we DON'T ship a Site
// Settings panel yet (out of scope), so the create-new affordance is
// stubbed. A footer "Customise globals →" link directs to the future
// admin panel and is rendered only when `onCreateNew` is provided.

interface GlobeBindButtonProps<T extends string = string> {
  bound: { token: T; label: string } | null
  options: ReadonlyArray<{ value: T; label: string; swatch?: string }>
  onChooseToken: (token: T) => void
  // Optional: clears the binding (operator wants ad-hoc instead).
  onUnbind?: () => void
  // Where to position the popover. The chooser is small (≤ 240px wide).
  ariaLabel: string
}

export function GlobeBindButton<T extends string = string>({
  bound,
  options,
  onChooseToken,
  onUnbind,
  ariaLabel,
}: GlobeBindButtonProps<T>) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)

  const tooltip = bound
    ? `Bound to ${bound.label} — click to change`
    : 'Bind to a global design token'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tooltip}
        onClick={() => setOpen((v) => !v)}
        className={
          'inline-flex h-7 w-7 items-center justify-center rounded-full ' +
          'border transition-all duration-quick ' +
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
          // Unbound state uses warm-stone (not cream) so the affordance
          // reads on BOTH the dark drawer and the light Settings page —
          // the cream hairline + cream glyph vanished on the light surface.
          (bound
            ? 'border-copper-400/70 bg-copper-400/15 text-copper-300 hover:border-copper-400 hover:bg-copper-400/25'
            : 'border-warm-stone/45 bg-transparent text-warm-stone hover:border-copper-400/70 hover:text-copper-400')
        }
      >
        <Globe className="h-3.5 w-3.5" aria-hidden />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        width={240}
        ariaLabel={ariaLabel}
      >
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
          Global tokens
        </div>

        <ul className="mt-3 space-y-1">
          {options.map((opt) => {
            const isActive = bound?.token === opt.value
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChooseToken(opt.value)
                    setOpen(false)
                  }}
                  className={
                    'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-all duration-quick ' +
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
                    (isActive
                      ? 'bg-copper-400/15 text-cream-50'
                      : 'text-cream-50/85 hover:bg-cream-50/10 hover:text-cream-50')
                  }
                >
                  {opt.swatch && (
                    <span
                      aria-hidden
                      className="block h-4 w-4 shrink-0 rounded-full ring-1 ring-cream-50/20"
                      style={{ background: opt.swatch }}
                    />
                  )}
                  <span className="flex-1">{opt.label}</span>
                  {isActive && (
                    <span aria-hidden className="text-copper-300">
                      ●
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>

        {(onUnbind || bound) && (
          <div className="mt-3 border-t border-cream-50/10 pt-2">
            {bound && onUnbind && (
              <button
                type="button"
                onClick={() => {
                  onUnbind()
                  setOpen(false)
                }}
                className="text-[11px] uppercase tracking-[0.18em] text-cream-50/55 hover:text-cream-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 rounded px-1"
              >
                Unbind — use custom
              </button>
            )}
          </div>
        )}
      </Popover>
    </>
  )
}
