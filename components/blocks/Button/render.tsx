import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Elementor-parity Button widget. Canonical Elementor fields per the
// shared button-trait source:
//   - text, link (url + nofollow + custom_attributes)
//   - size: xs | sm | md | lg | xl (5 named presets — NO free-form pixel knob)
//   - button_type: default | info | success | warning | danger (semantic palette)
//   - selected_icon, icon_align (icon before/after text — out of scope for Chunk F)
//   - hover_animation (Elementor's named set — replaced by a single CSS transition)
//
// CaveCMS swaps Elementor's semantic button_type (success/danger) for stylistic
// variants (primary/secondary/ghost) because CaveCMS pages are editorial sales
// surfaces, not application UIs — green/yellow/red colour-coding carries no
// luxury-RE meaning. The 5 size presets stay because they match Elementor's
// curation; a free-form pixel knob is intentionally not exposed (operators
// would drift out of the type scale and the design system would erode).
//
// Touch-target floor: every size renders with min-h-[44px] to honour WCAG
// 2.5.5 and project standards's mobile-touch rule even at xs.
//
// Reference URLs:
//   - https://elementor.com/help/button-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/traits/button-trait.php
//   - https://developer.wordpress.org/block-editor/reference-guides/core-blocks/

interface ButtonData {
  text: string
  href: string
  openInNew?: boolean
  variant: 'primary' | 'secondary' | 'ghost'
  size: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  alignment: 'left' | 'center' | 'right'
}

const SIZE_CLASS: Record<ButtonData['size'], string> = {
  xs: 'px-3 py-2 text-xs',
  sm: 'px-4 py-2.5 text-xs',
  md: 'px-6 py-3 text-sm',
  lg: 'px-8 py-3.5 text-base',
  xl: 'px-10 py-4 text-lg',
}

const VARIANT_CLASS: Record<ButtonData['variant'], string> = {
  primary:
    'bg-copper-600 text-cream-50 hover:bg-copper-700 border border-transparent',
  secondary:
    'bg-transparent text-near-black border border-near-black hover:bg-near-black hover:text-cream-50',
  ghost:
    'bg-transparent text-near-black hover:bg-near-black/5 border border-transparent',
}

const ALIGN_CONTAINER: Record<ButtonData['alignment'], string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

// External-vs-internal href detection for the rel attribute. Internal
// hrefs (relative paths, mailto:, tel:, same-origin links) must NOT
// carry "nofollow" — that blocks PageRank flow inside the site and is
// an explicit SEO anti-pattern. "noopener noreferrer" still applies to
// internal new-tab opens for window.opener safety.
const EXTERNAL_HREF_RE = /^https?:/i
function linkRel(href: string, openInNew?: boolean): string | undefined {
  if (!openInNew) return undefined
  return EXTERNAL_HREF_RE.test(href)
    ? 'noopener noreferrer nofollow'
    : 'noopener noreferrer'
}

export function Button({
  data,
  inlineEdit,
  outerClass,
}: {
  data: ButtonData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const buttonClass = clsx(
    'inline-flex items-center justify-center w-fit rounded-full font-semibold tracking-wide min-h-[44px] transition-colors duration-quick ease-standard',
    SIZE_CLASS[data.size],
    VARIANT_CLASS[data.variant],
  )
  return (
    <section
      // Alignment placed AFTER outerClass so the widget's own alignment
      // intent wins if Chunk E's spacing toolbar ever broadens to emit
      // text-alignment overrides. Today outerClass only carries spacing
      // tokens, but ordering defensively now keeps a future divergence
      // from silently flipping the alignment.
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
        ALIGN_CONTAINER[data.alignment],
      )}
    >
      {inlineEdit ? (
        // In edit mode, the editable text lives inside a button-styled
        // span — the href is intentionally inert during editing (the
        // operator clicks/types to edit; the public render restores the
        // <a> + target/rel pair). The href surfaces as a thin inline
        // url affordance below the button so operators can retarget
        // without opening the drawer.
        <span className="inline-flex flex-col items-center gap-2">
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="text"
            kind="plain"
            initialValue={data.text}
            as="span"
            className={buttonClass}
            placeholder="Button text…"
          />
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="href"
            kind="plain"
            initialValue={data.href}
            as="span"
            className="text-xs font-mono text-warm-stone"
            placeholder="/contact"
          />
        </span>
      ) : (
        <a
          href={data.href}
          target={data.openInNew ? '_blank' : undefined}
          rel={linkRel(data.href, data.openInNew)}
          className={buttonClass}
        >
          {data.text}
        </a>
      )}
    </section>
  )
}
