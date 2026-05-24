import type { ReactNode } from 'react'
import { RevealOnView } from '../_shared/RevealOnView'
import type { HeroData } from '../_shared/types'

// Renders hero.summary_richtext as its own visual section, after the
// hero. Separating the prose from the hero (where it used to sit
// crammed under the image) gives the marketing copy room to breathe
// and lets it use the prose typography stack (`@tailwindcss/typography`).
//
// Reads from the SAME hero section payload, dispatched from the
// 'hero' key — the dispatcher returns the Hero + Summary as a
// fragment so admins don't see a separate "Summary" section_key in
// the editor.
//
// Returns null on missing/empty summary so the page collapses
// cleanly when the project doesn't have intro copy yet.

export function SummarySection({ data }: { data: HeroData }): ReactNode {
  const html = data.summary_richtext?.trim()
  if (!html) return null
  return (
    <RevealOnView
      as="section"
      animation="slide-up"
      className="bg-cream-50 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
          About this residence
        </p>
        <div
          className="prose prose-lg mt-6 max-w-none font-serif text-near-black prose-p:font-sans prose-p:text-warm-stone prose-p:leading-relaxed prose-strong:text-near-black prose-a:text-copper-700 prose-a:no-underline hover:prose-a:underline"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </RevealOnView>
  )
}
