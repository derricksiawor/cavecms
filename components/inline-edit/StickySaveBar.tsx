'use client'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'

// Sticky save bar that anchors to the bottom of long-form editors.
// Renders a copper dot when there are unsaved changes, the primary
// Save action, an optional Preview, an optional Discard, and an
// optional extras slot. Hidden when there's nothing pending.
//
// Mobile: stretches edge to edge, becomes a single row of pills.
// Desktop: shrinks to a centred pill with breathing space.
export function StickySaveBar({
  dirty,
  busy,
  onSave,
  onDiscard,
  onPreview,
  saveLabel = 'Save changes',
  busyLabel = 'Saving…',
  hint,
  extras,
}: {
  dirty: boolean
  busy?: boolean
  onSave: () => void
  onDiscard?: () => void
  onPreview?: () => void
  saveLabel?: string
  busyLabel?: string
  hint?: ReactNode
  extras?: ReactNode
}) {
  return (
    <div
      className={clsx(
        'sticky bottom-4 z-30 mt-8 mx-auto w-full max-w-3xl transition-all duration-standard',
        dirty || busy ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0 pointer-events-none',
      )}
    >
      <div className="flex flex-wrap items-center gap-3 rounded-full border border-warm-stone/25 bg-cream-50/95 backdrop-blur-md px-4 sm:px-6 py-2.5 shadow-[0_20px_50px_-20px_rgba(5,5,5,0.35)]">
        <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-warm-stone min-w-0">
          <span
            aria-hidden
            className={clsx(
              'inline-flex h-2 w-2 shrink-0 rounded-full transition-colors',
              dirty ? 'bg-copper-500 animate-cavecms-pulse-copper' : 'bg-warm-stone/30',
            )}
          />
          <span className="truncate">
            {busy ? busyLabel : dirty ? 'Unsaved changes' : 'All saved'}
          </span>
          {hint && (
            <span className="ml-2 hidden sm:inline truncate normal-case tracking-normal text-[11px] text-warm-stone/80">
              {hint}
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {extras}
          {onPreview && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onPreview}
              disabled={busy}
            >
              Preview
            </Button>
          )}
          {onDiscard && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDiscard}
              disabled={busy || !dirty}
            >
              Discard
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={busy || !dirty}
          >
            {busy ? busyLabel : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
