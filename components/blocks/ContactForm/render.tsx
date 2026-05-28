import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { ContactForm as ContactFormClient } from '@/components/leads/ContactForm'
import { isSectionSurfaceDark, type SectionMeta } from '@/lib/cms/blockMeta'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Luxury contact form wrapper. Theme is derived from the ancestor
// section's surface (via `isSectionSurfaceDark`) rather than hardcoded
// — so a contact_form dropped onto a `bg: 'ivory'` or `bg: 'cream'`
// section reads correctly (obsidian text on cream fill) instead of
// rendering invisible ivory-on-cream. When the block is rendered at
// page root (no ancestor section), the surface defaults to light.

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
  sectionMeta,
}: {
  data: ContactFormData
  inlineEdit?: InlineEditContext
  outerClass?: string
  csrf?: string
  blockId?: number
  sectionMeta?: SectionMeta
}) {
  const onDark = isSectionSurfaceDark(sectionMeta)
  const headingClass = onDark ? 'text-ivory' : 'text-obsidian'
  const introClass = onDark ? 'text-ivory/70' : 'text-obsidian/70'
  const fallbackClass = onDark ? 'text-ivory/60' : 'text-obsidian/60'
  const eyebrowClass = onDark ? 'text-champagne' : 'text-copper-700'
  // The inline-edit preview card uses a tinted panel to communicate
  // "form will land here". On a dark section a champagne tint works;
  // on a light section the same tint blows out into the cream bg —
  // copper reads as the editorial accent on light surfaces.
  const previewPanelClass = onDark
    ? 'relative overflow-hidden rounded-3xl bg-champagne/10 p-10'
    : 'relative overflow-hidden rounded-3xl bg-copper-500/10 p-10'
  const previewGlowClass = onDark
    ? 'lx-glow-champagne absolute -inset-10'
    : 'lx-glow-copper absolute -inset-10'
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
          className={`font-serif text-3xl sm:text-4xl md:text-5xl font-bold leading-tight tracking-tight ${headingClass}`}
          placeholder="Form heading…"
        />
      ) : (
        <h2 className={`font-serif text-3xl sm:text-4xl md:text-5xl font-bold leading-tight tracking-tight ${headingClass}`}>
          {data.heading}
        </h2>
      )}
      {data.intro && (
        <p className={`mt-5 font-sans text-base sm:text-lg font-medium leading-relaxed max-w-[55ch] ${introClass}`}>
          {data.intro}
        </p>
      )}
      <div className="mt-10">
        {inlineEdit ? (
          <div className={previewPanelClass}>
            <div aria-hidden="true" className={previewGlowClass} />
            <div className="relative">
              <p className={`font-sans text-xs font-semibold uppercase tracking-eyebrow ${eyebrowClass}`}>
                Form preview
              </p>
              <p className={`mt-3 font-sans text-base font-medium ${introClass}`}>
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
            surface={onDark ? 'dark' : 'light'}
          />
        ) : (
          <p className={`font-sans text-sm font-medium ${fallbackClass}`}>
            Message form temporarily unavailable. Please reach us via the
            email or phone above.
          </p>
        )}
      </div>
    </section>
  )
}
