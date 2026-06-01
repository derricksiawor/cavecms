import type { ReactNode } from 'react'
import { FileText, Download } from 'lucide-react'
import { BrochureForm } from '@/components/leads/BrochureForm'
import { RevealOnView } from '../_shared/RevealOnView'
import type { BrochureData, ProjectPublicContext } from '../_shared/types'

// Lead-gated PDF download. The PDF itself is NEVER served from a
// public URL — the form posts to /api/leads/brochure which (a)
// stores the lead, (b) signs a single-use download token, (c)
// emails the visitor a link to /api/brochure/[token]. The token is
// CAS-enforced single-use even on email forwarding.
//
// Renders nothing when no PDF is wired — admin will see the empty
// state in /admin/projects. This is the right default: a "request
// the brochure" CTA pointing at a missing brochure would lose
// real leads.

export function BrochureSection({
  data,
  ctx,
}: {
  data: BrochureData
  ctx: ProjectPublicContext
}): ReactNode {
  if (!data.pdf) return null

  // Form presentation (default = current: no card surface, bordered
  // inputs). 'panel' wraps the form in a cream card matching the
  // inquiry form so the two can be aligned via section data.
  const cardSurface = data.card_surface ?? 'transparent'
  const fieldStyle = data.field_style ?? 'bordered'
  const formWrapClass =
    cardSurface === 'panel'
      ? 'mt-8 rounded-2xl border border-near-black/8 bg-cream-50 p-6 sm:p-8 shadow-lg shadow-near-black/5'
      : 'mt-8'

  return (
    <RevealOnView
      as="section"
      id="brochure"
      animation="slide-up"
      className="bg-cream-200 py-20 sm:py-28"
    >
      <div className="mx-auto grid max-w-6xl gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-20">
        {/* Visual side — brochure preview card. We don't have a PDF
            thumbnail in the schema; a stylised PDF-tab card is the
            recognisable real-estate brochure cue without requiring an
            extra asset. */}
        <div className="relative">
          <div className="relative mx-auto aspect-[3/4] max-w-sm overflow-hidden rounded-2xl bg-cream-50 shadow-2xl shadow-near-black/15 ring-1 ring-near-black/5">
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 50% 0%, rgba(184,115,51,0.18), transparent 55%), linear-gradient(180deg, rgba(243,233,220,1) 0%, rgba(232,218,196,1) 100%)',
              }}
            />
            <div className="relative flex h-full flex-col items-center justify-center px-8 text-center">
              <span
                aria-hidden
                className="grid h-16 w-16 place-items-center rounded-full bg-copper-600 text-cream shadow-lg shadow-copper-900/20"
              >
                <FileText className="h-7 w-7" strokeWidth={1.5} />
              </span>
              <p className="mt-6 font-serif text-2xl font-semibold tracking-tight text-near-black">
                {ctx.projectName}
              </p>
              <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-700">
                Full project brochure
              </p>
              <p className="mt-6 text-sm text-warm-stone leading-relaxed">
                Floor plans · pricing tiers · finish specs · neighbourhood
                guide
              </p>
            </div>
          </div>
          {/* Floating glow behind the card */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 translate-y-6 scale-95 blur-3xl"
            style={{
              background:
                'radial-gradient(closest-side, rgba(184,115,51,0.25), transparent 70%)',
            }}
          />
        </div>

        {/* Form side */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            <span className="inline-flex items-center gap-2">
              <Download className="h-3.5 w-3.5" strokeWidth={2} />
              Get the brochure
            </span>
          </p>
          <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
            The complete dossier, sent to your inbox
          </h2>
          {data.gate_message_richtext?.trim() ? (
            <div
              className="prose prose-lg mt-5 max-w-none prose-p:text-warm-stone prose-p:leading-relaxed"
              dangerouslySetInnerHTML={{ __html: data.gate_message_richtext }}
            />
          ) : (
            <p className="mt-5 text-base sm:text-lg text-warm-stone leading-relaxed">
              We&rsquo;ll email you a single-use download link with the full
              brochure, including pricing, plans, and the neighbourhood guide.
              The link works once and expires in seven days.
            </p>
          )}

          <div className={formWrapClass}>
            <BrochureForm
              csrf={ctx.preCsrf}
              projectId={ctx.projectId}
              projectName={ctx.projectName}
              previewMode={ctx.previewMode}
              fieldStyle={fieldStyle}
            />
          </div>
        </div>
      </div>
    </RevealOnView>
  )
}
