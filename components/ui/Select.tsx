'use client'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'

// Custom listbox-style select. Replaces the native <select> element so
// the dropdown popup honours the drawer's dark tone (Cream / Near
// black / Copper tint instead of the OS's bright Mac-blue selection
// chrome — audit follow-up "dropdowns are terrible"). Native <select>
// CAN have its trigger styled, but the popup is rendered by the OS
// outside the page's CSS reach — only a custom listbox closes that
// gap.
//
// ARIA: WAI-ARIA "Combobox With Listbox Popup" pattern (button +
// `aria-controls` → `role="listbox"`). Focus stays on the trigger
// for the entire interaction; the listbox is keyboard-driven via the
// trigger's onKeyDown, with `aria-activedescendant` pointing at the
// highlighted option. This avoids the focus-shuffle anti-pattern.
//
// Keyboard contract:
//   - Closed: Enter / Space / ArrowDown opens at the selected option
//     (or 0 if none). ArrowUp opens at the last option (matches the
//     native <select> convention).
//   - Open: ArrowUp/Down step, Home/End jump, Enter/Space commit, Esc
//     close-without-commit, Tab commit-and-tab-out, type-ahead jumps
//     to the first option whose label starts with the typed buffer
//     (500ms reset).

export interface SelectOption {
  value: string
  label: string
}

/**
 * Designed for short enum lists (typically ≤ 50 options — alignment,
 * columns, background tone, etc.). Renders every option to the DOM
 * (no virtualization); the panel is capped at 320px scroll-overflow.
 * If a future caller needs to drive a long list (countries, time
 * zones, blocks-on-page), reach for a virtualized combobox instead.
 * Post-agent-review A2 (Chunk K).
 */
export interface SelectProps {
  value: string | null
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** Optional hidden-input name — lets the select participate in a
   *  legacy <form> POST. Not used by ZodForm (controlled state) but
   *  cheap to support. */
  name?: string
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  /** Tone resolution: 'auto' (default) inspects the nearest
   *  `data-drawer-tone` ancestor — used by EditDrawer's dark surface
   *  + MediaPickerModal's light surface without prop drilling. */
  tone?: 'auto' | 'light' | 'dark'
}

export function Select({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  disabled = false,
  name,
  id,
  tone = 'auto',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
}: SelectProps) {
  const generatedId = useId()
  const triggerId = id ?? `bwc-select-${generatedId}`
  const listboxId = `${triggerId}-listbox`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(-1)
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
    placement: 'below' | 'above'
  } | null>(null)
  const [resolvedTone, setResolvedTone] = useState<'light' | 'dark'>(
    tone === 'auto' ? 'light' : tone,
  )
  // Suppress SSR portal render — `document` doesn't exist on the
  // server and the listbox is conditionally rendered behind `open`
  // anyway. The mount latch prevents a brief flash of unstyled
  // option list on first hydration.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (tone !== 'auto') {
      setResolvedTone(tone)
      return
    }
    if (!triggerRef.current) return
    const ancestor = triggerRef.current.closest(
      '[data-drawer-tone]',
    ) as HTMLElement | null
    if (ancestor) {
      setResolvedTone(
        ancestor.dataset['drawerTone'] === 'dark' ? 'dark' : 'light',
      )
    }
  }, [tone])

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex]! : null

  const positionListbox = useCallback(() => {
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const viewportH = window.innerHeight
    const spaceBelow = viewportH - r.bottom
    const spaceAbove = r.top
    // Cap at 320px tall so a 50-option list doesn't fill the
    // viewport; the listbox scrolls internally beyond that.
    const estimatedHeight = Math.min(options.length * 40 + 12, 320)
    const placement: 'below' | 'above' =
      spaceBelow < estimatedHeight && spaceAbove > spaceBelow
        ? 'above'
        : 'below'
    setPosition({
      top:
        placement === 'below' ? r.bottom + 6 : r.top - 6 - estimatedHeight,
      left: r.left,
      width: r.width,
      placement,
    })
  }, [options.length])

  const openListbox = useCallback(
    (initial: 'first' | 'last' | 'selected' = 'selected') => {
      if (disabled) return
      const initialIdx =
        initial === 'last'
          ? options.length - 1
          : initial === 'first'
            ? 0
            : selectedIndex >= 0
              ? selectedIndex
              : 0
      setActiveIndex(initialIdx)
      positionListbox()
      setOpen(true)
    },
    [disabled, options.length, selectedIndex, positionListbox],
  )

  const closeListbox = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const commit = useCallback(
    (idx: number) => {
      const opt = options[idx]
      if (!opt) return
      onChange(opt.value)
      setOpen(false)
      triggerRef.current?.focus()
    },
    [options, onChange],
  )

  // Reposition on scroll + resize while open. `useLayoutEffect` so
  // the listbox doesn't paint at the old position for a frame after
  // the trigger moves (e.g. drawer resize, sticky header offset).
  useLayoutEffect(() => {
    if (!open) return
    const re = () => positionListbox()
    window.addEventListener('scroll', re, true)
    window.addEventListener('resize', re)
    return () => {
      window.removeEventListener('scroll', re, true)
      window.removeEventListener('resize', re)
    }
  }, [open, positionListbox])

  // Click outside closes — pointerdown beats click here so a drag-
  // started-on-overlay doesn't accidentally fire a click commit on
  // pointerup over an option.
  useEffect(() => {
    if (!open) return
    const handler = (e: PointerEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (listboxRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  // Scroll the active option into view when activeIndex changes.
  useEffect(() => {
    if (!open || !listboxRef.current) return
    const item = listboxRef.current.children[activeIndex] as
      | HTMLElement
      | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  // Type-ahead buffer (resets after 500ms of inactivity).
  const typeaheadRef = useRef<{
    buffer: string
    t: ReturnType<typeof setTimeout> | null
  }>({ buffer: '', t: null })
  // Clear any pending type-ahead reset timer on unmount so the
  // callback can't fire on a torn-down component (no observable
  // side effect today since the callback only mutates the ref,
  // but cleanup is the lint-correct shape and protects against
  // future buffer-flush logic). Self-review LOW (Chunk K post-pass).
  useEffect(() => {
    const ref = typeaheadRef
    return () => {
      if (ref.current.t) {
        clearTimeout(ref.current.t)
        ref.current.t = null
      }
    }
  }, [])

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openListbox('selected')
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        openListbox('last')
      } else if (e.key === 'Home') {
        e.preventDefault()
        openListbox('first')
      } else if (e.key === 'End') {
        e.preventDefault()
        openListbox('last')
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(options.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(activeIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeListbox()
    } else if (e.key === 'Tab') {
      // Tab commits + moves focus naturally — don't preventDefault so
      // the next focusable element receives focus normally.
      commit(activeIndex)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const s = typeaheadRef.current
      s.buffer = (s.buffer + e.key.toLowerCase()).slice(-32)
      if (s.t) clearTimeout(s.t)
      s.t = setTimeout(() => {
        s.buffer = ''
      }, 500)
      const idx = options.findIndex((o) =>
        o.label.toLowerCase().startsWith(s.buffer),
      )
      if (idx >= 0) setActiveIndex(idx)
    }
  }

  const isDark = resolvedTone === 'dark'

  const triggerClass = clsx(
    'inline-flex w-full items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm transition-all duration-quick min-h-[44px]',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-300/50 focus-visible:border-copper-400',
    isDark
      ? 'border-cream-50/15 bg-near-black/60 text-cream-50 hover:border-cream-50/30'
      : 'border-warm-stone/25 bg-cream-50/80 text-near-black hover:border-warm-stone/40',
    disabled && 'cursor-not-allowed opacity-50',
  )

  const listboxClass = clsx(
    'overflow-auto rounded-xl border py-1.5 shadow-[0_20px_50px_-15px_rgba(5,5,5,0.55)] focus:outline-none animate-bwc-fade-in motion-reduce:animate-none',
    isDark
      ? 'border-cream-50/15 bg-near-black/95 text-cream-50 backdrop-blur-md'
      : 'border-warm-stone/25 bg-cream-50/98 text-near-black backdrop-blur-md',
  )

  return (
    <>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${triggerId}-opt-${activeIndex}`
            : undefined
        }
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        onClick={() => (open ? closeListbox() : openListbox('selected'))}
        onKeyDown={onTriggerKeyDown}
        className={triggerClass}
      >
        <span className={selected ? 'truncate' : 'truncate opacity-60'}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          className={clsx(
            'pointer-events-none shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
            isDark ? 'text-cream-50/70' : 'text-warm-stone',
          )}
          size={16}
          strokeWidth={1.8}
          aria-hidden
        />
      </button>
      {/* Optional hidden input for legacy <form> POST callers. */}
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      {mounted &&
        open &&
        position &&
        createPortal(
          <ul
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-labelledby={ariaLabelledby ?? triggerId}
            // Tabindex -1 so screen-readers reach the listbox via the
            // trigger's aria-controls, NOT via the natural tab order
            // (Tab inside an open combobox commits + exits).
            tabIndex={-1}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              maxHeight: 320,
              zIndex: 100,
            }}
            className={listboxClass}
          >
            {options.map((opt, idx) => {
              const isSelected = idx === selectedIndex
              const isActive = idx === activeIndex
              return (
                <li
                  key={opt.value}
                  id={`${triggerId}-opt-${idx}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(idx)}
                  // pointerdown (not click) so the trigger's blur
                  // doesn't close the listbox before our handler
                  // fires.
                  onPointerDown={(e) => {
                    e.preventDefault()
                    commit(idx)
                  }}
                  className={clsx(
                    'flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors duration-quick motion-reduce:transition-none',
                    isActive &&
                      (isDark ? 'bg-copper-400/15' : 'bg-copper-500/10'),
                    isSelected &&
                      (isDark ? 'text-copper-200' : 'text-copper-700'),
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected && (
                    <Check
                      size={14}
                      strokeWidth={2.4}
                      className={isDark ? 'text-copper-300' : 'text-copper-500'}
                      aria-hidden
                    />
                  )}
                </li>
              )
            })}
          </ul>,
          document.body,
        )}
    </>
  )
}
