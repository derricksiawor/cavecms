'use client'

import { useState } from 'react'

// Suggest tab — fires a "give me 3 distinct options" request to
// Gemini. The 3 options arrive in the SSE done event and are
// rendered as hover-preview-able cards inside the popover's
// "ready" panel (SuggestReadyPanel in AISparklePopover.tsx).
//
// This card is the input surface: the operator types an optional
// hint and clicks Suggest.

interface Props {
  onSubmit: (freeText: string | undefined) => void
}

export function AISparkleSuggestCard(p: Props) {
  const [freeText, setFreeText] = useState('')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        p.onSubmit(freeText.trim().length > 0 ? freeText.trim() : undefined)
      }}
      className="flex flex-col gap-4"
    >
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-copper-700">
          Get three to choose from
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-warm-stone">
          AI drafts three distinct alternatives for the primary field on this
          block. Pick the one you like, or none.
        </p>
      </div>
      <label className="block">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-warm-stone">
          Hint (optional)
        </span>
        <textarea
          maxLength={240}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="e.g. shorter, more confident, lead with the offer"
          rows={3}
          className="mt-1.5 w-full resize-none rounded-xl border border-warm-stone/25 bg-white px-3 py-2 text-[12px] leading-relaxed text-near-black placeholder:text-warm-stone/60 focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
        />
        <span className="mt-1 block text-right text-[10px] tabular-nums text-warm-stone/70">
          {freeText.length} / 240
        </span>
      </label>
      <div className="flex justify-end">
        <button
          type="submit"
          className="inline-flex h-11 items-center rounded-full bg-copper-500 px-5 text-[12px] font-semibold uppercase tracking-[0.16em] text-cream-50 hover:bg-copper-600 transition-colors sm:h-9 sm:py-2"
        >
          Suggest three
        </button>
      </div>
    </form>
  )
}
