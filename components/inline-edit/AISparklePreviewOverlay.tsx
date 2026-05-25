'use client'

import { Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { useSparkleSessionFor } from './AiSparkleSessionContext'

// Small floating pill rendered ABOVE a block while an AI session is
// active against it. The dashed copper outline is applied directly
// on the EditableBlock's wrapper (see EditableBlock changes); this
// component is the "AI proposing…" / "Ready to apply" affordance.
//
// Pure presentational — reads the session state via context. Mounts
// inside the EditableBlock so the pill is positioned relative to
// the block and disappears when the block unmounts.

export interface AISparklePreviewOverlayProps {
  blockId: number
}

export function AISparklePreviewOverlay({ blockId }: AISparklePreviewOverlayProps) {
  const session = useSparkleSessionFor(blockId)
  if (!session) return null
  const label =
    session.status === 'preparing'
      ? 'Preparing'
      : session.status === 'streaming'
        ? session.intent === 'translate'
          ? 'Translating'
          : session.intent === 'suggest'
            ? 'Drafting options'
            : session.intent === 'fillin'
              ? 'Filling in'
              : 'Rewriting'
        : session.status === 'ready'
          ? 'Ready'
          : session.status === 'applying'
            ? 'Applying'
            : null
  if (!label) return null
  const isReady = session.status === 'ready'
  return (
    <div
      aria-live="polite"
      className={clsx(
        'pointer-events-none absolute -top-3 left-4 z-10 inline-flex items-center gap-1.5 rounded-full bg-obsidian px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50 shadow-[0_8px_20px_-8px_rgba(0,0,0,0.5)]',
        isReady ? 'ring-2 ring-copper-300/70' : '',
      )}
    >
      <Sparkles
        size={12}
        className={clsx(
          'text-copper-300',
          !isReady && session.status !== 'idle' && 'animate-pulse',
        )}
        aria-hidden="true"
      />
      <span>AI {label.toLowerCase()}{!isReady ? '…' : ''}</span>
    </div>
  )
}

// Class fragment applied to the EditableBlock wrapper when a session
// is active for it. Centralised here so the visual treatment stays
// in one file. EditableBlock imports + applies via clsx().
export const SPARKLE_ACTIVE_OUTLINE =
  '!outline-copper-400 !outline-dashed !outline-2 shadow-[0_18px_44px_-22px_rgba(160,90,40,0.45)]'
