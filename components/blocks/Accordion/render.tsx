'use client'
import clsx from 'clsx'
import { useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Tailwind Typography prose overrides matching the BWC palette — without
// these, anchor links inside rich text render in default prose blue and
// strong/em fall back to greyscale, breaking the editorial copper accent.
const PROSE_PALETTE =
  'prose-headings:text-near-black prose-a:text-copper-600 prose-a:no-underline hover:prose-a:underline prose-strong:text-near-black prose-em:text-copper-700 prose-li:marker:text-copper-500'

// Elementor-parity Accordion widget. Canonical Elementor fields per
// `includes/widgets/accordion.php`:
//   - tabs (repeater): tab_title + tab_content (richtext WYSIWYG)
//   - selected_icon (default fas fa-plus), selected_active_icon (fa-minus)
//   - title_html_tag (h1..h6 | div, default div)
//   - faq_schema (switcher — emits FAQPage JSON-LD)
//
// Elementor-parity finding from web research (NON-OBVIOUS):
// **Elementor's classic Accordion ships NO "allow multiple open" toggle
// and NO "default open item" control.** Behaviour is single-open,
// first-item-closed-on-load, driven by client JS.
//
// BWC ships BOTH knobs intentionally — they serve the SEO/no-JS render
// architecture, not Elementor parity for parity's sake:
//   - default_open_index lets operators pre-expand a key item so search
//     crawlers see that body content as visible on first paint. Without
//     this, every accordion body reads as collapsed in the rendered HTML
//     even though the markup contains the text.
//   - allow_multiple lets operators choose between HTML5 exclusive mode
//     (name="" group attribute, Chrome 120+ / Safari 17+ / Firefox 121+)
//     and permissive mode (every item independently toggleable). Falls
//     back to permissive on older browsers — acceptable progressive
//     enhancement; nothing breaks.
//
// Server-rendered — uses native <details>/<summary>. No JavaScript, no
// React state, no client bundle cost. The ChevronDown rotation comes
// from the named [open] group selector + Tailwind's group-open variant.
//
// Reference URLs:
//   - https://elementor.com/help/accordion-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/accordion.php
//   - https://developer.wordpress.org/block-editor/reference-guides/core-blocks/

interface AccordionItem {
  title: string
  body_richtext: string
}

interface AccordionData {
  items: AccordionItem[]
  default_open_index?: number
  allow_multiple: boolean
  variant: 'accordion' | 'list'
}

export function Accordion({
  data,
  outerClass,
  inlineEdit,
}: {
  data: AccordionData
  outerClass?: string
  inlineEdit?: InlineEditContext
}) {
  // useId() works in server components (it's stateless). We strip the
  // colons React emits so the value is safe inside an HTML name="..."
  // attribute. Multiple Accordion widgets on the same page each get a
  // unique name group, so their exclusive behaviour never bleeds across
  // accordions.
  const id = useId().replace(/:/g, '')
  if (data.items.length === 0) return null

  // Clamp default_open_index — operator may have shrunk the items array
  // since persisting the index. A stale index gracefully falls to "no
  // item open by default" rather than throwing.
  const openIndex =
    typeof data.default_open_index === 'number' &&
    data.default_open_index >= 0 &&
    data.default_open_index < data.items.length
      ? data.default_open_index
      : -1

  // 'list' variant: every item visible by default, bold question over a
  // paragraph answer, separated by horizontal divider lines. No <details>,
  // no chevron, no interactivity — the editorial FAQ shape from the
  // boxxticket reference. Operators flip via the EditDrawer's variant
  // select.
  if (data.variant === 'list') {
    return (
      <section
        className={clsx(
          'py-12 sm:py-16 px-4 sm:px-6 max-w-3xl mx-auto',
          outerClass,
        )}
      >
        <ul className="divide-y divide-warm-stone/20 border-t border-b border-warm-stone/20">
          {data.items.map((item, i) => (
            <li key={i} className="py-6">
              {inlineEdit ? (
                <InlineEditable
                  blockId={inlineEdit.blockId}
                  blockVersion={inlineEdit.blockVersion}
                  pageId={inlineEdit.pageId}
                  pageVersion={inlineEdit.pageVersion}
                  initialData={data}
                  field="items[].title"
                  arrayIndices={[i]}
                  kind="plain"
                  initialValue={item.title}
                  as="h3"
                  className="text-lg font-semibold tracking-tight text-near-black"
                  placeholder="Item title"
                />
              ) : (
                <h3 className="text-lg font-semibold tracking-tight text-near-black">
                  {item.title}
                </h3>
              )}
              {inlineEdit ? (
                <InlineEditable
                  blockId={inlineEdit.blockId}
                  blockVersion={inlineEdit.blockVersion}
                  pageId={inlineEdit.pageId}
                  pageVersion={inlineEdit.pageVersion}
                  initialData={data}
                  field="items[].body_richtext"
                  arrayIndices={[i]}
                  kind="richtext"
                  initialValue={item.body_richtext}
                  as="div"
                  className={clsx(
                    'prose mt-2 max-w-none text-sm leading-relaxed text-near-black/70',
                    PROSE_PALETTE,
                  )}
                  placeholder="Item body…"
                />
              ) : (
                <div
                  className={clsx(
                    'prose mt-2 max-w-none text-sm leading-relaxed text-near-black/70',
                    PROSE_PALETTE,
                  )}
                  dangerouslySetInnerHTML={{ __html: item.body_richtext }}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-3xl mx-auto',
        outerClass,
      )}
    >
      <div className="divide-y divide-warm-stone/20 border-t border-b border-warm-stone/20">
        {data.items.map((item, i) => (
          <details
            // The name= attribute is the HTML-spec trigger for exclusive
            // accordion behaviour (Chrome 120+, Safari 17+, Firefox 121+).
            // Emitted only when allow_multiple is false; older browsers
            // treat it as unknown and accordions act permissive.
            name={data.allow_multiple ? undefined : `accordion-${id}`}
            open={i === openIndex ? true : undefined}
            // Key includes the default-open membership so React unmounts/
            // remounts the <details> only when openIndex actually changes.
            // Without this, parent re-renders (any context dispatch, a
            // sibling save, the EditDrawer opening) would re-apply
            // `open={true}` and undo the operator's manual close — React
            // always wins when its prop is explicitly true. Keying by
            // open membership makes the reconciler treat user-toggled
            // <details> as the same element across renders.
            key={`${i}-${i === openIndex ? 'o' : 'c'}`}
            className="group/item"
          >
            <summary
              // stopPropagation on the summary keeps the editor's
              // "click body → open EditDrawer" handler from firing in
              // parallel with the native <details> toggle. The summary
              // still toggles natively (no preventDefault).
              onClick={(e) => e.stopPropagation()}
              className="flex cursor-pointer items-center justify-between gap-4 py-4 text-left min-h-[44px] list-none [&::-webkit-details-marker]:hidden rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/50"
            >
              {inlineEdit ? (
                <InlineEditable
                  blockId={inlineEdit.blockId}
                  blockVersion={inlineEdit.blockVersion}
                  pageId={inlineEdit.pageId}
                  pageVersion={inlineEdit.pageVersion}
                  initialData={data}
                  field="items[].title"
                  arrayIndices={[i]}
                  kind="plain"
                  initialValue={item.title}
                  as="span"
                  className="text-base font-semibold text-near-black"
                  placeholder="Item title"
                />
              ) : (
                <span className="text-base font-semibold text-near-black">
                  {item.title}
                </span>
              )}
              <ChevronDown
                aria-hidden="true"
                strokeWidth={1.75}
                className="h-5 w-5 shrink-0 text-warm-stone transition-transform duration-standard ease-standard group-open/item:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            {inlineEdit ? (
              <InlineEditable
                blockId={inlineEdit.blockId}
                blockVersion={inlineEdit.blockVersion}
                pageId={inlineEdit.pageId}
                pageVersion={inlineEdit.pageVersion}
                initialData={data}
                field="items[].body_richtext"
                arrayIndices={[i]}
                kind="richtext"
                initialValue={item.body_richtext}
                as="div"
                className={clsx(
                  'prose pb-4 max-w-none text-warm-stone',
                  PROSE_PALETTE,
                )}
                placeholder="Item body…"
              />
            ) : (
              // server-sanitized via parseForRead — RICHTEXT_FIELDS walker
              // catches `body_richtext` at any depth.
              <div
                className={clsx(
                  'prose pb-4 max-w-none text-warm-stone',
                  PROSE_PALETTE,
                )}
                dangerouslySetInnerHTML={{ __html: item.body_richtext }}
              />
            )}
          </details>
        ))}
      </div>
    </section>
  )
}
