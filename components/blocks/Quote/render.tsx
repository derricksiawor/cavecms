import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

interface QuoteData {
  quote: string
  attribution?: string
  attribution_title?: string
}

export function Quote({
  data,
  inlineEdit,
  outerClass,
}: {
  data: QuoteData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  return (
    <blockquote
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-2xl mx-auto text-center',
        outerClass,
      )}
    >
      {inlineEdit ? (
        // Editing surface intentionally omits the visual quote marks
        // around the body — the operator types raw text; the public
        // (non-edit) render adds the surrounding quotes for display.
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="quote"
          kind="plain"
          initialValue={data.quote}
          as="p"
          className="text-xl italic"
          placeholder="Type a quote…"
        />
      ) : (
        <p className="text-xl italic">&quot;{data.quote}&quot;</p>
      )}
      {inlineEdit ? (
        <footer className="mt-3 text-sm text-warm-stone">
          <span aria-hidden="true">— </span>
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="attribution"
            kind="plain"
            initialValue={data.attribution ?? ''}
            as="span"
            placeholder="Attribution"
          />
          <span aria-hidden="true">, </span>
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="attribution_title"
            kind="plain"
            initialValue={data.attribution_title ?? ''}
            as="span"
            placeholder="Role / title"
          />
        </footer>
      ) : (
        data.attribution && (
          <footer className="mt-3 text-sm text-warm-stone">
            — {data.attribution}
            {data.attribution_title && `, ${data.attribution_title}`}
          </footer>
        )
      )}
    </blockquote>
  )
}
