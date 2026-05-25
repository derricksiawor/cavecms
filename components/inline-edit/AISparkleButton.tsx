'use client'

import { useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import clsx from 'clsx'
import { useAiSnapshot } from './InlineEditContext'
import { isInlineAiEligible } from '@/lib/ai/inlineEligibility'
import { useAiSparkleSession } from './AiSparkleSessionContext'
import { AISparklePopover } from './AISparklePopover'

// Sparkle button rendered inside EditableBlock's toolbar (leading
// position). Hidden unless ALL of these hold:
//
//   1. The editor's AI snapshot says ai_config.enabled === true
//   2. ai_config.inlineEnabled === true
//   3. A Gemini API key is stored (keyOnFile === true)
//   4. ai_config.models.inline is set
//   5. The block type is in the inline-AI allow-list
//
// Each gate is independently verified server-side at /api/ai/stream;
// the client gate is a UX shield so the operator doesn't see a button
// that always errors.

export interface AISparkleButtonProps {
  blockId: number
  blockType: string
  blockVersion: number
  pageId: number
  pageVersion: number
  currentData: unknown
}

export function AISparkleButton(p: AISparkleButtonProps) {
  const aiSnapshot = useAiSnapshot()
  const session = useAiSparkleSession()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)

  // Eligibility gates — keep this in one place so the SSR/CSR boundary
  // can't drift from the server's own gate.
  if (!aiSnapshot) return null
  if (!aiSnapshot.enabled) return null
  if (!aiSnapshot.inlineEnabled) return null
  if (!aiSnapshot.keyOnFile) return null
  if (!aiSnapshot.inlineModel) return null
  if (!isInlineAiEligible(p.blockType)) return null

  // Visual emphasis when this block has an active session — copper
  // glow ring around the button so the operator can find the popover
  // trigger when they scroll the block out of view.
  const sessionForThisBlock =
    session.session && session.session.blockId === p.blockId
      ? session.session
      : null
  const sessionActive = sessionForThisBlock !== null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Ask AI to edit this block"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Ask AI"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className={clsx(
          // Same 44px touch target shape as the other toolbar buttons.
          'inline-flex h-11 w-11 items-center justify-center rounded-full text-cream-50 transition-all',
          'hover:bg-champagne hover:text-obsidian focus-visible:bg-champagne focus-visible:text-obsidian focus-visible:outline-none',
          'hover:scale-105 focus-visible:scale-105 motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100 motion-reduce:transition-none',
          sessionActive && 'bg-copper-500 text-cream-50 ring-2 ring-copper-300/60',
        )}
      >
        <Sparkles size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <AISparklePopover
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
          blockId={p.blockId}
          blockType={p.blockType}
          blockVersion={p.blockVersion}
          pageId={p.pageId}
          pageVersion={p.pageVersion}
          currentData={p.currentData}
        />
      )}
    </>
  )
}
