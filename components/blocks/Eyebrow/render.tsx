import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Eyebrow / kicker. Small uppercase tracking-wide accent line that sits
// above a hero h1 or section h2 — the editorial "section marker" that
// every well-set page leans on for vertical rhythm. Renders as a <p>
// (NOT a heading element) because semantically it's a label, not a
// section title; the heading widget directly below it owns the page's
// semantic outline. Three brand-mapped color tokens: copper accent
// (default, eye-catching), warm-stone (muted secondary), near-black
// (high-contrast on light backgrounds).
//
// The tracking-[0.24em] value matches the boxxticket reference at the
// hero kicker tier. Tighter trackings read as too compressed for the
// 11px size on retina; wider trackings split words on narrow viewports.

interface EyebrowData {
  text: string
  color: 'copper' | 'warm-stone' | 'near-black'
  alignment: 'left' | 'center' | 'right'
}

const COLOR_CLASS: Record<EyebrowData['color'], string> = {
  copper: 'text-copper-600',
  'warm-stone': 'text-warm-stone',
  'near-black': 'text-near-black',
}

// On mobile, eyebrow labels always center (any saved alignment is
// ignored below md so single-line short kickers read centered on
// 375px viewports). md+ honours the operator's chosen alignment.
const ALIGN_CLASS: Record<EyebrowData['alignment'], string> = {
  left: 'text-center md:text-left',
  center: 'text-center',
  right: 'text-center md:text-right',
}

export function Eyebrow({
  data,
  inlineEdit,
  outerClass,
}: {
  data: EyebrowData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const labelClass = clsx(
    'text-[11px] font-semibold uppercase tracking-[0.24em]',
    COLOR_CLASS[data.color],
    ALIGN_CLASS[data.alignment],
  )
  return (
    <section
      className={clsx('px-4 sm:px-6 max-w-4xl mx-auto', outerClass)}
    >
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="text"
          kind="plain"
          initialValue={data.text}
          as="p"
          className={labelClass}
          placeholder="KICKER LABEL"
        />
      ) : (
        <p className={labelClass}>{data.text}</p>
      )}
    </section>
  )
}
