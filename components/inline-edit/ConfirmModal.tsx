'use client'

import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'

// Shared confirm-modal scaffold. Earlier each editable shell shipped
// its own near-identical implementation:
//   - EditableSection.ConfirmDeleteSectionModal
//   - EditableColumn.ConfirmDeleteColumnModal
//   - EditDrawer.ConfirmCloseModal
// All four shared the same role="dialog" + aria-modal + backdrop +
// auto-focus-cancel + Esc-to-close + busy-aware buttons. Centralising
// keeps the focus-trap + a11y semantics in lock-step across them.
//
// `destructive` toggles the confirm button to red (delete actions).
// `confirmLabel` / `cancelLabel` let callers re-phrase per context
// (Remove vs Discard changes, Cancel vs Keep editing).

interface Props {
  title: string
  description: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  busy?: boolean
  ariaLabel: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmModal({
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  ariaLabel,
  onCancel,
  onConfirm,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // Auto-focus the safe action (Cancel) on mount so a hasty Enter
  // doesn't confirm a destructive op. Esc closes the modal unless an
  // in-flight action is committing.
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Stop propagation BEFORE the busy check so an Escape while a
      // confirm-action is in flight doesn't bubble to the parent
      // Drawer's window-level keydown handler — without this the
      // Drawer's Escape would call its own onClose, which re-opens
      // the confirm modal in a flicker (close + reopen on the same
      // keystroke).
      e.stopPropagation()
      if (!busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      // z-[60] keeps the modal above the Drawer (z-50) for the
      // EditDrawer's discard-changes prompt; harmless above bare
      // page chrome for the section/column delete prompts.
      className="fixed inset-0 z-[60] flex items-end justify-center bg-near-black/40 backdrop-blur-sm sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div className="w-full max-w-md rounded-t-3xl bg-cream-50 p-6 shadow-2xl sm:rounded-3xl">
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">
          {title}
        </h2>
        <div className="mt-2 text-sm leading-relaxed text-warm-stone">
          {description}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="inline-flex min-h-[44px] items-center rounded-full border border-warm-stone/30 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-near-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            aria-busy={busy}
            className={
              destructive
                ? 'inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-red-600 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:opacity-50'
                : 'inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-near-black px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cream-50 transition-colors hover:bg-copper-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-300 disabled:opacity-50'
            }
          >
            {busy && <Loader2 size={11} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
