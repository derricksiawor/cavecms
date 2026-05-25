'use client'

import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import clsx from 'clsx'
import {
  FIRST_TIER,
  SPACING_TIER_LABEL,
  isSpacingTier,
  type SpacingTier,
} from '@/lib/cms/spacingTokens'
import type { SpacingValue } from '@/lib/cms/spacingClasses'

// Numeric input bounds. Padding stays 0..512 (negative padding is
// invalid CSS — browsers clamp it to 0 silently which reads as broken).
// Margin opens up to -512..512 so the operator can pull elements
// up/left to overlap heros, tuck cards under headers, etc. Mirrors
// the per-axis bounds enforced in blockMeta.ts so a value typed here
// can't be wider than the server will accept.
const MAX_PX = 512
const MIN_PADDING_PX = 0
const MIN_MARGIN_PX = -512

// Single per-side tier control. ⬆ steps up the tier scale; ⬇ steps
// down; both clamp at the endpoints. The current tier label sits
// between the buttons. Buttons are 44×44 per project standards mobile rules.
// Keyboard: ArrowUp / ArrowDown on the label step the tier — focus
// stays on the label so a fast operator can chain steps with one
// hand on the keyboard.
//
// The stepper is "controlled" in the React sense (value + onChange);
// the toolbar that owns it tracks the in-flight tier so a debounced
// auto-save can coalesce rapid step clicks into one PATCH.
//
// NOTE: the stepper does NOT disable on the parent's busy flag. The
// 400ms debounce + AbortController in SpacingToolbar already coalesce
// rapid clicks safely (latest click wins, in-flight requests get
// cancelled). Disabling on busy would defeat that design + block
// fast-typists from chaining steps.

export interface SpacingStepperProps {
  /** Side label rendered above the buttons (T / R / B / L). */
  sideLabel: string
  /** Current tier OR numeric px value. undefined → 'none' display,
   *  treated as 'none' on step. */
  value: SpacingValue | undefined
  /** Emit a tier / px number to set this axis, OR undefined to DROP
   *  the override entirely (operator clears the px input → revert to
   *  the wrapper's natural padding rather than persisting an explicit
   *  '!pt-0' tier). The parent treats undefined as "remove this axis
   *  from the meta blob". */
  onChange: (next: SpacingValue | undefined) => void
  /** Which axis this stepper edits. Padding rejects negative px
   *  (invalid CSS); margin accepts -512..512 so the operator can
   *  pull elements to overlap. */
  axis: 'padding' | 'margin'
  /** When provided, the tier-label span captures this ref so a parent
   *  (the popover) can focus the first stepper's label on mount —
   *  ArrowUp/Down keyboard nav works immediately without a click. */
  labelRef?: React.RefObject<HTMLSpanElement | null>
}

// Tier-to-px lookup so we can recognise when a numeric step lands
// back on a preset value and snap to its tier (cleaner UX than a
// chip that drifts forever in numeric mode).
const TIER_TO_PX: Record<SpacingTier, number> = {
  none: 0,
  xs: 8,
  sm: 16,
  md: 32,
  lg: 64,
  xl: 96,
  '2xl': 128,
}
const PX_TO_TIER: Map<number, SpacingTier> = new Map(
  (Object.entries(TIER_TO_PX) as [SpacingTier, number][]).map(([t, n]) => [n, t]),
)
// Numeric step size used past the tier endpoints. 8px is the
// smallest tier increment — matches the operator's intuition for
// "one click smaller / larger".
const NUMERIC_STEP_PX = 8

/** Step from `current` by `dir` (1 or -1). Walks the tier scale
 *  when inside it; spills into px mode past either endpoint so the
 *  operator can keep clicking past 'none' into negatives (margin
 *  only) or past '2xl' to ~512px. When a numeric step lands on a
 *  preset value, snaps back to that tier. */
function stepSpacing(
  current: SpacingValue,
  dir: 1 | -1,
  axis: 'padding' | 'margin',
): SpacingValue {
  const minPx = axis === 'margin' ? MIN_MARGIN_PX : MIN_PADDING_PX
  const currentPx = typeof current === 'number' ? current : TIER_TO_PX[current]
  const candidatePx = currentPx + dir * NUMERIC_STEP_PX
  const clamped = Math.max(minPx, Math.min(MAX_PX, candidatePx))
  const snapTier = PX_TO_TIER.get(clamped)
  if (snapTier) return snapTier
  return clamped
}

// sessionStorage key for the once-per-session "↓ for negative" hint
// dismissal. Margin-only — padding can't go negative, so the hint
// never shows there. Stored at the session level so the operator who
// dismisses on side A doesn't get re-prompted on side B in the same
// edit session; survives navigation but resets on full reload (matches
// the in-memory clipboard's lifecycle expectations).
const NEGATIVE_HINT_KEY = 'cavecms:spacing-negative-hint-seen'

export function SpacingStepper({
  sideLabel,
  value,
  onChange,
  axis,
  labelRef,
}: SpacingStepperProps) {
  const minPx = axis === 'margin' ? MIN_MARGIN_PX : MIN_PADDING_PX
  // Tier branch when value is a known tier OR undefined; px branch
  // when value is a number. The chip displays whichever mode is
  // active; up/down walk a unified scale (tier → tier → px past the
  // endpoints) via stepSpacing.
  const tier: SpacingTier = isSpacingTier(value) ? value : 'none'
  const pxValue: number | null = typeof value === 'number' ? value : null
  const current: SpacingValue = value ?? 'none'
  // Up disabled at MAX_PX; down disabled at the axis floor. Both
  // branches cover the tier-mode floor AND the px-mode floor —
  // without the px-mode case, the down button stays enabled at 0px
  // padding even though stepSpacing clamps the result to 0 (next
  // === current → onChange short-circuits → silent no-op).
  const upDisabled = pxValue !== null && pxValue >= MAX_PX
  const downDisabled =
    axis === 'padding'
      ? pxValue === 0 || (pxValue === null && tier === FIRST_TIER)
      : pxValue !== null && pxValue <= MIN_MARGIN_PX

  // Local input state — operators may type partial numbers ('1', '12',
  // '-', '-2') before settling on the final value. Sync to the prop
  // on external changes (button click, sibling Apply-to-all, reset).
  const [draft, setDraft] = useState<string>(
    pxValue !== null ? String(pxValue) : '',
  )
  useEffect(() => {
    setDraft(pxValue !== null ? String(pxValue) : '')
  }, [pxValue])

  const step = (dir: 1 | -1) => {
    const next = stepSpacing(current, dir, axis)
    if (next === current) return
    onChange(next)
  }

  // Negative-tier discovery affordance. Operators don't intuit that
  // pressing the down arrow past 'none' walks into negative px on
  // margin — the prior UX was "drop into the numeric input and type
  // '-12'", which most operators never tried. Show a faint "↓ for
  // negative" hint below the down arrow when the axis is margin AND
  // the current value is at the floor (tier 'none' or px === 0). One-
  // time per session: sessionStorage gate so dismissal sticks across
  // sibling steppers AND across nav within the session.
  const [hintDismissed, setHintDismissed] = useState<boolean>(true)
  useEffect(() => {
    // Hydration-safe read: sessionStorage is only on window. Default to
    // dismissed (hint hidden) during SSR so first paint matches.
    if (typeof window === 'undefined') return
    try {
      setHintDismissed(
        window.sessionStorage.getItem(NEGATIVE_HINT_KEY) === '1',
      )
    } catch {
      // Private-browsing / quota errors leave the gate dismissed —
      // showing a hint that can't be dismissed permanently is worse
      // than showing none.
      setHintDismissed(true)
    }
  }, [])
  const dismissHint = () => {
    setHintDismissed(true)
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(NEGATIVE_HINT_KEY, '1')
      } catch {
        // Best-effort persistence. Local state already updated; the
        // hint stays gone for THIS stepper instance even if storage
        // refused the write.
      }
    }
  }
  const atFloor =
    pxValue === 0 || (pxValue === null && tier === FIRST_TIER)
  const showNegativeHint =
    axis === 'margin' && atFloor && !hintDismissed && !downDisabled

  const commitPx = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      // Empty input — drop the override entirely so the wrapper's
      // natural padding takes over. Operator clears the input to
      // "reset this side". undefined tells the parent to remove this
      // axis from the meta blob; passing 'none' would persist an
      // explicit !pt-0 tier (visually identical to 0px BUT it beats
      // the wrapper's natural padding via !important — not the
      // operator's intent when clearing the input).
      onChange(undefined)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || !Number.isInteger(n)) return
    const clamped = Math.max(minPx, Math.min(MAX_PX, n))
    onChange(clamped)
  }

  return (
    <div className="flex flex-col items-center gap-1.5">
      <span
        aria-hidden="true"
        className="text-[9px] font-semibold uppercase tracking-[0.22em] text-cream-50/55"
      >
        {sideLabel}
      </span>
      <button
        type="button"
        aria-label={`Increase ${sideLabel} spacing`}
        disabled={upDisabled}
        onClick={() => step(1)}
        className={clsx(
          'inline-flex h-11 w-11 items-center justify-center rounded-full text-cream-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400',
          'hover:bg-cream-50/10',
          'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
        )}
      >
        <ChevronUp size={14} strokeWidth={2.4} aria-hidden="true" />
      </button>
      <span
        ref={labelRef}
        role="status"
        aria-live="polite"
        aria-label={
          pxValue !== null
            ? `${sideLabel} spacing: ${pxValue} pixels`
            : `${sideLabel} spacing: ${SPACING_TIER_LABEL[tier]}`
        }
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            step(1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            step(-1)
          }
        }}
        className="inline-flex h-7 min-w-[44px] items-center justify-center rounded-md bg-cream-50/8 px-2 text-[11px] font-semibold tracking-wide text-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
      >
        {pxValue !== null ? `${pxValue}px` : SPACING_TIER_LABEL[tier]}
      </span>
      {/* Numeric override input. Type a px value (0..512) to override
          the preset tier with an arbitrary number. Clear the input to
          revert to a tier preset via the up/down buttons. Commit on
          blur or Enter so the auto-save debounce doesn't fire on every
          keystroke. */}
      <input
        type="number"
        // inputMode="numeric" for both axes. iOS Safari has no
        // inputMode value that combines a numpad with a minus key;
        // inputMode="text" would surface a full text keyboard (wrong
        // affordance for a numeric field). type="number" already
        // accepts '-' from any keyboard (software or hardware), so
        // the right tradeoff is "numpad on touch, sign handled by
        // type=number". Operators on iOS without a hardware keyboard
        // who need to type a negative margin can switch to the
        // hardware key, paste, or use the down stepper which walks
        // into negatives past 'none'.
        inputMode="numeric"
        min={minPx}
        max={MAX_PX}
        step={1}
        value={draft}
        placeholder="px"
        aria-label={`${sideLabel} spacing in pixels`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commitPx(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitPx(e.currentTarget.value)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
        className="h-7 w-[44px] rounded-md bg-cream-50/8 px-1.5 text-center text-[11px] font-semibold text-cream-50 placeholder:text-cream-50/35 focus:bg-cream-50/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label={`Decrease ${sideLabel} spacing`}
        disabled={downDisabled}
        onClick={() => step(-1)}
        className={clsx(
          'inline-flex h-11 w-11 items-center justify-center rounded-full text-cream-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400',
          'hover:bg-cream-50/10',
          'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
        )}
      >
        <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" />
      </button>
      {showNegativeHint && (
        <button
          type="button"
          onClick={dismissHint}
          aria-label="Dismiss hint: press down for negative margin"
          title="Press down for negative margin. Click to dismiss."
          className="inline-flex items-center gap-1 rounded-sm px-1 text-[8.5px] font-medium uppercase tracking-[0.18em] text-copper-300/75 transition-colors hover:text-copper-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 motion-safe:animate-cavecms-fade-in"
        >
          <ChevronDown size={9} strokeWidth={2.4} aria-hidden="true" />
          <span>negative</span>
        </button>
      )}
    </div>
  )
}
