'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pipette, Plus, X } from 'lucide-react'
import { useColorSwatches } from '@/components/inline-edit/ColorSwatchesContext'
import { HexColorPicker, HexAlphaColorPicker } from 'react-colorful'
import {
  COLOR_TOKENS,
  type ColorToken,
  HEX_COLOR_RE,
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'
import { safeStorage } from '@/lib/client/safeStorage'
import { Popover } from './Popover'
import { GlobeBindButton } from './GlobeBindButton'

// Elementor-anatomy colour picker for the CaveCMS inline editor.
//
// Trigger row: [ swatch button ][ globe ] LABEL
// On swatch click → popover opens with:
//   1. Token swatch grid — 6 luxury tokens (or `tokens` subset)
//   2. react-colorful SV square + hue + alpha
//   3. HEX input + format toggle (HEX / RGB)
//   4. Eyedropper (where window.EyeDropper exists — Chromium-based)
//   5. Saved colours row — 8 swatches + "+" to add current; click
//      removes (cap 8)
//
// Value is either a ColorToken name ('champagne') or a hex string
// ('#C9A961' or '#C9A96180'). resolveColorValue() in designTokens.ts
// is the canonical resolver — pickers, renderers, and Globe state
// all agree on what "bound" means.

const SAVED_COLORS_KEY = 'cavecms.editor.savedColors'
const SAVED_COLORS_MAX = 8

interface ColorPickerFieldProps {
  label: string
  help?: string
  value: string | undefined
  onChange: (v: string | undefined) => void
  // Subset of tokens to show. Defaults to all 6.
  tokens?: ReadonlyArray<ColorToken>
  // Default 'rgba' allows alpha (most luxury backgrounds need none, but
  // text/overlay surfaces may want a tint). Pickers can opt out by
  // passing 'rgb'.
  allowAlpha?: boolean
  // When false, only the token swatches show — no custom hex / eyedropper /
  // saved row. Useful for fields locked to the brand palette.
  allowCustom?: boolean
  // When true: the picker is for DEFINING a concrete hex (e.g. the Theme
  // settings page). Token swatches act as quick-start presets and emit
  // their hex (never a token name), and the Globe "bind to token" button
  // is hidden. Default false preserves the inline-editor binding behavior.
  hexOnly?: boolean
}

export function ColorPickerField({
  label,
  help,
  value,
  onChange,
  tokens,
  allowAlpha = true,
  allowCustom = true,
  hexOnly = false,
}: ColorPickerFieldProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)

  const tokenList = useMemo<ReadonlyArray<ColorToken>>(() => {
    return tokens ?? (Object.keys(COLOR_TOKENS) as ColorToken[])
  }, [tokens])

  const boundToken: ColorToken | null =
    value && isColorToken(value) ? value : null

  // Saved custom colours (localStorage). Reads validate every entry
  // against HEX_COLOR_RE — a hostile browser extension or a stale
  // pre-format value can't smuggle non-hex strings into editor state.
  // If the on-disk shape was corrupted, we self-heal by re-writing
  // the cleaned subset on next persist.
  const [saved, setSaved] = useState<string[]>([])
  const brandSwatches = useColorSwatches()
  useEffect(() => {
    try {
      const raw = safeStorage.get(SAVED_COLORS_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const clean = parsed
          .filter((x): x is string => typeof x === 'string')
          .filter((x) => HEX_COLOR_RE.test(x))
          .slice(0, SAVED_COLORS_MAX)
        setSaved(clean)
        // Self-heal: if the filter dropped anything, write the cleaned
        // subset back so the next read doesn't waste cycles re-filtering.
        if (clean.length !== parsed.length) {
          try {
            safeStorage.set(SAVED_COLORS_KEY, JSON.stringify(clean))
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }, [])
  const persistSaved = useCallback((next: string[]) => {
    setSaved(next)
    try {
      safeStorage.set(SAVED_COLORS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }, [])

  // Working hex inside the popover. react-colorful emits onChange on
  // EVERY pointer event (60+/sec, NOT internally throttled — verified
  // against its bundled source). We buffer locally and coalesce the
  // upstream onChange to one call per animation frame so the outer
  // ZodForm tree doesn't re-render once per pointer-tick.
  const initialHex = useMemo(() => {
    if (!value) return '#C9A961'
    if (isColorToken(value)) return COLOR_TOKENS[value].hex
    return value
  }, [value])
  const [draftHex, setDraftHex] = useState<string>(initialHex)
  useEffect(() => {
    setDraftHex(initialHex)
  }, [initialHex])

  // RAF-coalesced upstream propagation. Stores the latest pending hex
  // in a ref; the first call schedules a flush; subsequent calls in
  // the same frame just overwrite the pending value. Flush calls
  // onChange once per frame max. Cleanup cancels the pending RAF on
  // unmount so we don't try to update state on a dead component.
  const rafRef = useRef<number | null>(null)
  const pendingHexRef = useRef<string | null>(null)
  const flushHex = useCallback(() => {
    rafRef.current = null
    const pending = pendingHexRef.current
    if (pending) {
      pendingHexRef.current = null
      onChange(pending)
    }
  }, [onChange])
  const queueHex = useCallback(
    (next: string) => {
      const normalised = next.toUpperCase()
      setDraftHex(normalised)
      pendingHexRef.current = normalised
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flushHex)
      }
    },
    [flushHex],
  )
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  // The swatch button shows the RESOLVED colour. resolveColorValue
  // returns a `var(--color-…)` string for token values, a hex literal
  // for custom values. We feed that straight into the inline style.
  const resolved = resolveColorValue(value)
  const swatchStyle = resolved
    ? { background: resolved }
    : {
        // Empty / undefined value — show the diagonal-stripe "no colour"
        // affordance so the operator knows nothing is set.
        background:
          'repeating-linear-gradient(45deg, rgba(245,241,234,0.06) 0 4px, rgba(245,241,234,0.16) 4px 8px)',
      }

  const hasEyedropper =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { EyeDropper?: unknown }).EyeDropper ===
      'function'

  const pickViaEyedropper = useCallback(async () => {
    // Suppress the Popover's outside-click handler while the OS-level
    // EyeDropper overlay is active — without this, a stray click on
    // the overlay can reach document.pointerdown and close the popover
    // before we can apply the sampled hex. The Popover reads this
    // body-level data attribute on every pointerdown.
    document.body.dataset.cavecmsPopoverSuppressOutside = '1'
    try {
      const Ctor = (
        window as unknown as {
          EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> }
        }
      ).EyeDropper
      if (!Ctor) return
      const eye = new Ctor()
      const result = await eye.open()
      const hex = result.sRGBHex.toUpperCase()
      setDraftHex(hex)
      onChange(hex)
    } catch {
      /* user cancelled — no-op */
    } finally {
      delete document.body.dataset.cavecmsPopoverSuppressOutside
    }
  }, [onChange])

  const addCurrentToSaved = useCallback(() => {
    if (!draftHex) return
    // Don't double-add tokens — they have their own row.
    if (saved.includes(draftHex)) return
    const next = [draftHex, ...saved].slice(0, SAVED_COLORS_MAX)
    persistSaved(next)
  }, [draftHex, saved, persistSaved])

  const removeFromSaved = useCallback(
    (hex: string) => {
      persistSaved(saved.filter((c) => c !== hex))
    },
    [saved, persistSaved],
  )

  const tokenOptions = useMemo(
    () =>
      tokenList.map((t) => ({
        value: t,
        label: COLOR_TOKENS[t].label,
        swatch: COLOR_TOKENS[t].hex,
      })),
    [tokenList],
  )

  const PickerSurface = allowAlpha ? HexAlphaColorPicker : HexColorPicker

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          {label}
        </span>
        {boundToken && (
          <span className="inline-flex items-center gap-1 rounded-full bg-copper-400/15 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.2em] text-copper-300">
            {COLOR_TOKENS[boundToken].label}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`${label} — open colour picker`}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="group relative h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-cream-50/15 transition-all duration-quick hover:scale-[1.03] hover:border-copper-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
          style={swatchStyle}
        >
          <span className="sr-only">Pick {label.toLowerCase()}</span>
        </button>

        {!hexOnly && (
          <GlobeBindButton<ColorToken>
            ariaLabel={`${label} — bind to brand colour token`}
            bound={
              boundToken
                ? { token: boundToken, label: COLOR_TOKENS[boundToken].label }
                : null
            }
            options={tokenOptions}
            onChooseToken={(t) => onChange(t)}
            onUnbind={() => {
              // Defensive guard: GlobeBindButton only renders the unbind
              // affordance when `bound` is non-null, but a fast click
              // could race the boundToken state. Bail rather than read
              // an arbitrary first-token fallback.
              if (!boundToken) return
              onChange(COLOR_TOKENS[boundToken].hex)
            }}
          />
        )}

        {/* Inline hex readout / clearer for ad-hoc custom values. */}
        {value && !boundToken && allowCustom && (
          <code className="font-mono text-[11px] uppercase tracking-widest text-warm-stone">
            {value}
          </code>
        )}

        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="ml-auto inline-flex items-center justify-center rounded-full p-1 text-warm-stone/70 transition-colors hover:bg-cream-50/10 hover:text-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
            aria-label="Clear colour"
            title="Clear colour"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

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
        {/* Token grid — the first thing the operator sees. Six luxury
            tokens by default; each is a clickable swatch with its
            label on hover. Selected token gets a copper ring. */}
        <div className="space-y-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
            Brand tokens
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {tokenList.map((t) => {
              const isActive = boundToken === t
              return (
                <button
                  key={t}
                  type="button"
                  title={COLOR_TOKENS[t].label}
                  aria-label={COLOR_TOKENS[t].label}
                  onClick={() => {
                    // hexOnly: emit the token's concrete hex (quick-start
                    // preset). Otherwise emit the token name (binding).
                    // Either way, don't close — operator may fine-tune via
                    // alpha or eyedropper after picking the base.
                    onChange(hexOnly ? COLOR_TOKENS[t].hex : t)
                  }}
                  className={
                    'h-9 w-9 rounded-lg border transition-all duration-quick hover:scale-[1.08] hover:border-copper-400/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
                    (isActive
                      ? 'border-copper-400 ring-2 ring-copper-400/40'
                      : 'border-cream-50/15')
                  }
                  style={{ background: COLOR_TOKENS[t].hex }}
                />
              )
            })}
          </div>
        </div>

        {allowCustom && (
          <>
            <div className="my-3 h-px bg-cream-50/10" />

            {/* SV square + hue + alpha (react-colorful). draftHex is
                buffered locally; upstream onChange is RAF-coalesced
                via queueHex so the form tree re-renders at most once
                per animation frame regardless of pointer rate.
                `color` prop is guarded against invalid hex so a
                mid-typing partial like `#` doesn't crash the picker
                (it would silently reset to #000). */}
            <div className="rcc-wrap [&_.react-colorful]:!w-full [&_.react-colorful]:!h-44 [&_.react-colorful__saturation]:rounded-lg [&_.react-colorful__hue]:rounded-md [&_.react-colorful__alpha]:rounded-md">
              <PickerSurface
                color={HEX_COLOR_RE.test(draftHex) ? draftHex : '#C9A961'}
                onChange={queueHex}
              />
            </div>

            {/* HEX input + eyedropper. The format-toggle is deferred —
                hex is unambiguous and luxury palettes always emit hex
                in design systems. Future: add a HEX/RGB/HSL cycle. */}
            <div className="mt-3 flex items-center gap-2">
              <label className="flex flex-1 items-center gap-2 rounded-lg border border-cream-50/15 bg-cream-50/[0.04] px-2.5 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50/55">
                  HEX
                </span>
                <input
                  type="text"
                  value={draftHex.replace(/^#/, '')}
                  onChange={(e) => {
                    const raw = e.target.value.trim()
                    const hex = ('#' + raw.replace(/[^0-9a-fA-F]/g, '')).toUpperCase()
                    setDraftHex(hex)
                    // Commit ONLY at full 6/8-char hex. Shorthand (4
                    // chars / #RGB) would commit `#C9A` as #CC99AA
                    // mid-typing while operator is reaching for the
                    // 4th char of #C9A961, causing a visible flash.
                    if (hex.length === 7 || hex.length === 9) {
                      onChange(hex)
                    }
                  }}
                  maxLength={8}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  className="!border-0 !bg-transparent !p-0 font-mono text-[12.5px] uppercase tracking-widest text-cream-50 placeholder:text-cream-50/30 focus:!ring-0 focus:!outline-none w-full"
                  placeholder="C9A961"
                />
              </label>

              {hasEyedropper && (
                <button
                  type="button"
                  onClick={pickViaEyedropper}
                  title="Sample from screen"
                  aria-label="Sample colour from screen"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-cream-50/15 text-cream-50/75 transition-all hover:border-copper-400 hover:bg-copper-400/10 hover:text-copper-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
                >
                  <Pipette className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>

            {/* Brand swatches (E18) — operator-defined global colours. */}
            {brandSwatches.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
                  Brand
                </div>
                <div className="grid grid-cols-8 gap-1.5">
                  {brandSwatches.map((s) => (
                    <button
                      key={s.label + s.color}
                      type="button"
                      onClick={() => {
                        setDraftHex(s.color)
                        onChange(s.color)
                      }}
                      title={`${s.label} — ${s.color}`}
                      aria-label={`Apply brand colour ${s.label}`}
                      className="h-7 w-7 rounded-md border border-cream-50/15 transition-all hover:scale-[1.08] hover:border-copper-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
                      style={{ background: s.color }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Saved colours row. */}
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
                  Saved
                </div>
                <button
                  type="button"
                  onClick={addCurrentToSaved}
                  disabled={!draftHex || saved.includes(draftHex)}
                  className="inline-flex items-center gap-1 rounded-full border border-cream-50/15 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-cream-50/70 transition-all hover:border-copper-400 hover:text-copper-300 disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
                >
                  <Plus className="h-2.5 w-2.5" aria-hidden />
                  Save current
                </button>
              </div>
              <div className="grid grid-cols-8 gap-1.5">
                {saved.length === 0 ? (
                  <div className="col-span-8 rounded-md border border-dashed border-cream-50/10 px-2 py-1.5 text-center text-[10px] text-cream-50/40">
                    Save up to {SAVED_COLORS_MAX} custom colours
                  </div>
                ) : (
                  saved.map((hex) => (
                    <span
                      key={hex}
                      className="group relative inline-block"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setDraftHex(hex)
                          onChange(hex)
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          removeFromSaved(hex)
                        }}
                        title={`${hex} — apply (right-click or ✕ to remove)`}
                        aria-label={`Apply saved colour ${hex}`}
                        className="h-7 w-7 rounded-md border border-cream-50/15 transition-all hover:scale-[1.08] hover:border-copper-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
                        style={{ background: hex }}
                      />
                      {/* Accessible delete affordance — keyboard +
                          touch operators can't right-click. The × is
                          hidden by default and revealed on hover/focus
                          of either the swatch or the × itself. */}
                      <button
                        type="button"
                        onClick={() => removeFromSaved(hex)}
                        aria-label={`Remove saved colour ${hex}`}
                        className="absolute -right-1.5 -top-1.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-near-black text-cream-50 opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-copper-400"
                      >
                        <X className="h-2 w-2" aria-hidden />
                      </button>
                    </span>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </Popover>
    </div>
  )
}
