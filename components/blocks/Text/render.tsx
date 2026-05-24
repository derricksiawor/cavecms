import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

interface TextData {
  heading?: string
  body_richtext: string
}

export function Text({
  data,
  inlineEdit,
  outerClass,
}: {
  data: TextData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  return (
    <section className={clsx('py-12 sm:py-16 px-4 sm:px-6 max-w-3xl mx-auto', outerClass)}>
      {data.heading && (
        <h2 className="text-2xl font-semibold mb-3">{data.heading}</h2>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="body_richtext"
          kind="richtext"
          initialValue={data.body_richtext}
          as="div"
          className="prose"
          placeholder="Type to add text…"
        />
      ) : (
        // server-sanitized via parseForRead
        <div
          className="prose"
          dangerouslySetInnerHTML={{ __html: data.body_richtext }}
        />
      )}
    </section>
  )
}
