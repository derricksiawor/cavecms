'use client'

import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Search, X, Command } from 'lucide-react'
import { mapInsertBlockError } from '@/lib/cms/insertBlockErrors'
import { runMediaFirstInsert } from '@/lib/cms/blockSeeds'
import type { SearchableItem } from '@/lib/cms/blockSearch'
import { useInsertBlock } from './InlineEditContext'
import { useMediaPicker } from './MediaPickerProvider'
import { useSectionTemplateGallery } from './SectionTemplateGalleryHost'
import { useSlashCommand } from './SlashCommandProvider'
import { useSlashSearch } from './useSlashSearch'
import { useToast } from './Toast'
import { BlockSearchResults } from './BlockSearchResults'

// Chunk I — ⌘K palette. Centered modal-style surface, opens from
// anywhere in edit mode via the global ⌘K (Ctrl+K) shortcut owned by
// SlashCommandProvider. Inserts at the END of the current page
// (parentId omitted, no afterBlockId/beforeBlockId — server appends to
// tail). For a more precise insertion point, the operator uses the
// caret-anchored / popover instead.
//
// State + keyboard logic lives in `useSlashSearch` so this component
// and SlashCommandInline can't drift. This file owns the layout
// chrome (backdrop, modal panel, footer kbd hints) and the dispatch
// policy (page-tail insertion via insertBlock).
//
// Behaviour mental models (per the five-tool research pass at the top
// of `lib/cms/blockSearch.ts`):
//   - Notion / Linear / Raycast — palette stays centered, dim backdrop,
//     Esc closes, ↑/↓ navigate, Enter activates.
//   - Raycast — alias prefix matches outrank fuzzy title matches.
//     Result rows show alias chip when match landed via alias.
//   - Linear — context-aware "above the fold" entries. We keep curated
//     SEED_ENTRIES order on empty query — context awareness is Phase 2.
//
// Visual treatment:
//   - bg-near-black/97 panel + backdrop-blur, matching ContextMenu +
//     EditDrawer dark tone.
//   - 560px wide on desktop, full-width-with-16px-gutter on mobile.
//   - 60% backdrop opacity tint (bg-near-black/60) so the operator's
//     spatial context stays visible behind the palette.

const PALETTE_ID = 'cavecms-slash-palette'
const RESULTS_ID = 'cavecms-slash-palette-results'

export function SlashCommandPalette() {
  const { close, pageId, state } = useSlashCommand()
  const toast = useToast()
  const insertBlock = useInsertBlock()
  const mediaPicker = useMediaPicker()
  const templateGallery = useSectionTemplateGallery()

  const inputRef = useRef<HTMLInputElement | null>(null)
  // Double-fire guard for Enter / click activation. Owned here (not
  // by useSlashSearch) so it's reachable from BOTH the hook (which
  // flips true on Enter to gate re-entry) and our handleSelect's
  // finally (which flips back to false after the async dispatch).
  //
  // No separate picker-in-flight guard is needed for the Media path:
  // MediaPickerProvider holds a single-slot state — two rapid
  // `mediaPicker.open(...)` calls coalesce to one modal. The post-
  // pick `insertBlock('image', ...)` runs through `.then()` once.
  const firingRef = useRef(false)

  const handleSelect = useCallback(
    (item: SearchableItem) => {
      if (item.disabled) {
        // Templates stub. Toast surfaces the reason so the operator
        // understands why nothing happened.
        if (item.disabledReason) toast.error(item.disabledReason)
        firingRef.current = false
        return
      }
      const run = async () => {
        try {
          // Chunk J — template kind dispatches to the gallery host.
          // Close the palette first so the gallery's focus trap doesn't
          // race the palette's restore-focus call (the palette closes
          // with restoreFocus: true; the gallery then captures focus
          // itself on mount).
          //
          // Pass the slash provider's `state.returnFocus` (captured at
          // ⌘K time — usually the canvas element the operator was
          // editing) into the gallery's open. Without this, the
          // gallery's mount-effect snapshots document.activeElement
          // AFTER the palette has unmounted (focus has fallen to
          // body) but BEFORE the palette's rAF restores focus — and
          // the gallery's eventual close then restores to body
          // instead of the original canvas. Post-agent-review D1.
          if (item.kind === 'template') {
            const ret = state.returnFocus
            close()
            templateGallery.open({ returnFocus: ret })
            return
          }
          if (item.kind === 'media') {
            // Close the palette BEFORE opening the picker so the two
            // modals don't fight. The picker takes over from here.
            // firingRef stays true through the picker callback so
            // a double-Enter inside the same handleSelect tick can't
            // re-dispatch; it's released in finally below regardless
            // of which branch was taken.
            close()
            mediaPicker.open(undefined, (m) => {
              void insertBlock('lx_figure', {
                pageId,
                data: {
                  image: { media_id: m.media_id, alt: m.alt ?? '' },
                },
              }).then((res) => {
                if (!res.ok) {
                  toast.error(mapInsertBlockError(res.error).copy)
                }
              })
            })
            return
          }
          if (item.kind === 'seed' && item.blockType) {
            // Page-end insertion — parentId omitted so the server appends to
            // the tail of the top-level bucket. Media-first: figure / image-
            // pair / cover / gallery etc. open the MediaPicker so a REAL
            // image is picked before insert (else the placeholder media_id
            // 404s media_missing). Non-media blocks insert directly.
            const bt = item.blockType
            runMediaFirstInsert(bt, item.data, mediaPicker, (data) => {
              void insertBlock(bt, { pageId, data }).then((res) => {
                if (!res.ok) toast.error(mapInsertBlockError(res.error).copy)
                else close()
              })
            })
          }
        } finally {
          firingRef.current = false
        }
      }
      void run()
    },
    [close, insertBlock, mediaPicker, pageId, state.returnFocus, templateGallery, toast],
  )

  const searchHook = useSlashSearch(RESULTS_ID, {
    firingRef,
    onSelect: handleSelect,
  })

  // Auto-focus the input on mount so the operator can start typing
  // immediately. requestAnimationFrame defers past the portal mount
  // so Safari doesn't drop the focus call.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  return createPortal(
    <div
      // role=dialog with aria-modal=true tells AT users this is a
      // modal surface; tab cycling stays inside via the focus trap
      // (operators tab inside the result list via Tab + Shift+Tab).
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${PALETTE_ID}-title`}
      // Click on the backdrop closes — but clicks INSIDE the panel
      // don't bubble out (stopPropagation on the panel below). Outside-
      // click close does NOT restore focus (the click already chose
      // its own target).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close({ restoreFocus: false })
      }}
      className="fixed inset-0 z-[90] flex items-start justify-center bg-near-black/60 backdrop-blur-sm px-4 pt-[18vh] animate-cavecms-fade-in motion-reduce:animate-none"
    >
      <div
        id={PALETTE_ID}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-cream-50/12 bg-near-black/[0.97] shadow-[0_30px_70px_-20px_rgba(0,0,0,0.7)] animate-cavecms-scale-in motion-reduce:animate-none"
      >
        {/* Header — search input + close button + ⌘K hint. */}
        <div className="flex items-center gap-3 border-b border-cream-50/10 px-4 py-3.5">
          <Search
            size={16}
            strokeWidth={2}
            className="shrink-0 text-cream-50/55"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            value={searchHook.query}
            onChange={(e) => searchHook.setQuery(e.target.value)}
            onKeyDown={searchHook.onKeyDown}
            placeholder="Search blocks…  e.g. heading, h1, btn, stat"
            aria-label="Search block types"
            // Combobox semantics so AT users get arrow-key + selected-
            // option announcements without us moving DOM focus off the
            // input.
            role="combobox"
            aria-controls={RESULTS_ID}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={searchHook.activeId}
            // OS spellcheck on a CMS-block-picker query is pointless
            // noise + can interfere with the keyboard handler.
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-[14px] text-cream-50 placeholder:text-cream-50/35 focus:outline-none"
          />
          {/* ⌘K hint chip — visually echoes the shortcut so operators
              learn it. Hidden on touch viewports where ⌘K has no
              meaning. */}
          <span
            aria-hidden="true"
            className="hidden items-center gap-0.5 rounded-md border border-cream-50/15 px-1.5 py-0.5 font-mono text-[10px] text-cream-50/55 sm:inline-flex"
          >
            <Command size={9} strokeWidth={2.2} />K
          </span>
          <button
            type="button"
            onClick={() => close()}
            aria-label="Close palette"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-cream-50/55 transition-colors hover:bg-cream-50/10 hover:text-cream-50 focus-visible:bg-cream-50/10 focus-visible:outline-none"
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>

        {/* Title — sr-only so AT users get a label without the visual
            chrome eating space the result rows need. */}
        <h2 id={`${PALETTE_ID}-title`} className="sr-only">
          Block picker
        </h2>

        <div className="max-h-[55vh] overflow-y-auto px-2 py-2">
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
            header={
              searchHook.debouncedQuery === ''
                ? 'Suggestions'
                : `Results for "${searchHook.debouncedQuery}"`
            }
            emptyHint={
              searchHook.debouncedQuery === ''
                ? undefined
                : `No matches for "${searchHook.debouncedQuery}". Try a shorter word.`
            }
          />
        </div>

        {/* Footer — keyboard hint strip. Helps operators learn the
            keyboard nav without a separate help screen. */}
        <div className="flex items-center justify-between border-t border-cream-50/10 px-4 py-2 text-[10px] text-cream-50/45">
          <span className="flex items-center gap-3">
            <KbdHint label="Navigate" keys={['↑', '↓']} />
            <KbdHint label="Insert" keys={['Enter']} />
            <KbdHint label="Close" keys={['Esc']} />
          </span>
          <span>
            {searchHook.hits.length} result
            {searchHook.hits.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function KbdHint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <span
          key={k}
          aria-hidden="true"
          className="inline-flex min-w-[18px] items-center justify-center rounded border border-cream-50/15 px-1 py-0.5 font-mono text-[9px] text-cream-50/60"
        >
          {k}
        </span>
      ))}
      <span>{label}</span>
    </span>
  )
}
