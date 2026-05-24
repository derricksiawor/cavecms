'use client'

import { forwardRef, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Loader2, Columns3 } from 'lucide-react'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from './Toast'

// Page-level "+ Add section" affordance. Sits between every pair of
// top-level entries in BlockTreeRenderer (and before the first / after
// the last) when the operator is in edit mode. The visual is louder
// than InsertBlockHere — a thicker copper rule + a bigger pill — to
// signal "structural", not "small content tweak".
//
// Click → opens a shape picker (1/2/3/4 column section). Each pick
// POSTs kind='section' + withColumns=N + a default meta blob; the
// server creates the section row AND the N column children in one TX.
// Background + padding default to cream/md and are tweakable from the
// section settings drawer (Chunk C SHAPES_FOR_BLOCK['section']).

type Shape = 1 | 2 | 3 | 4

const SHAPE_LABEL: Record<Shape, string> = {
  1: '1 column',
  2: '2 columns',
  3: '3 columns',
  4: '4 columns',
}

const SHAPE_DESC: Record<Shape, string> = {
  1: 'Full-width single column.',
  2: 'Two even columns side by side.',
  3: 'Three even columns.',
  4: 'Four even columns — collapses on mobile.',
}

const SHAPE_ICON_PREVIEW: Record<Shape, string[]> = {
  1: ['flex-1'],
  2: ['flex-1', 'flex-1'],
  3: ['flex-1', 'flex-1', 'flex-1'],
  4: ['flex-1', 'flex-1', 'flex-1', 'flex-1'],
}

interface Props {
  pageId: number
  // Top-level neighbour id this affordance sits AFTER. Numeric →
  // insert after that block. Null/undefined → defer to
  // `beforeBlockId` (BEFORE-first pill) or append-to-tail.
  afterBlockId?: number | null
  // Top-level neighbour id this affordance sits IMMEDIATELY BEFORE.
  // Numeric → server bisects with the prior sibling (or position/2
  // for the very first slot). Mutually exclusive with afterBlockId.
  beforeBlockId?: number | null
}

export function InsertSectionHere({
  pageId,
  afterBlockId,
  beforeBlockId,
}: Props) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Shape | null>(null)
  const [, startTransition] = useTransition()
  const ref = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const firstMenuItemRef = useRef<HTMLButtonElement | null>(null)

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
    // Move focus into the popover so keyboard operators don't have
    // to tab from the trigger to the first option. Restored to the
    // trigger on close so focus order survives the round-trip.
    firstMenuItemRef.current?.focus()
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Focus restore on close. wasOpenRef tracks the previous render so
  // the initial-mount transition (open=false → open=false) doesn't
  // steal focus to the trigger when the page first paints.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (!open && wasOpenRef.current) {
      triggerRef.current?.focus()
    }
    wasOpenRef.current = open
  }, [open])

  const add = async (shape: Shape) => {
    if (busy) return
    setBusy(shape)
    try {
      const body: Record<string, unknown> = {
        pageId,
        kind: 'section',
        // Default tone + padding — operator tweaks via the section
        // settings drawer (SHAPES_FOR_BLOCK['section']).
        meta: { columns: shape, background: 'cream', padding: 'md' },
        withColumns: shape,
      }
      if (typeof afterBlockId === 'number') body['afterBlockId'] = afterBlockId
      if (typeof beforeBlockId === 'number') body['beforeBlockId'] = beforeBlockId
      const res = await csrfFetch('/api/cms/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (j.error === 'position_gap_exhausted') {
          toast.error(
            "Couldn't insert here — the position gap is full. Refresh the page and try again.",
          )
        } else {
          toast.error(j.error ?? "We couldn't add the section. Try again.")
        }
        return
      }
      setOpen(false)
      toast.success('Section added.')
      startTransition(() => router.refresh())
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Network error — try again.',
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      ref={ref}
      className={clsx(
        'group/section-insert relative my-2 flex h-8 items-center justify-center',
        open && 'h-auto',
      )}
    >
      {!open && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Insert a new section here"
          aria-haspopup="menu"
          className="relative flex w-full items-center justify-center text-warm-stone opacity-0 transition-opacity duration-quick ease-standard hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none motion-reduce:transition-none"
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-copper-500/60"
          />
          <span className="relative inline-flex items-center gap-2 rounded-full bg-near-black px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-cream-50 shadow-[0_10px_24px_-10px_rgba(5,5,5,0.6)]">
            <Plus size={12} strokeWidth={2.4} />
            Add section
          </span>
        </button>
      )}

      {open && (
        <div
          role="menu"
          aria-label="Pick a section shape"
          className="relative w-full max-w-2xl rounded-2xl border border-warm-stone/20 bg-cream-50 p-4 shadow-[0_24px_56px_-26px_rgba(5,5,5,0.4)] animate-bwc-fade-in"
        >
          <div className="mb-3 flex items-center gap-2 px-1">
            <Columns3 size={12} strokeWidth={2.2} className="text-copper-500" />
            <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
              Pick a section shape
            </p>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {([1, 2, 3, 4] as Shape[]).map((shape, i) => (
              <li key={shape}>
                <ShapeButton
                  ref={i === 0 ? firstMenuItemRef : undefined}
                  shape={shape}
                  busy={busy === shape}
                  disabled={busy !== null && busy !== shape}
                  onClick={() => void add(shape)}
                />
              </li>
            ))}
          </ul>
          <p className="mt-3 px-1 text-[10px] text-warm-stone">
            Background and padding are tunable from the section
            settings — click the section after it lands.
          </p>
        </div>
      )}
    </div>
  )
}

interface ShapeButtonProps {
  shape: Shape
  busy: boolean
  disabled: boolean
  onClick: () => void
}

const ShapeButton = forwardRef<HTMLButtonElement, ShapeButtonProps>(
  function ShapeButton({ shape, busy, disabled, onClick }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        disabled={disabled || busy}
        aria-busy={busy}
        aria-disabled={disabled || busy}
        onClick={onClick}
        // Natural height already ≥ 44px (swatch + label + 2-line desc).
        className="group/shape relative flex h-full w-full flex-col items-start gap-2 rounded-xl border border-warm-stone/15 bg-cream px-4 py-3 text-left transition-all hover:-translate-y-0.5 hover:border-copper-400 hover:shadow-[0_14px_30px_-18px_rgba(5,5,5,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        <span
          aria-hidden="true"
          // Bumped: bg-warm-stone/8 read as nearly invisible on cream.
          // /15 + bar tone /35 on idle reads as a clear visual swatch.
          className="flex h-8 w-full items-center gap-1 rounded-md bg-warm-stone/15 p-1"
        >
          {SHAPE_ICON_PREVIEW[shape].map((cls, i) => (
            <span
              key={i}
              className={clsx(
                'h-full rounded-sm bg-near-black/35 transition-colors group-hover/shape:bg-copper-500/70',
                cls,
              )}
            />
          ))}
        </span>
        <span className="flex w-full items-center justify-between">
          <span className="font-serif text-sm font-bold tracking-tight text-near-black">
            {SHAPE_LABEL[shape]}
          </span>
          {busy && (
            <Loader2
              size={11}
              strokeWidth={2.4}
              className="animate-spin text-copper-500"
            />
          )}
        </span>
        <span className="text-[10px] leading-relaxed text-warm-stone">
          {SHAPE_DESC[shape]}
        </span>
      </button>
    )
  },
)

