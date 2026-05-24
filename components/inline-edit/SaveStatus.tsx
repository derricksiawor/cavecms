'use client'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { Check, Cloud, CloudOff, Loader2 } from 'lucide-react'
import { formatRelativeSince, type AutoSaveStatus } from '@/hooks/useAutoSave'

// Render the auto-save state as a small pill that lives next to the
// version number in editor headers. The relative timestamp ticks on a
// 15-second interval so the pill freshens without re-rendering the
// whole editor tree.

export function SaveStatus({
  status,
  lastSavedAt,
  manualDirty,
  className,
}: {
  status: AutoSaveStatus
  lastSavedAt: number | null
  // When the operator has unsaved edits but auto-save is disabled
  // (e.g., reauth-gated forms), surface that distinct visual state.
  manualDirty?: boolean
  className?: string
}) {
  const [, force] = useState(0)
  useEffect(() => {
    if (status !== 'saved' || lastSavedAt == null) return
    const t = setInterval(() => force((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [status, lastSavedAt])

  let icon = <Cloud size={12} strokeWidth={2.2} />
  let label = 'All saved'
  let tone = 'text-warm-stone'
  if (manualDirty) {
    icon = <CloudOff size={12} strokeWidth={2.2} />
    label = 'Unsaved'
    tone = 'text-copper-700'
  } else if (status === 'pending') {
    icon = <Cloud size={12} strokeWidth={2.2} />
    label = 'Saving soon…'
    tone = 'text-copper-700'
  } else if (status === 'saving') {
    icon = <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
    label = 'Saving…'
    tone = 'text-copper-700'
  } else if (status === 'error') {
    icon = <CloudOff size={12} strokeWidth={2.2} />
    label = 'Save failed'
    tone = 'text-red-700'
  } else if (status === 'paused') {
    icon = <CloudOff size={12} strokeWidth={2.2} />
    label = 'Auto-save paused'
    tone = 'text-red-700'
  } else if (status === 'saved' && lastSavedAt != null) {
    icon = <Check size={12} strokeWidth={2.4} />
    label = `Saved · ${formatRelativeSince(lastSavedAt)}`
    tone = 'text-copper-700'
  }
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border border-warm-stone/20 bg-cream-50/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors',
        tone,
        className,
      )}
      aria-live="polite"
    >
      {icon}
      <span>{label}</span>
    </span>
  )
}
