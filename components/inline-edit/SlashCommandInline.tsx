'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { mapInsertBlockError } from '@/lib/cms/insertBlockErrors'
import type { SearchableItem } from '@/lib/cms/blockSearch'
import { useInsertBlock } from './InlineEditContext'
import {
  useSlashCommand,
  type SlashCommandInlineAnchor,
} from './SlashCommandProvider'
import { useSlashSearch } from './useSlashSearch'
import { useToast } from './Toast'
import { BlockSearchResults } from './BlockSearchResults'

// Chunk I — caret-anchored / popover. Operator types `/` at the start
// of an empty paragraph inside an InlineEditable richtext field; this
// popover opens anchored at the caret rect, focuses an internal search
// input, and inserts the chosen block immediately AFTER the source
// widget (with optional source-delete via insertBlock's replaceSource).
//
// State + keyboard logic lives in `useSlashSearch` (shared with
// SlashCommandPalette). This file owns: caret-anchored positioning,
// viewport clamp, scroll/resize close, outside-click close (no focus
// restore — operator's click chose its own focus target), and the
// dispatch policy (insert-after-source + replaceSource gate).
//
// replaceSource gate (the multi-paragraph data-loss prevention):
//   - sourceBlockType === 'text' (text widget is the Notion-paragraph
//     analogue; other widgets like Accordion / Tabs have richtext
//     fields nested in richer schemas — deleting the whole widget
//     because one item's body is empty would destroy unrelated data)
//   - sourceWidgetIsEmpty === true (the ENTIRE widget's textContent
//     is empty, not just the current paragraph — InlineEditable
//     measures the editable root, not just the cursor's <p>)
//   Both conditions must hold OR no source-delete fires. Operator
//   gets the new block as a sibling AFTER the source; the empty
//   paragraph stays and they can delete it via the context menu.

const RESULTS_ID = 'bwc-slash-inline-results'

interface Props {
  anchor: SlashCommandInlineAnchor
}

export function SlashCommandInline({ anchor }: Props) {
  const { close } = useSlashCommand()
  const toast = useToast()
  const insertBlock = useInsertBlock()

  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Final clamped coords — set by useLayoutEffect below. Null until
  // the measurement lands; panel renders `visibility: hidden` in the
  // meantime so we never paint at raw (potentially overflowing)
  // coords for a single frame.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  // Caller-owned double-fire guard — see SlashCommandPalette for the
  // same pattern + rationale.
  const firingRef = useRef(false)

  const handleSelect = useCallback(
    (item: SearchableItem) => {
      if (item.disabled) {
        if (item.disabledReason) toast.error(item.disabledReason)
        firingRef.current = false
        return
      }
      const run = async () => {
        try {
          if (item.kind === 'media') {
            // The inline trigger doesn't support image directly — the
            // MediaPicker round-trip pulls focus away from the
            // contenteditable + breaks the popover's anchor invariant.
            // Operator uses ⌘K palette → Picture instead.
            toast.error('Use ⌘K to add a picture.')
            close()
            return
          }
          if (item.kind === 'seed' && item.blockType) {
            // replaceSource gate — only fires when BOTH conditions
            // hold (see file-level comment). Otherwise insert lands
            // as a sibling of the source with NO source-delete.
            const replaceSource =
              anchor.sourceBlockType === 'text' &&
              anchor.sourceWidgetIsEmpty
                ? { sourceBlockId: anchor.sourceBlockId }
                : undefined
            const res = await insertBlock(item.blockType, {
              pageId: anchor.pageId,
              data: item.data,
              afterBlockId: anchor.sourceBlockId,
              parentId: anchor.parentId,
              replaceSource,
            })
            if (!res.ok) {
              toast.error(mapInsertBlockError(res.error).copy)
              return
            }
            close()
          }
        } finally {
          firingRef.current = false
        }
      }
      void run()
    },
    [anchor, close, insertBlock, toast],
  )

  const searchHook = useSlashSearch(RESULTS_ID, {
    firingRef,
    onSelect: handleSelect,
  })

  // Auto-focus the input on mount. Same RAF defer as the palette so
  // Safari doesn't drop the focus call across the portal mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── Viewport clamp ──
  // Mirrors Chunk H ContextMenu's clamp logic. Measure the rendered
  // panel, flip to top/left anchor if it would overflow, clamp to
  // BOTH viewport edges (left + right), floor coords to avoid sub-
  // pixel render on high-DPI displays.
  //
  // Anchor placement: the popover sits BELOW the caret + 4px gutter
  // (so the caret is still visible to the operator). If that would
  // overflow the bottom edge, we flip to ABOVE the caret.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gutter = 4
    const margin = 8
    // Default — below the caret.
    let x = anchor.coords.x
    let y = anchor.coords.y + gutter
    // Vertical flip — below → above on bottom-edge overflow.
    if (y + rect.height > vh - margin) {
      const above = anchor.coords.y - rect.height - gutter
      if (above >= margin) {
        y = above
      } else {
        // Neither below nor above fits — pin to nearest edge.
        y = Math.max(margin, vh - rect.height - margin)
      }
    }
    // Horizontal clamp — right edge AND left edge. The caret may be
    // close to the left edge (column hugging the gutter on mobile);
    // without the left clamp the 320px panel would clip off-screen.
    if (x + rect.width > vw - margin) {
      x = Math.max(margin, vw - rect.width - margin)
    }
    if (x < margin) x = margin
    setPos({ x: Math.floor(x), y: Math.floor(y) })
  }, [anchor.coords.x, anchor.coords.y, searchHook.hits])

  // ── Scroll / resize close ──
  // anchor.coords was captured ONCE at open. If the operator scrolls
  // (touchpad gesture, arrow keys, browser auto-scroll) or resizes
  // the window, the caret moves but the popover stays glued to the
  // original viewport position. Notion + Linear close on scroll for
  // exactly this reason — the operator's gesture implies they're
  // moving on. Closes WITHOUT focus restore (the scroll already
  // shifted operator attention; yanking focus back is jarring).
  useEffect(() => {
    const onScrollOrResize = () => close({ restoreFocus: false })
    // Capture phase catches scroll events from ANY scroll container,
    // not just window-level scroll. Operators inside scrollable
    // panels (the outline panel, an EditDrawer scrollable body)
    // get the same dismissal.
    window.addEventListener('scroll', onScrollOrResize, {
      passive: true,
      capture: true,
    })
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, {
        capture: true,
      })
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [close])

  // ── Outside-click dismissal ──
  // Provider's keydown listener owns Esc. Outside-click is local
  // because it depends on the panel ref. Uses mousedown (not click)
  // so dismissal fires BEFORE focus shifts to an underlying button.
  // Outside-click does NOT restore focus — operator's mousedown
  // already chose its own focus target; yanking it back to the
  // original InlineEditable feels like a glitch.
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!panelRef.current) return
      if (panelRef.current.contains(e.target as Node)) return
      close({ restoreFocus: false })
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [close])

  const visible = pos !== null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Insert block"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: pos?.y ?? 0,
        left: pos?.x ?? 0,
        visibility: visible ? 'visible' : 'hidden',
      }}
      className="z-[85] w-[320px] max-w-[calc(100vw-16px)] overflow-hidden rounded-2xl border border-cream-50/12 bg-near-black/[0.97] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md animate-bwc-scale-in motion-reduce:animate-none"
    >
      <div className="flex items-center gap-2 border-b border-cream-50/10 px-3 py-2.5">
        <span
          aria-hidden="true"
          className="font-mono text-[11px] font-semibold text-copper-300"
        >
          /
        </span>
        <input
          ref={inputRef}
          type="text"
          value={searchHook.query}
          onChange={(e) => searchHook.setQuery(e.target.value)}
          onKeyDown={searchHook.onKeyDown}
          placeholder="Block type…"
          aria-label="Search block types"
          role="combobox"
          aria-controls={RESULTS_ID}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={searchHook.activeId}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent text-[13px] text-cream-50 placeholder:text-cream-50/35 focus:outline-none"
        />
      </div>

      <div className="max-h-[260px] overflow-y-auto px-1.5 py-1.5">
        <BlockSearchResults
          hits={searchHook.hits}
          activeIndex={searchHook.activeIndex}
          onSelect={(item) => {
            if (firingRef.current) return
            firingRef.current = true
            handleSelect(item)
          }}
          onHover={searchHook.setActiveIndex}
          idStem={RESULTS_ID}
          dark
          emptyHint={
            searchHook.debouncedQuery === ''
              ? undefined
              : `No matches for "${searchHook.debouncedQuery}"`
          }
        />
      </div>
    </div>,
    document.body,
  )
}
