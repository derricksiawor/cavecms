'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

// Branded single-line text-input modal. Replaces window.prompt() for
// in-editor name capture (e.g. "Save as block"), which renders the raw
// "localhost:3055 says" Chrome chrome — off-brand and jarring inside a
// polished editor. Mirrors ConfirmModal's scaffold (role="dialog" +
// aria-modal + backdrop + Esc-to-close + busy-aware buttons) so the
// two read as one family; adds a focused, pre-selected text field and
// Enter-to-submit.

interface Props {
  title: string
  description?: React.ReactNode
  /** Field label above the input. */
  label?: string
  /** Pre-filled value; selected on open so a single keystroke replaces it. */
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  maxLength?: number
  busy?: boolean
  ariaLabel: string
  onCancel: () => void
  /** Receives the trimmed-as-typed raw value (caller sanitises/validates). */
  onConfirm: (value: string) => void
}

export function PromptModal({
  title,
  description,
  label,
  defaultValue = '',
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  maxLength,
  busy = false,
  ariaLabel,
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const descId = useId()

  // Focus + select the input on mount so the suggested name can be
  // overwritten with one keystroke (matches the native prompt's UX).
  // Esc cancels (unless committing); handled at document level + stops
  // propagation so a host Drawer's Escape handler doesn't also fire.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (!busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const submit = () => {
    if (busy) return
    onConfirm(value)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-near-black/40 backdrop-blur-sm sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <form
        className="w-full max-w-md rounded-t-3xl bg-cream-50 p-6 shadow-2xl sm:rounded-3xl"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">
          {title}
        </h2>
        {description && (
          <div
            id={descId}
            className="mt-2 text-sm leading-relaxed text-warm-stone"
          >
            {description}
          </div>
        )}
        <label className="mt-4 block">
          {label && (
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              {label}
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            disabled={busy}
            aria-describedby={description ? descId : undefined}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-warm-stone/30 bg-white px-3 py-2.5 text-near-black focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-400 disabled:opacity-50"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="inline-flex min-h-[44px] items-center rounded-full border border-warm-stone/30 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-near-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-near-black px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cream-50 transition-colors hover:bg-copper-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-300 disabled:opacity-50"
          >
            {busy && <Loader2 size={11} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
