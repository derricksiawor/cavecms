'use client'

import { useEffect, useRef, useState } from 'react'
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown'

// Collapsed height cap (px) ≈ Tailwind max-h-80. Long release notes are
// clipped to this with a fade until the operator expands them; short notes
// fall under the cap and render in full with no fade/toggle.
const COLLAPSED_MAX_PX = 320

// Fades the last ~72px of the collapsed content to transparent so the clipped
// edge softens into the card background (any colour/opacity), no colour band.
const FADE_MASK = 'linear-gradient(to bottom, #000 0%, #000 calc(100% - 72px), transparent 100%)'

/**
 * "What's new in <version>" card for Settings → Updates. Renders the running
 * version's release notes (already stripped of the `## <version>` heading).
 * Height-capped with an overflow-gated Show more / Show less toggle.
 */
export function WhatsNewCard({ version, body }: { version: string; body: string }) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const innerRef = useRef<HTMLDivElement>(null)

  // Measure once after mount: does the full content exceed the cap? (scrollHeight
  // reports the full content height even while clipped by max-height.)
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    setOverflows(el.scrollHeight > COLLAPSED_MAX_PX + 4)
  }, [body])

  const collapsed = !expanded

  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
          What&rsquo;s new
        </p>
        <h2 className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black">
          What&rsquo;s new in {version}
        </h2>
      </header>

      <div
        ref={innerRef}
        className="mt-4 overflow-hidden transition-[max-height] duration-300 ease-out"
        style={{
          maxHeight: collapsed ? COLLAPSED_MAX_PX : undefined,
          // Fade the CONTENT itself to transparent at the bottom while
          // collapsed — a mask blends into whatever the (translucent) card
          // background actually is, unlike a solid-colour gradient overlay
          // which shows as a mismatched band over the page's gradient bg.
          ...(collapsed && overflows ? { maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK } : {}),
        }}
      >
        <ReleaseNotesMarkdown>{body}</ReleaseNotesMarkdown>
      </div>

      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-4 w-fit cursor-pointer text-sm font-semibold text-copper-700 transition-colors hover:text-copper-800"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </article>
  )
}
