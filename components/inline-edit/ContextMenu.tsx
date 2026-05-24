'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  type MenuContext,
  type MenuItem,
} from '@/lib/cms/contextMenuActions'

// Chunk H — portal-mounted dark-toned right-click menu. Pure UI: takes
// the resolved item list + the runtime ctx + viewport coords, renders,
// and routes keyboard / mouse activations through to item.handler. The
// ContextMenuProvider owns the lifecycle (mount, dismissal, focus
// restore) — this component is intentionally stateless beyond its own
// active-index + measured-position cache.
//
// Visual design tracks the EditDrawer's dark restyle (Chunk D):
//   - bg-near-black/97 panel + backdrop-blur
//   - cream-50/12 hairline border + a soft shadow
//   - copper icon accent on non-destructive items
//   - red-300 text + red-500/15 hover on destructive items
//   - 44px min-height per project standards mobile touch-target rule
//
// Keyboard model (mirrors Figma + Framer + Wix):
//   - Esc                  → close + focus restore (provider handles)
//   - ArrowDown / ArrowUp  → cycle non-disabled items
//   - Home / End           → jump to first / last non-disabled item
//   - Enter / Space        → activate the active item
//   - Mouse hover          → updates activeIdx for keyboard parity
//
// Position model:
//   - The provider supplies viewport coords (e.clientX/Y).
//   - useLayoutEffect measures the rendered panel and flips to the
//     LEFT / TOP edge anchor if the panel would overflow the viewport.
//     8px gutter from the viewport edges to leave breathing room.

interface Props {
  items: MenuItem[]
  ctx: MenuContext
  coords: { x: number; y: number }
  ariaLabel: string
}

export function ContextMenu({ items, ctx, coords, ariaLabel }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  // pos is the FINAL render coords after clamp. Null until the
  // useLayoutEffect lands; the panel renders with `visibility: hidden`
  // in the meantime so we never paint at the raw (potentially
  // overflowing) coords for a single frame.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  // Resolve the disabled-mask ONCE per (items, ctx) identity. Some
  // disabled() predicates do DOM walks (isFirstWidgetSibling /
  // isLastWidgetSibling) — without memoisation each render of the
  // menu would re-walk the DOM on every item × 4 read sites
  // (renderer, focus useEffect, moveActive, jumpToBoundary).
  const resolved = useMemo(
    () =>
      items.map((item) => ({
        item,
        disabled: item.disabled?.(ctx) ?? false,
      })),
    [items, ctx],
  )

  // First-enabled index — recomputed from the resolved mask. Stable
  // until `resolved` identity changes.
  const firstEnabledIdx = useCallback((): number => {
    for (let i = 0; i < resolved.length; i += 1) {
      if (!resolved[i]!.disabled) return i
    }
    return -1
  }, [resolved])

  // Chunk H R2: reset activeIdx when items identity changes. Without
  // this, a menu kind transition (operator right-clicks one widget,
  // then immediately right-clicks a different widget WITHOUT closing)
  // keeps the prior activeIdx — potentially out-of-range for the new
  // kind's item list, or pointing at a now-disabled item. The
  // ContextMenu component doesn't unmount across that transition (the
  // provider's `active` state goes non-null → non-null), so the
  // useState initializer doesn't fire a second time.
  const [activeIdx, setActiveIdx] = useState(() => firstEnabledIdx())
  useEffect(() => {
    setActiveIdx(firstEnabledIdx())
  }, [firstEnabledIdx])

  // ── Position clamp ──
  // Dep on `items` (not items.length) so a kind transition with the
  // same item count but different label widths re-measures + re-clamps.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let x = coords.x
    let y = coords.y
    if (x + rect.width > vw - 8) x = Math.max(8, vw - rect.width - 8)
    if (y + rect.height > vh - 8) y = Math.max(8, vh - rect.height - 8)
    // Floor to avoid sub-pixel render. Important on devices where
    // the cursor reports fractional coords (Apple Pencil, high-DPI
    // displays under macOS smoothing).
    setPos({ x: Math.floor(x), y: Math.floor(y) })
  }, [coords.x, coords.y, items])

  // ── Focus the active item once the position lands. ──
  // Read `resolved` via a ref so the effect doesn't depend on its
  // identity. Including `resolved` in the deps would refocus on every
  // ctx / items churn — stealing focus from operators who Tab to a
  // non-active item.
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved
  useEffect(() => {
    if (pos === null) return
    if (activeIdx < 0) return
    const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    )
    if (!buttons) return
    const items = resolvedRef.current
    // The active index counts ALL items; the query selector skips
    // disabled. Find the n-th enabled match.
    let countedEnabled = 0
    for (let i = 0; i < items.length; i += 1) {
      if (!items[i]!.disabled) {
        if (i === activeIdx) {
          buttons[countedEnabled]?.focus()
          return
        }
        countedEnabled += 1
      }
    }
  }, [activeIdx, pos])

  const moveActive = useCallback(
    (delta: 1 | -1) => {
      const n = resolved.length
      if (n === 0) return
      let next = activeIdx
      for (let step = 0; step < n; step += 1) {
        next = (next + delta + n) % n
        if (!resolved[next]!.disabled) {
          setActiveIdx(next)
          return
        }
      }
    },
    [activeIdx, resolved],
  )

  const jumpToBoundary = useCallback(
    (end: 'first' | 'last') => {
      if (end === 'first') {
        for (let i = 0; i < resolved.length; i += 1) {
          if (!resolved[i]!.disabled) {
            setActiveIdx(i)
            return
          }
        }
      } else {
        for (let i = resolved.length - 1; i >= 0; i -= 1) {
          if (!resolved[i]!.disabled) {
            setActiveIdx(i)
            return
          }
        }
      }
    },
    [resolved],
  )

  // Double-fire guard: an async handler that doesn't synchronously
  // clear can be re-entered if the operator double-presses Enter
  // (or double-clicks) inside a single frame. Two POSTs to the
  // duplicate endpoint would each succeed and the page would
  // suddenly have TWO duplicates of the same source.
  const firingRef = useRef(false)
  const activate = useCallback(
    (i: number) => {
      if (firingRef.current) return
      const it = resolved[i]
      if (!it || it.disabled) return
      firingRef.current = true
      void Promise.resolve(it.item.handler(ctx)).finally(() => {
        firingRef.current = false
      })
    },
    [ctx, resolved],
  )

  // ── Keyboard handler. Lives on the panel via onKeyDown, NOT a
  // global document listener — the provider owns its own Esc + outside-
  // click handlers. Capturing globally here would race with the
  // provider's listeners. ──
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        moveActive(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        moveActive(-1)
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        e.stopPropagation()
        jumpToBoundary('first')
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        jumpToBoundary('last')
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        activate(activeIdx)
        return
      }
      // Esc is intentionally NOT handled here — the provider's
      // document-level keydown listener owns dismissal so the focus
      // restore on Esc works whether or not the menu has focus.
    },
    [activeIdx, activate, moveActive, jumpToBoundary],
  )

  // Pre-clamp render: an invisible panel at (0, 0) so useLayoutEffect
  // can measure it. Once clamped, we render at the final coords.
  const visible = pos !== null

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // contextmenu inside the menu itself should NOT re-trigger the
      // page-level contextmenu handler (would open a nested menu on
      // top of this one). preventDefault + stop here keeps the OS
      // menu suppressed inside the panel.
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      style={{
        position: 'fixed',
        top: pos?.y ?? 0,
        left: pos?.x ?? 0,
        visibility: visible ? 'visible' : 'hidden',
      }}
      className="z-[80] w-[240px] max-w-[calc(100vw-16px)] rounded-2xl border border-cream-50/12 bg-near-black/[0.97] p-1.5 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md animate-bwc-fade-in motion-reduce:animate-none"
    >
      <ul className="flex flex-col gap-0.5">
        {resolved.map(({ item: it, disabled: isDisabled }, i) => {
          const Icon = it.icon
          const isActive = i === activeIdx
          const showSeparator = it.separatorAbove === true && i > 0
          return (
            <li key={it.id}>
              {showSeparator && (
                <div
                  role="separator"
                  aria-hidden="true"
                  className="mx-1.5 my-1 h-px bg-cream-50/10"
                />
              )}
              <button
                type="button"
                role="menuitem"
                aria-disabled={isDisabled}
                disabled={isDisabled}
                tabIndex={isActive && !isDisabled ? 0 : -1}
                onMouseEnter={() => {
                  if (!isDisabled) setActiveIdx(i)
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  activate(i)
                }}
                className={clsx(
                  'flex w-full min-h-[44px] items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors duration-quick ease-standard focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none',
                  it.destructive
                    ? 'text-red-200 hover:bg-red-500/15 focus-visible:bg-red-500/15'
                    : 'text-cream-50 hover:bg-cream-50/10 focus-visible:bg-cream-50/10',
                )}
              >
                {Icon && (
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                      it.destructive
                        ? 'bg-red-500/20 text-red-200'
                        : 'bg-copper-500/20 text-copper-300',
                    )}
                  >
                    <Icon size={14} strokeWidth={2.2} />
                  </span>
                )}
                <span className="flex-1 truncate">{it.label}</span>
                {it.kbdHint && (
                  <span
                    aria-hidden="true"
                    className="ml-auto font-mono text-[10px] tracking-wide text-cream-50/40"
                  >
                    {it.kbdHint}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>,
    document.body,
  )
}
