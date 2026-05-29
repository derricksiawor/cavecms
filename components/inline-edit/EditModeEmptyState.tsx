'use client'

import {
  Layers,
  LayoutTemplate,
  Type,
  MousePointerClick,
  Quote,
  Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { mapInsertBlockError } from '@/lib/cms/insertBlockErrors'
import { useMediaPicker } from './MediaPickerProvider'
import { useInsertBlock } from './InlineEditContext'
import { useSectionTemplateGallery } from './SectionTemplateGalleryHost'
import { SEED_DATA } from '@/lib/cms/blockSeeds'

// Empty-state card shown inside the page body when the operator enters
// edit mode on a page with zero blocks. The OutlinePanel in the corner
// is too easy to miss on first encounter — a centered card in the
// content area is the discoverable "what do I do next?" affordance,
// mirroring the Notion / Wix new-page experience.
//
// Renders ONLY when (editable === true && blocks.length === 0). For
// the non-editable path (signed-out visitor on an empty published page)
// the page body stays bare — that's a content gap for the operator to
// fix, not a UX gap to surface to the public.
//
// Three seed block types match the OutlinePanel's `AddBlockMenu`
// allowlist (text, cta, quote) — these are the ones whose minimum-valid
// seed payloads pass the server Zod schemas without requiring a media
// pick. Image / gallery / hero / featured-projects blocks need a media
// id (or a selection step) and are intentionally NOT one-click adds
// here — the OutlinePanel's drawer covers them.

interface Props {
  pageId: number
}

// SEED_DATA (the payloads) lives in `lib/cms/blockSeeds.ts` — shared
// with InsertBlockHere / OutlinePanel.AddBlockMenu / EditableColumn
// so widget-schema additions can't drift between entry points. The
// labels + descriptions below are intentionally LONGER than the other
// pickers because the empty-state card is the operator's "first
// encounter" UI and benefits from richer copy.
const SEED_TYPES: Array<{
  type: keyof typeof SEED_DATA
  label: string
  description: string
  icon: LucideIcon
}> = [
  {
    type: 'lx_text',
    label: 'Text',
    description: 'A paragraph of rich text — headlines, prose, links.',
    icon: Type,
  },
  {
    type: 'lx_cta_banner',
    label: 'Call to action',
    description: 'A short title with a button linking somewhere else.',
    icon: MousePointerClick,
  },
  {
    type: 'lx_quote',
    label: 'Quote',
    description: 'A pull-quote or testimonial.',
    icon: Quote,
  },
]

export function EditModeEmptyState({ pageId }: Props) {
  const mediaPicker = useMediaPicker()
  const insertBlock = useInsertBlock()
  const templateGallery = useSectionTemplateGallery()
  const [busyType, setBusyType] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Chunk I — POST + refresh routed through useInsertBlock. The empty-
  // state card owns: busy-type state, inline error banner, MediaPicker
  // round-trip for the Picture button. The hook owns: body shape,
  // default seed lookup, router.refresh.
  const add = async (
    blockType: keyof typeof SEED_DATA,
    data?: Record<string, unknown>,
  ) => {
    if (busyType) return
    setBusyType(blockType)
    setErr(null)
    try {
      const res = await insertBlock(blockType, { pageId, data })
      if (!res.ok) {
        setErr(mapInsertBlockError(res.error).copy)
        return
      }
    } finally {
      setBusyType(null)
    }
  }

  // Image insertion via MediaPicker — same pattern as InsertBlockHere.
  const addImage = () => {
    if (busyType) return
    mediaPicker.open(undefined, (m) => {
      void add('lx_figure', {
        image: { media_id: m.media_id, alt: m.alt ?? '' },
      })
    })
  }

  return (
    <section
      aria-label="Empty page — pick a starting block"
      className="mx-auto my-24 max-w-3xl px-6 sm:px-10"
    >
      <div className="rounded-3xl border border-warm-stone/20 bg-cream-50/80 px-8 py-12 text-center shadow-[0_24px_60px_-30px_rgba(5,5,5,0.35)] backdrop-blur-sm sm:px-12 sm:py-16">
        <span
          aria-hidden="true"
          className="mx-auto mb-6 inline-flex h-14 w-14 items-center justify-center rounded-full bg-copper-500/15 text-copper-500 ring-1 ring-copper-400/30"
        >
          <Layers size={22} strokeWidth={1.8} />
        </span>
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-400">
          Empty page
        </p>
        <h2 className="mt-3 font-serif text-3xl font-bold tracking-tight text-near-black sm:text-4xl">
          Add your first block
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-warm-stone">
          Pick a starting block below — you can rearrange, restyle, and add
          more from the outline panel once anything&apos;s on the page.
        </p>

        {err && (
          <p
            role="alert"
            className="mx-auto mt-6 max-w-sm rounded-2xl border border-red-200 bg-red-50/60 px-4 py-2 text-xs font-medium text-red-700"
          >
            {err}
          </p>
        )}

        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SEED_TYPES.map(({ type, label, description, icon: Icon }) => {
            const busy = busyType === type
            return (
              <button
                key={type}
                type="button"
                disabled={busy || busyType !== null}
                onClick={() => add(type)}
                className="group relative flex h-full flex-col items-start gap-2 rounded-2xl border border-warm-stone/15 bg-cream px-5 py-5 text-left transition-all hover:-translate-y-0.5 hover:border-copper-400 hover:shadow-[0_18px_40px_-24px_rgba(5,5,5,0.35)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-warm-stone/15 bg-cream-50 text-near-black transition-colors group-hover:border-copper-400/60 group-hover:text-copper-500"
                >
                  <Icon size={16} strokeWidth={2} />
                </span>
                <p className="font-serif text-base font-bold tracking-tight text-near-black">
                  {label}
                </p>
                <p className="text-xs leading-relaxed text-warm-stone">
                  {description}
                </p>
                {busy && (
                  <span
                    aria-live="polite"
                    className="absolute right-3 top-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-copper-500"
                  >
                    Adding…
                  </span>
                )}
              </button>
            )
          })}
          {/* Image — separate flow (MediaPicker → POST). */}
          <button
            type="button"
            disabled={busyType !== null}
            onClick={addImage}
            className="group relative flex h-full flex-col items-start gap-2 rounded-2xl border border-warm-stone/15 bg-cream px-5 py-5 text-left transition-all hover:-translate-y-0.5 hover:border-copper-400 hover:shadow-[0_18px_40px_-24px_rgba(5,5,5,0.35)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-warm-stone/15 bg-cream-50 text-near-black transition-colors group-hover:border-copper-400/60 group-hover:text-copper-500"
            >
              <ImageIcon size={16} strokeWidth={2} />
            </span>
            <p className="font-serif text-base font-bold tracking-tight text-near-black">
              Picture
            </p>
            <p className="text-xs leading-relaxed text-warm-stone">
              Pick from the media library or upload a new one — image
              with optional caption.
            </p>
            {busyType === 'lx_figure' && (
              <span
                aria-live="polite"
                className="absolute right-3 top-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-copper-500"
              >
                Adding…
              </span>
            )}
          </button>
        </div>

        <div className="mt-8 flex flex-col items-center gap-3 text-[11px] font-medium text-warm-stone">
          <p>
            Need an image, gallery, or featured projects? Open the
            outline panel — those need a media or project pick before
            they save.
          </p>
          {/* Chunk J — secondary CTA opens the section-template gallery
              (previously linked to /admin/pages/new which is the page-
              template wizard, a different surface). 44px touch target
              via the h-9 inline-flex sizing on small screens. */}
          <button
            type="button"
            onClick={() => templateGallery.open()}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-warm-stone/30 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-near-black transition-all hover:-translate-y-0.5 hover:border-copper-400 hover:shadow-[0_10px_24px_-14px_rgba(160,90,40,0.5)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <LayoutTemplate size={11} strokeWidth={2.2} />
            Or start from a template
          </button>
        </div>
      </div>
    </section>
  )
}
