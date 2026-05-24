'use client'

import clsx from 'clsx'
import { Lock } from 'lucide-react'
import type { SearchHit, SearchableItem } from '@/lib/cms/blockSearch'

// Chunk I — shared result list rendered by BOTH the ⌘K palette and the
// caret-anchored / popover. The component is CONTROLLED — it owns no
// state. The parent (SlashCommandPalette / SlashCommandInline) owns:
//   - the query string
//   - the active index (arrow-key navigation)
//   - the activation handler (Enter / click)
//
// This split keeps the rendering surface a pure visual element with no
// keyboard listeners of its own — global keyboard handling lives in the
// parent surfaces so palette and inline can each have their own scope
// (the palette closes on Esc; the inline restores caret on Esc, etc.).
//
// Visual treatment (consistent with ContextMenu / EditDrawer dark theme):
//   - bg transparent — parent supplies the panel chrome
//   - row: 44px min-height (project standards touch rule), rounded-xl
//   - active: bg-copper-500/15 ring-1 ring-copper-400/40 text-cream-50
//   - disabled (Templates stub): opacity-50 + Lock icon
//   - icon: copper-tinted in a 6×6 rounded square, mirrors ContextMenu
//   - alias chip: shown only when match landed via alias, copper outline
//     pill rendered right of the label

export interface BlockSearchResultsProps {
  /** Sorted hits — caller already capped at MAX_RESULTS via searchBlocks(). */
  hits: SearchHit[]
  /** Which row is keyboard-active. Should be 0 when hits.length > 0 by
   *  default; parent must clamp on hits change. -1 valid when hits is
   *  empty + the parent is showing a "no matches" hint. */
  activeIndex: number
  /** Activation handler. Called on row click + parent's Enter keystroke.
   *  Caller is responsible for: skipping disabled items, closing the
   *  surface, dispatching insertBlock(). */
  onSelect: (item: SearchableItem) => void
  /** Mouse-enter sets activeIndex (mirrors ContextMenu hover-to-focus).
   *  Parent owns the state, so this is just an event hop. */
  onHover: (index: number) => void
  /** Element id used as the listbox + per-row id stem. Lets the parent
   *  wire aria-activedescendant on the search input for AT users without
   *  moving DOM focus off the input. */
  idStem: string
  /** When true, renders against a near-black dark panel (palette + inline
   *  both today). Reserved knob so a future light-panel host can flip
   *  the row palette without a parallel component. */
  dark?: boolean
  /** Shown above the result rows. Defaults to undefined (no header).
   *  The palette passes "Suggestions" / "Results for '<q>'", the inline
   *  passes nothing (caret-anchored space is precious). */
  header?: string
  /** Optional empty-hint string rendered when hits.length === 0. The
   *  Notion-equivalent of "No matches for 'xyz' — try a different
   *  word". Parent decides whether to render this. */
  emptyHint?: string
}

export function BlockSearchResults({
  hits,
  activeIndex,
  onSelect,
  onHover,
  idStem,
  dark = true,
  header,
  emptyHint,
}: BlockSearchResultsProps) {
  // Empty state — surfaced only when the parent passes an emptyHint.
  // Without an empty hint the parent typically hides the result region
  // entirely (cleaner for the inline popover, which would otherwise
  // float a tiny "no matches" tile over the operator's text).
  if (hits.length === 0) {
    if (!emptyHint) return null
    return (
      <div
        role="status"
        aria-live="polite"
        className={clsx(
          'px-3 py-4 text-center text-[12px]',
          dark ? 'text-cream-50/55' : 'text-warm-stone',
        )}
      >
        {emptyHint}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {header && (
        <p
          className={clsx(
            'px-2 pt-1.5 pb-1 text-[9px] font-semibold uppercase tracking-[0.22em]',
            dark ? 'text-cream-50/55' : 'text-warm-stone',
          )}
        >
          {header}
        </p>
      )}
      <ul
        role="listbox"
        id={idStem}
        aria-label="Block search results"
        className="flex flex-col gap-0.5"
      >
        {hits.map((hit, i) => {
          const it = hit.item
          const Icon = it.icon
          const isActive = i === activeIndex
          const isDisabled = it.disabled === true
          const optionId = `${idStem}-opt-${i}`
          return (
            <li key={it.id}>
              <button
                id={optionId}
                type="button"
                role="option"
                aria-selected={isActive}
                aria-disabled={isDisabled}
                // Use aria-disabled only — native `disabled` removes
                // the button from the AT tree in some screen readers
                // (NVDA / JAWS handle aria-selected on a natively-
                // disabled element inconsistently). The onClick guard
                // below covers the activation block.
                title={isDisabled ? it.disabledReason : undefined}
                // Mouse-enter sets activeIndex so the visual highlight
                // tracks the cursor. The parent owns the state — onHover
                // is just an event hop. Disabled rows STILL update
                // activeIndex (matches ContextMenu) so the operator can
                // see "this row exists but isn't usable yet".
                onMouseEnter={() => onHover(i)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!isDisabled) onSelect(it)
                }}
                // tabIndex=-1 — keyboard nav is via the parent's input,
                // not DOM Tab order. aria-activedescendant on the input
                // points at this row's id when isActive.
                tabIndex={-1}
                className={clsx(
                  'group flex w-full min-h-[44px] items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-quick ease-standard focus-visible:outline-none motion-reduce:transition-none',
                  isDisabled && 'cursor-not-allowed opacity-50',
                  isActive && !isDisabled
                    ? dark
                      ? 'bg-copper-500/15 ring-1 ring-copper-400/40'
                      : 'bg-copper-50 ring-1 ring-copper-400/40'
                    : dark
                      ? 'hover:bg-cream-50/8'
                      : 'hover:bg-warm-stone/8',
                )}
              >
                {/* Icon — copper accent square. Lock icon swaps in for
                    disabled (Templates stub) so the affordance is
                    visually distinct without needing colour-only cues. */}
                <span
                  aria-hidden="true"
                  className={clsx(
                    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1',
                    isDisabled
                      ? dark
                        ? 'bg-cream-50/8 text-cream-50/40 ring-cream-50/15'
                        : 'bg-warm-stone/15 text-warm-stone ring-warm-stone/25'
                      : dark
                        ? 'bg-copper-500/20 text-copper-300 ring-copper-400/30'
                        : 'bg-copper-500/15 text-copper-500 ring-copper-400/30',
                  )}
                >
                  {isDisabled ? (
                    <Lock size={11} strokeWidth={2.4} />
                  ) : (
                    <Icon size={13} strokeWidth={2.2} />
                  )}
                </span>

                {/* Label + description column. min-w-0 lets truncate
                    work inside the flex parent. */}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'truncate text-[13px] font-semibold',
                        dark ? 'text-cream-50' : 'text-near-black',
                      )}
                    >
                      {it.label}
                    </span>
                    {/* Alias chip — visible ONLY when match landed via
                        an alias (matchedAlias populated). The chip shows
                        the matched alias verbatim ("matched via: h1")
                        so operators learn the shorthand. */}
                    {hit.matchedAlias && (
                      <span
                        className={clsx(
                          'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.16em]',
                          dark
                            ? 'border border-copper-400/40 text-copper-300'
                            : 'border border-copper-400/40 text-copper-500',
                        )}
                      >
                        {hit.matchedAlias}
                      </span>
                    )}
                  </span>
                  <span
                    className={clsx(
                      'truncate text-[11px]',
                      dark ? 'text-cream-50/55' : 'text-warm-stone',
                    )}
                  >
                    {it.description}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
