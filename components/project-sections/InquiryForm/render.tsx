import type { ReactNode } from 'react'
import { Calendar, Phone, MessageSquare } from 'lucide-react'
import { InquiryForm } from '@/components/leads/InquiryForm'
import { RevealOnView } from '../_shared/RevealOnView'
import {
  resolveSectionTone,
  DARK_FIELD_CLASS,
} from '@/lib/cms/sectionTone'
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
  // Section tone (default = cream — the original look) drives EVERY
  // colour: surface, eyebrow/icon accent, heading, body, the promise
  // pills, the form card, and the input treatment. Brand-linked via
  // --brand-* so Settings → Theme re-skins it.
  const tone = resolveSectionTone(data.background)
  // Form presentation (default = current: panel card, bordered
  // inputs). 'transparent' drops the card so the form sits on the
  // section — lets it be aligned with the brochure form.
  const cardSurface = data.card_surface ?? 'panel'
  const fieldStyle = data.field_style ?? 'bordered'
  const cardClass =
    cardSurface === 'panel'
      ? `mx-auto mt-12 max-w-2xl rounded-2xl ${tone.panel} p-6 sm:p-10 shadow-lg shadow-near-black/5`
      : 'mx-auto mt-12 max-w-2xl'
  return (
    <RevealOnView
      as="section"
      id="inquiry-form"
      animation="slide-up"
      className={`${tone.surface} py-20 sm:py-28`}
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p
            className={`text-[11px] font-semibold uppercase tracking-[0.32em] ${tone.accent}`}
          >
            Speak with our team
          </p>
          <h2
            className={`mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight ${tone.heading}`}
          >
            {heading}
          </h2>
          {data.body_richtext?.trim() ? (
            <div
              className={`${tone.proseBody} mt-5 mx-auto max-w-none`}
              dangerouslySetInnerHTML={{ __html: data.body_richtext }}
            />
          ) : (
            <p className={`mt-5 text-base sm:text-lg ${tone.muted} leading-relaxed`}>
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
              className={`flex items-center justify-center gap-2 rounded-full ${tone.panel} px-4 py-2 text-sm ${tone.muted}`}
            >
              <Icon className={`h-4 w-4 ${tone.accent}`} strokeWidth={1.75} />
              {label}
            </li>
          ))}
        </ul>

        <div className={cardClass}>
          <InquiryForm
            csrf={ctx.preCsrf}
            projectId={ctx.projectId}
            projectName={ctx.projectName}
            previewMode={ctx.previewMode}
            fieldStyle={fieldStyle}
            fieldClassName={tone.isDark ? DARK_FIELD_CLASS : undefined}
          />
        </div>
      </div>
    </RevealOnView>
  )
}
