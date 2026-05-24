import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { ContactForm as ContactFormClient } from '@/components/leads/ContactForm'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Luxury contact form wrapper — bold Montserrat heading, no borders,
// champagne accents. Wraps the existing <ContactForm> client form
// (CSRF nonce + honeypot + reCAPTCHA + neutral-200 pipeline
// unchanged) with the CMS-edited heading + intro + success copy.
//
// CSRF degradation: when csrf is the empty string (mint failed
// upstream), the block renders an editorial fallback panel instead
// of a form guaranteed to fail submission.

interface ContactFormData {
  heading: string
  intro?: string
  submit_label: string
  success_headline?: string
  success_body?: string
}

export function ContactForm({
  data,
  inlineEdit,
  outerClass,
  csrf,
  blockId,
}: {
  data: ContactFormData
  inlineEdit?: InlineEditContext
  outerClass?: string
  csrf?: string
  blockId?: number
}) {
  return (
    <section aria-label="Send us a message" className={outerClass}>
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="heading"
          kind="plain"
          initialValue={data.heading}
          as="h2"
          className="font-serif text-3xl sm:text-4xl md:text-5xl font-bold leading-tight tracking-tight text-ivory"
          placeholder="Form heading…"
        />
      ) : (
        <h2 className="font-serif text-3xl sm:text-4xl md:text-5xl font-bold leading-tight tracking-tight text-ivory">
          {data.heading}
        </h2>
      )}
      {data.intro && (
        <p className="mt-5 font-sans text-base sm:text-lg font-medium leading-relaxed text-ivory/70 max-w-[55ch]">
          {data.intro}
        </p>
      )}
      <div className="mt-10">
        {inlineEdit ? (
          // Inline-edit mode — preview placeholder instead of the live
          // form so operators can't accidentally fire a real lead.
          // No border (per CLAUDE.md); champagne tint + glow halo
          // signal "this is where the form will render."
          <div className="relative overflow-hidden rounded-3xl bg-champagne/10 p-10">
            <div
              aria-hidden="true"
              className="lx-glow-champagne absolute -inset-10"
            />
            <div className="relative">
              <p className="font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne">
                Form preview
              </p>
              <p className="mt-3 font-sans text-base font-medium text-ivory/70">
                The contact form renders here on the public page. Submit
                is disabled in edit mode. Heading text edits inline;
                intro, submit-button label, and success copy edit in the
                drawer.
              </p>
            </div>
          </div>
        ) : csrf ? (
          <ContactFormClient
            csrf={csrf}
            submitLabel={data.submit_label}
            blockId={blockId}
          />
        ) : (
          <p className="font-sans text-sm font-medium text-ivory/60">
            Message form temporarily unavailable. Please reach us via the
            email or phone above.
          </p>
        )}
      </div>
    </section>
  )
}
