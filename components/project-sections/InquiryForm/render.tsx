import type { ReactNode } from 'react'
import { Calendar, Phone, MessageSquare } from 'lucide-react'
import { InquiryForm } from '@/components/leads/InquiryForm'
import { RevealOnView } from '../_shared/RevealOnView'
import type { InquiryData, ProjectPublicContext } from '../_shared/types'

// Inline inquiry form section. The Hero CTAs + StickyHeader's
// "Schedule a tour" all hash-link to #inquiry-form (anchored here),
// so this section is the conversion endpoint for the whole page.
//
// Always renders, even if admin hasn't customised the heading/body
// — a project page MUST surface a way to talk to a human.

export function InquirySection({
  data,
  ctx,
}: {
  data: InquiryData
  ctx: ProjectPublicContext
}): ReactNode {
  const heading = data.heading?.trim() || `Reach out about ${ctx.projectName}`
  return (
    <RevealOnView
      as="section"
      id="inquiry-form"
      animation="slide-up"
      className="bg-cream py-20 sm:py-28"
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Speak with our team
          </p>
          <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
            {heading}
          </h2>
          {data.body_richtext?.trim() ? (
            <div
              className="prose prose-lg mt-5 mx-auto max-w-none prose-p:text-warm-stone prose-p:leading-relaxed"
              dangerouslySetInnerHTML={{ __html: data.body_richtext }}
            />
          ) : (
            <p className="mt-5 text-base sm:text-lg text-warm-stone leading-relaxed">
              Share a few details and a member of our sales team will be in
              touch — usually within a working day — to arrange a private
              viewing or answer your questions.
            </p>
          )}
        </div>

        {/* Trio of soft-promise cells under the heading — adds
            buyer-confidence ahead of the form. Plain copy, no
            interactivity. */}
        <ul className="mx-auto mt-10 grid max-w-3xl grid-cols-1 gap-3 text-center sm:grid-cols-3 sm:gap-4">
          {[
            { Icon: Calendar, label: 'Private viewings on request' },
            { Icon: Phone, label: 'Speak directly with our advisors' },
            { Icon: MessageSquare, label: 'No-obligation conversation' },
          ].map(({ Icon, label }) => (
            <li
              key={label}
              className="flex items-center justify-center gap-2 rounded-full border border-near-black/8 bg-cream-50 px-4 py-2 text-sm text-warm-stone"
            >
              <Icon className="h-4 w-4 text-copper-700" strokeWidth={1.75} />
              {label}
            </li>
          ))}
        </ul>

        <div className="mx-auto mt-12 max-w-2xl rounded-2xl border border-near-black/8 bg-cream-50 p-6 sm:p-10 shadow-lg shadow-near-black/5">
          <InquiryForm
            csrf={ctx.preCsrf}
            projectId={ctx.projectId}
            projectName={ctx.projectName}
            previewMode={ctx.previewMode}
          />
        </div>
      </div>
    </RevealOnView>
  )
}
