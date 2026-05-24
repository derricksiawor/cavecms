import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

interface CtaData {
  title: string
  body?: string
  cta: { text: string; href: string; openInNew?: boolean }
}

// Internal hrefs must not carry "nofollow" (blocks PageRank flow inside
// the site). "noopener noreferrer" still applies to internal new-tab
// opens for window.opener safety.
const EXTERNAL_HREF_RE = /^https?:/i
function linkRel(href: string, openInNew?: boolean): string | undefined {
  if (!openInNew) return undefined
  return EXTERNAL_HREF_RE.test(href)
    ? 'noopener noreferrer nofollow'
    : 'noopener noreferrer'
}

export function Cta({
  data,
  inlineEdit,
  outerClass,
}: {
  data: CtaData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  return (
    <section className={clsx('py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto text-center', outerClass)}>
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="title"
          kind="plain"
          initialValue={data.title}
          as="h2"
          className="text-2xl sm:text-3xl font-semibold tracking-tight"
          placeholder="Type a headline…"
        />
      ) : (
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          {data.title}
        </h2>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="body"
          kind="plain"
          initialValue={data.body ?? ''}
          as="p"
          className="mt-3 max-w-2xl mx-auto text-warm-stone leading-relaxed"
          placeholder="Add supporting copy…"
        />
      ) : (
        data.body && (
          <p className="mt-3 max-w-2xl mx-auto text-warm-stone leading-relaxed">
            {data.body}
          </p>
        )
      )}
      {inlineEdit ? (
        // Edit mode: the CTA pill becomes a span carrying the editable
        // label; href stays drawer-editable via the cta.href inline
        // editor below (rendered as a thin inline url affordance).
        <span className="mt-8 inline-flex flex-col items-center gap-2">
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="cta.text"
            kind="plain"
            initialValue={data.cta.text}
            as="span"
            className="inline-block bg-copper-600 hover:bg-copper-700 text-cream-50 px-7 py-3 rounded-full text-sm font-semibold tracking-wide transition-colors"
            placeholder="Button label…"
          />
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="cta.href"
            kind="plain"
            initialValue={data.cta.href}
            as="span"
            className="text-xs font-mono text-warm-stone"
            placeholder="/contact"
          />
        </span>
      ) : (
        <a
          href={data.cta.href}
          target={data.cta.openInNew ? '_blank' : undefined}
          rel={linkRel(data.cta.href, data.cta.openInNew)}
          className="mt-8 inline-block bg-copper-600 hover:bg-copper-700 text-cream-50 px-7 py-3 rounded-full text-sm font-semibold tracking-wide transition-colors"
        >
          {data.cta.text}
        </a>
      )}
    </section>
  )
}
