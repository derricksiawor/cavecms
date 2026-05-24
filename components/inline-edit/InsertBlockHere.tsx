'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Loader2, Image as ImageIcon, ImagePlus, Mountain, Star } from 'lucide-react'
import clsx from 'clsx'
import { mapInsertBlockError } from '@/lib/cms/insertBlockErrors'
import { useToast } from './Toast'
import { useMediaPicker } from './MediaPickerProvider'
import { useInsertBlock } from './InlineEditContext'
import {
  SEED_ENTRIES,
  isPaletteVisible,
  type SeedBlockType,
} from '@/lib/cms/blockSeeds'

// Notion / Wix-style "drop a block here" affordance. Rendered between
// every pair of EditableBlock children on the public page in edit mode
// (plus before the first block and after the last). Sits as a thin
// invisible spacer that expands into a copper "+ Add block here" pill
// on hover; clicking opens a small popover with the seed block types
// (text / cta / quote — same allowlist as the empty-state CTA).
//
// Seed-data + seed-type entries live in `lib/cms/blockSeeds.ts` —
// shared with OutlinePanel.AddBlockMenu, EditableColumn.ColumnInlinePicker,
// and EditModeEmptyState so all four "add a block" surfaces stay in
// lockstep when a widget gets a new required field.
//
// `position` is OPTIONAL — when omitted, the server slots the block at
// the end. When passed, the new block lands at that position (1000-spaced
// positions per `lib/cms/saveBlock.ts` convention; we pass the AVERAGE
// of the surrounding positions so the new block falls between them
// without forcing a reorder pass). The API endpoint accepts an optional
// `afterBlockId` param to position relative to an existing block, which
// is what this component uses.

export function InsertBlockHere({
  pageId,
  afterBlockId,
  beforeBlockId,
  parentId,
}: {
  pageId: number
  // Block id this insert-point sits AFTER. Numeric → server bisects
  // sibling positions sharing parentId. Null/undefined → defer to
  // `beforeBlockId` (BEFORE-first pill) or append-to-tail (no
  // neighbour info at all).
  afterBlockId?: number | null
  // Block id this insert-point sits IMMEDIATELY BEFORE. Numeric →
  // server bisects with the prior sibling so the new block lands at
  // the head of the bucket (or between this and prior). Mutually
  // exclusive with afterBlockId.
  beforeBlockId?: number | null
  // Parent column id when this affordance lives inside an editable
  // column (Chunk C). Null/undefined → top-level loose widget under
  // parent_id IS NULL (legacy + back-compat path).
  parentId?: number | null
}) {
  const toast = useToast()
  const mediaPicker = useMediaPicker()
  const insertBlock = useInsertBlock()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Synchronous in-flight guard. A rapid double-click on the same
  // picker button dispatches two events in the same React tick - both
  // see `busy === null` from the render-closure and BOTH fire POST
  // /api/cms/blocks, inserting a duplicate block. The ref is mutated
  // synchronously so the second click bails immediately. (Chunk I —
  // insertBlock itself is idempotent per call but doesn't dedupe
  // concurrent dispatches; the guard stays here at the picker
  // boundary where the operator's gesture originates.)
  //
  // No separate "picker-in-flight" guard is needed for the Picture
  // path: MediaPickerProvider holds a single-slot state, so two
  // rapid `mediaPicker.open(...)` calls coalesce to one modal (React
  // batches setState; the second call's onPick replaces the first).
  // The post-pick `add('image', ...)` call still flows through this
  // inFlightRef, so a duplicate POST is impossible.
  const inFlightRef = useRef(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const firstMenuItemRef = useRef<HTMLButtonElement | null>(null)

  // Outside-click + Escape close the popover. Auto-focus the first
  // menuitem on open so keyboard operators don't have to tab from
  // the trigger to the first option.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    firstMenuItemRef.current?.focus()
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Focus restore on close (only after a real open→close transition,
  // not on initial mount).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (!open && wasOpenRef.current) triggerRef.current?.focus()
    wasOpenRef.current = open
  }, [open])

  // Chunk I — POST + refresh routed through the centralised
  // useInsertBlock hook. The picker keeps ownership of: open/close
  // state, in-flight guard, busy spinner key, and the toast mapping.
  // The hook covers: body shape, default seed data lookup, response
  // parsing, error normalisation, router.refresh.
  const add = async (
    blockType: SeedBlockType | 'image' | 'hero' | 'gallery' | 'featured_projects',
    data?: Record<string, unknown>,
    // Optional UI-state identifier. Defaults to blockType so callers
    // that don't need to disambiguate keep the pre-Chunk-G behaviour.
    // SEED_ENTRIES callers pass entry.label so duplicate-blockType
    // entries (Counter + Stats Row) get independent busy spinners.
    busyKey?: string,
  ) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(busyKey ?? blockType)
    try {
      const res = await insertBlock(blockType, {
        pageId,
        data,
        afterBlockId: afterBlockId ?? undefined,
        beforeBlockId: beforeBlockId ?? undefined,
        parentId: parentId ?? undefined,
      })
      if (!res.ok) {
        toast.error(mapInsertBlockError(res.error).copy)
        return
      }
      setOpen(false)
    } finally {
      setBusy(null)
      inFlightRef.current = false
    }
  }

  // Image insertion — open MediaPicker, on pick create an image block
  // with the chosen media_id. The image-block Zod schema requires
  // `image.media_id` to be a positive int, so this two-step flow
  // (pick → create) is the only valid creation path.
  const addImage = () => {
    if (busy) return
    mediaPicker.open(undefined, (m) => {
      void add('image', {
        image: { media_id: m.media_id, alt: m.alt ?? '' },
        caption: '',
        alignment: 'center',
      })
    })
  }
  // Hero — full-bleed image + title + subtitle + optional CTA. The
  // hero schema requires .min(1) on title and a MediaRef on image, so
  // the MediaPicker round-trip is mandatory. NOTE: hero is reserved
  // for fixed-slot template pages (/home, /about, /services, /contact)
  // via FIXED_BLOCK_KEYS_PER_PAGE; clicking this on a reserved page
  // surfaces a friendly 409 toast ("edit the existing one instead").
  const addHero = () => {
    if (busy) return
    mediaPicker.open(undefined, (m) => {
      void add(
        'hero',
        {
          title: 'New hero',
          subtitle: '',
          image: { media_id: m.media_id, alt: m.alt ?? '' },
        },
        'Hero',
      )
    })
  }
  // Gallery — same MediaPicker flow as Image, but seeded into the
  // gallery schema's required images[] array (min 1). Default columns
  // = 3 (anna-tier "luxury 3-up grid" baseline). Operator can add
  // more images + change layout via the EditDrawer.
  const addGallery = () => {
    if (busy) return
    mediaPicker.open(undefined, (m) => {
      void add(
        'gallery',
        {
          images: [{ media_id: m.media_id, alt: m.alt ?? '' }],
          columns: 3,
        },
        'Gallery',
      )
    })
  }
  // Featured projects — no MediaPicker needed; the project_ids array
  // accepts an empty seed. Operator pulls in projects via the drawer's
  // ProjectPicker. Like hero, this is reserved on /home; the 409 toast
  // covers that case.
  const addFeaturedProjects = () => {
    if (busy) return
    void add(
      'featured_projects',
      { project_ids: [], layout: 'grid' },
      'Featured projects',
    )
  }

  return (
    <div
      ref={ref}
      className={clsx(
        'group/insert relative my-1 flex h-6 items-center justify-center',
        open && 'h-auto',
      )}
    >
      {/* Thin divider line, invisible until hover. When hovered, a
          copper "+ Add block here" pill appears centered on the line. */}
      {!open && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Insert a new block here"
          aria-haspopup="menu"
          // Chunk H — when this pill lives inside a column (parentId is
          // numeric), tag it with the column id so the context menu's
          // column "Add widget" verb can find it via a stable selector
          // and click() it to open the picker. Top-level / loose pills
          // (parentId omitted) skip the attribute to keep the selector
          // scoped to column children.
          data-add-widget-target={typeof parentId === 'number' ? parentId : undefined}
          className="relative flex w-full items-center justify-center text-warm-stone opacity-0 transition-opacity duration-quick ease-standard hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none motion-reduce:transition-none"
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-12 top-1/2 h-px -translate-y-1/2 bg-copper-400/50"
          />
          <span className="relative inline-flex items-center gap-1.5 rounded-full bg-copper-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cream-50 shadow-[0_6px_14px_-6px_rgba(160,90,40,0.6)]">
            <Plus size={11} strokeWidth={2.4} />
            Add block here
          </span>
        </button>
      )}

      {open && (
        <div
          role="menu"
          aria-label="Pick a block type"
          className="relative w-full max-w-sm rounded-2xl border border-warm-stone/20 bg-cream-50 p-3 shadow-[0_22px_56px_-26px_rgba(5,5,5,0.4)] animate-bwc-fade-in"
        >
          <p className="mb-2 px-1 text-[9px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
            Insert a block
          </p>
          <ul className="space-y-1">
            {SEED_ENTRIES.filter(isPaletteVisible).map((entry, i) => {
              // `busy` is keyed by entry.label rather than entry.type
              // because two picker entries (Counter + Stats Row) can
              // legitimately share a block_type but should still show
              // their loader spinners independently.
              // isPaletteVisible gates legacy widget types per the
              // luxury-redesign migration (see blockSeeds.ts).
              const Icon = entry.icon
              const isBusy = busy === entry.label
              return (
                <li key={entry.label}>
                  <button
                    ref={i === 0 ? firstMenuItemRef : undefined}
                    type="button"
                    role="menuitem"
                    aria-busy={isBusy}
                    disabled={busy !== null}
                    onClick={() => void add(entry.type, entry.data, entry.label)}
                    className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-warm-stone/8 focus-visible:bg-warm-stone/8 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-copper-500/15 text-copper-500 ring-1 ring-copper-400/30">
                      {isBusy ? (
                        <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
                      ) : (
                        <Icon size={12} strokeWidth={2.4} />
                      )}
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-semibold text-near-black">
                        {entry.label}
                      </span>
                      <span className="text-[11px] text-warm-stone">
                        {entry.description}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
            {/* Image — separate flow: open MediaPicker, then POST the
                block. Image-block Zod requires a valid media_id, so we
                can't seed with an empty media reference. */}
            <li>
              <button
                type="button"
                role="menuitem"
                aria-busy={busy === 'image'}
                disabled={busy !== null}
                onClick={addImage}
                className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-warm-stone/8 focus-visible:bg-warm-stone/8 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-copper-500/15 text-copper-500 ring-1 ring-copper-400/30">
                  {busy === 'image' ? (
                    <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
                  ) : (
                    <ImageIcon size={12} strokeWidth={2.4} />
                  )}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold text-near-black">
                    Picture
                  </span>
                  <span className="text-[11px] text-warm-stone">
                    Pick from the media library or upload a new one.
                  </span>
                </span>
              </button>
            </li>
            {/* Hero — full-bleed image + title + tagline + optional CTA.
                Same MediaPicker round-trip as Picture; the hero schema
                requires a MediaRef and a non-empty title. Reserved for
                fixed-slot pages (/home, /about, /services, /contact) —
                the 409 toast handles that case. */}
            <li>
              <button
                type="button"
                role="menuitem"
                aria-busy={busy === 'Hero'}
                disabled={busy !== null}
                onClick={addHero}
                className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-warm-stone/8 focus-visible:bg-warm-stone/8 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-copper-500/15 text-copper-500 ring-1 ring-copper-400/30">
                  {busy === 'Hero' ? (
                    <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
                  ) : (
                    <Mountain size={12} strokeWidth={2.4} />
                  )}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold text-near-black">
                    Hero
                  </span>
                  <span className="text-[11px] text-warm-stone">
                    Full-bleed image with headline and tagline.
                  </span>
                </span>
              </button>
            </li>
            {/* Gallery — MediaPicker seeds the first image; operator
                adds more via the drawer. Default 3-up columns. */}
            <li>
              <button
                type="button"
                role="menuitem"
                aria-busy={busy === 'Gallery'}
                disabled={busy !== null}
                onClick={addGallery}
                className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-warm-stone/8 focus-visible:bg-warm-stone/8 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-copper-500/15 text-copper-500 ring-1 ring-copper-400/30">
                  {busy === 'Gallery' ? (
                    <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
                  ) : (
                    <ImagePlus size={12} strokeWidth={2.4} />
                  )}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold text-near-black">
                    Gallery
                  </span>
                  <span className="text-[11px] text-warm-stone">
                    Image grid (2/3/4-up) with captions.
                  </span>
                </span>
              </button>
            </li>
            {/* Featured projects — no MediaPicker; operator picks
                projects in the drawer. Seeds with an empty array;
                renders nothing until projects are added. */}
            <li>
              <button
                type="button"
                role="menuitem"
                aria-busy={busy === 'Featured projects'}
                disabled={busy !== null}
                onClick={addFeaturedProjects}
                className="flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-warm-stone/8 focus-visible:bg-warm-stone/8 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-copper-500/15 text-copper-500 ring-1 ring-copper-400/30">
                  {busy === 'Featured projects' ? (
                    <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
                  ) : (
                    <Star size={12} strokeWidth={2.4} />
                  )}
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-semibold text-near-black">
                    Featured projects
                  </span>
                  <span className="text-[11px] text-warm-stone">
                    Curated project tiles — pick which ones in the drawer.
                  </span>
                </span>
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
