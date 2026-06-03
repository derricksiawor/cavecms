import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'
import { LxFormClient } from './LxFormClient'

// Composable form (lx_form / E21). Server wrapper resolves the CSRF token +
// renders the heading/intro; the actual fielded form + submission is the
// client island (LxFormClient). In the editor (no csrf), a static preview.
export function LxForm({
  data,
  csrf,
  inlineEdit,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_form'>
  csrf?: string
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const onDark = tone === 'ivory'
  const headClass = onDark ? 'text-ivory' : 'text-near-black'
  const introClass = onDark ? 'text-ivory/75' : 'text-warm-stone'

  return (
    <div className={outerClass}>
      <div className="mx-auto w-full max-w-xl">
        {(data.heading || inlineEdit) && (
          <h2 className={`font-serif text-3xl font-semibold tracking-tight ${headClass}`}>
            {inlineEdit ? (
              <InlineEditable
                blockId={inlineEdit.blockId}
                blockVersion={inlineEdit.blockVersion}
                pageId={inlineEdit.pageId}
                pageVersion={inlineEdit.pageVersion}
                initialData={data}
                field="heading"
                kind="plain"
                initialValue={data.heading ?? ''}
                as="span"
                placeholder="Form heading…"
              />
            ) : (
              data.heading
            )}
          </h2>
        )}
        {data.intro && (
          <p className={`mt-2 font-sans text-base ${introClass}`}>{data.intro}</p>
        )}
        <div className="mt-6">
          {inlineEdit ? (
            <p className={`font-sans text-sm ${introClass}`}>
              The form renders here on the public page. Submit is disabled in
              edit mode. Manage fields + copy in the drawer.
            </p>
          ) : csrf ? (
            <LxFormClient
              fields={data.fields}
              submitLabel={data.submitLabel}
              successHeadline={data.successHeadline}
              successBody={data.successBody}
              formName={data.heading || 'Form'}
              csrf={csrf}
              onDark={onDark}
            />
          ) : (
            <p className={`font-sans text-sm ${introClass}`}>
              Form temporarily unavailable.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
