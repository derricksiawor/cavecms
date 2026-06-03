'use client'
import { useId, type RefObject } from 'react'
import clsx from 'clsx'
import { VARIABLE_GROUPS } from '@/lib/seo/templates/variables'
import type {
  TemplateVariable,
  TemplateVariableGroup,
} from '@/lib/seo/templates/types'

// A grouped palette of clickable `%variable%` chips. Clicking a chip
// inserts that token into a bound input/textarea AT THE CARET (so an
// operator who clicks mid-string gets the token where they expect it,
// not appended), then restores focus + places the caret right after the
// inserted token.
//
// Two ways to wire it (the parent picks one):
//   1. Controlled-input mode — pass `targetRef` (the <input>/<textarea>
//      element ref) AND `onChange(nextValue)`. The chip computes the
//      caret-aware splice and hands the parent the new string; the parent
//      updates its controlled state. This is the primary mode used by the
//      Titles & Meta editor.
//   2. Callback mode — pass `onInsert(token)` and handle insertion
//      yourself. Used when the caller manages the textarea differently.
//
// Human-readable group headings keep the palette scannable; each chip
// carries the variable's label as its title so the token's meaning is one
// hover away.

const GROUP_LABEL: Record<TemplateVariableGroup, string> = {
  basic: 'Basics',
  date: 'Dates',
  taxonomy: 'Taxonomy',
  author: 'Author',
  special: 'Archives & search',
}

export function VariableInserter({
  targetRef,
  onChange,
  onInsert,
  /** Limit the palette to these groups (e.g. a title field hides the
   *  pagination tokens). Defaults to every group. */
  groups,
  className,
}: {
  targetRef?: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  onChange?: (nextValue: string) => void
  onInsert?: (token: string) => void
  groups?: TemplateVariableGroup[]
  className?: string
}) {
  const labelId = useId()

  function insert(token: string) {
    // Controlled-input mode: splice the token in at the caret and hand
    // the new string back to the parent, then restore focus + caret.
    const el = targetRef?.current
    if (el && onChange) {
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const next = el.value.slice(0, start) + token + el.value.slice(end)
      onChange(next)
      // Restore focus + place the caret just after the inserted token on
      // the next frame (after React commits the controlled value).
      const caret = start + token.length
      requestAnimationFrame(() => {
        el.focus()
        try {
          el.setSelectionRange(caret, caret)
        } catch {
          // Some input types disallow setSelectionRange — ignore; the
          // value still updated correctly.
        }
      })
      return
    }
    // Callback mode.
    onInsert?.(token)
  }

  const order: TemplateVariableGroup[] =
    groups ?? ['basic', 'date', 'taxonomy', 'author', 'special']

  return (
    <div className={clsx('space-y-3', className)}>
      <p
        id={labelId}
        className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone"
      >
        Insert a variable
      </p>
      <div className="space-y-2.5" aria-labelledby={labelId}>
        {order.map((group) => {
          const vars: TemplateVariable[] = VARIABLE_GROUPS[group] ?? []
          if (vars.length === 0) return null
          return (
            <div key={group}>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-warm-stone/70">
                {GROUP_LABEL[group]}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {vars.map((v) => (
                  <button
                    key={v.token}
                    type="button"
                    title={v.label}
                    // Insert on MOUSEDOWN, not click: a click fires AFTER
                    // the target input has already blurred (mousedown moves
                    // focus to the button first), so by click-time
                    // el.selectionStart has collapsed to end-of-string and
                    // the token appends instead of splicing at the caret.
                    // preventDefault() on mousedown stops the focus shift, so
                    // the target keeps focus + its live caret. This does NOT
                    // block keyboard activation (no mousedown on Enter/Space),
                    // which we handle explicitly via onKeyDown so the chip
                    // stays operable without a pointer.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      insert(v.token)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        insert(v.token)
                      }
                    }}
                    className="inline-flex items-center rounded-lg border border-warm-stone/25 bg-cream-50/80 px-2.5 py-1.5 font-mono text-[11px] text-near-black transition-all duration-quick ease-standard hover:border-copper-400 hover:bg-copper-500/10 hover:text-copper-700 cavecms-focus-ring"
                  >
                    {v.token}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
