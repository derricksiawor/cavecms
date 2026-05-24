import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Elementor-parity Heading widget. Canonical field set per Elementor's
// `includes/widgets/heading.php`:
//   - title (text)
//   - header_size: h1 | h2 | h3 | h4 | h5 | h6 | div | span | p (default h2)
//   - align: start | center | end | justify (default unset → left)
//   - size: small | medium | large | xl | xxl (typography preset)
// BWC collapses Elementor's `size` knob into `level` since semantic level
// + Tailwind type scale handle visual size implicitly. We keep `weight`
// and `font` as additional knobs because Elementor's `typography` group
// control would be overkill in the BWC drawer.
//
// Default level is h2 (NOT h1) — every page already has an H1 in its
// page-metadata block (Hero on home, page heading on inner pages). An
// operator-added Heading defaulting to h1 would cause two H1s on the
// same page → SEO regression. h1 stays accessible via the level select
// for the rare case where the operator IS authoring the page H1.
//
// Reference URLs (embedded by the elite-web-researcher pass):
//   - https://elementor.com/help/heading-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/heading.php
//   - https://developer.wordpress.org/block-editor/reference-guides/core-blocks/

interface HeadingData {
  text: string
  level: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  alignment: 'left' | 'center' | 'right' | 'justify'
  weight: 'regular' | 'semibold' | 'bold'
  font: 'sans' | 'serif'
}

const LEVEL_CLASS: Record<HeadingData['level'], string> = {
  h1: 'text-4xl sm:text-5xl md:text-6xl',
  h2: 'text-3xl sm:text-4xl md:text-5xl',
  h3: 'text-2xl sm:text-3xl',
  h4: 'text-xl sm:text-2xl',
  h5: 'text-lg sm:text-xl',
  h6: 'text-base sm:text-lg',
}

const ALIGN_CLASS: Record<HeadingData['alignment'], string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
  justify: 'text-justify',
}

const WEIGHT_CLASS: Record<HeadingData['weight'], string> = {
  regular: 'font-normal',
  semibold: 'font-semibold',
  bold: 'font-bold',
}

const FONT_CLASS: Record<HeadingData['font'], string> = {
  sans: 'font-sans',
  serif: 'font-serif',
}

export function Heading({
  data,
  inlineEdit,
  outerClass,
}: {
  data: HeadingData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const Tag = data.level
  const headingClass = clsx(
    LEVEL_CLASS[data.level],
    ALIGN_CLASS[data.alignment],
    WEIGHT_CLASS[data.weight],
    FONT_CLASS[data.font],
    'tracking-tight text-near-black',
  )
  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
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
          as={Tag}
          className={headingClass}
          placeholder="Type a heading…"
        />
      ) : (
        <Tag className={headingClass}>{data.text}</Tag>
      )}
    </section>
  )
}
