'use client'
import { useEffect } from 'react'
import { AlertTriangle, HelpCircle } from 'lucide-react'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'

// Custom confirm modal. Replaces window.confirm() (banned by
// project standards). Two visual modes:
//   - destructive: orange/copper warning halo, "are you sure?" tone
//   - default:     copper sparkle, "just confirming…" tone
// Generous padding + rounded-3xl + soft ambient glow so the dialog
// feels like a deliberate moment, not a stiff system alert.

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Don't allow ESC while a mutation is in flight — the click
      // handler already fired, cancelling the modal here would let the
      // network call resolve into a "moved on" UX state (the parent has
      // hidden the modal but a toast.success still flashes).
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    acquireScrollLock()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseScrollLock()
    }
  }, [open, busy, onCancel])

  if (!open) return null

  const Icon = destructive ? AlertTriangle : HelpCircle
  const haloTone = destructive
    ? 'bg-copper-500/15 text-copper-700 ring-copper-300/40'
    : 'bg-cream-50 text-copper-700 ring-warm-stone/25'
  const haloBlur = destructive ? 'bg-copper-400/40' : 'bg-copper-300/30'

  const confirmClasses = destructive
    ? 'inline-flex w-fit items-center justify-center rounded-full bg-copper-700 px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 shadow-[0_18px_40px_-22px_rgba(196,124,68,0.7)] transition-all hover:bg-copper-800 hover:shadow-[0_24px_48px_-22px_rgba(196,124,68,0.85)] disabled:opacity-50'
    : 'inline-flex w-fit items-center justify-center rounded-full bg-near-black px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 shadow-[0_18px_40px_-22px_rgba(5,5,5,0.55)] transition-all hover:bg-copper-700 hover:shadow-[0_24px_48px_-22px_rgba(196,124,68,0.6)] disabled:opacity-50'

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          // Match the ESC and Cancel-button gating: refuse to close
          // while a mutation is in flight. Without this the parent
          // momentarily sees onCancel() then has to re-show the modal
          // (or worse, hides it while the promise still resolves).
          if (!busy) onCancel()
        }}
        className="fixed inset-0 z-40 cursor-default bg-near-black/45 backdrop-blur-[3px] animate-cavecms-fade-in"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-warm-stone/20 bg-cream-50 shadow-[0_40px_80px_-30px_rgba(5,5,5,0.55)] animate-cavecms-fade-in"
      >
        <div className="relative px-8 pt-9 pb-7 sm:px-10 sm:pt-10">
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 h-48 w-48 rounded-full ${haloBlur} blur-3xl`}
          />
          <div className="relative flex flex-col items-center text-center">
            <span
              className={`relative inline-flex h-16 w-16 items-center justify-center rounded-full ring-1 ${haloTone}`}
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 rounded-full ${haloBlur} blur-xl`}
              />
              <Icon size={26} strokeWidth={1.8} className="relative" />
            </span>
            <p
              id="confirm-title"
              className="mt-5 font-serif text-2xl font-bold tracking-tight text-near-black"
            >
              {title}
            </p>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-warm-stone">
              {description}
            </p>
          </div>
        </div>
        <div className="flex flex-col-reverse items-stretch gap-3 border-t border-warm-stone/15 bg-cream/40 px-8 py-5 sm:flex-row sm:items-center sm:justify-end sm:px-10">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex w-fit items-center justify-center rounded-full border border-warm-stone/30 px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 hover:text-copper-700 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={confirmClasses}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  )
}
