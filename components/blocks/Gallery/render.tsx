import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { AltTextOverlay } from '@/components/inline-edit/AltTextOverlay'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

interface GalleryData {
  images: Array<{ media_id: number; alt: string; caption?: string }>
  columns: 2 | 3 | 4
}

export function Gallery({
  data,
  media,
  outerClass,
  inlineEdit,
}: {
  data: GalleryData
  media: Map<number, { variants: Record<string, string> | null }>
  outerClass?: string
  inlineEdit?: InlineEditContext
}) {
  const cols = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-4',
  }[data.columns]
  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-6xl mx-auto',
        outerClass,
      )}
    >
      <div className={clsx('grid gap-3 sm:gap-4', cols)}>
        {data.images.map((img, i) => (
          <figure key={i} className="relative">
            <MediaImg
              media={media.get(img.media_id)}
              alt={img.alt}
              variant="md"
              className="w-full h-48 object-cover rounded-xl"
            />
            {inlineEdit && (
              <AltTextOverlay
                blockId={inlineEdit.blockId}
                blockVersion={inlineEdit.blockVersion}
                pageId={inlineEdit.pageId}
                pageVersion={inlineEdit.pageVersion}
                initialData={data}
                field="images[].alt"
                arrayIndices={[i]}
                initialValue={img.alt ?? ''}
              />
            )}
            {/* Caption is inline-editable per image. Array-indexed path
                `images[].caption` resolves the per-row write via
                InlineEditable.arrayIndices — the merge step routes
                through setFieldValue so untouched sibling rows stay
                reference-stable. */}
            {inlineEdit ? (
              <figcaption className="text-xs text-warm-stone mt-2">
                <InlineEditable
                  blockId={inlineEdit.blockId}
                  blockVersion={inlineEdit.blockVersion}
                  pageId={inlineEdit.pageId}
                  pageVersion={inlineEdit.pageVersion}
                  initialData={data}
                  field="images[].caption"
                  arrayIndices={[i]}
                  kind="plain"
                  initialValue={img.caption ?? ''}
                  as="span"
                  placeholder="Add a caption…"
                />
              </figcaption>
            ) : (
              img.caption && (
                <figcaption className="text-xs text-warm-stone mt-2">
                  {img.caption}
                </figcaption>
              )
            )}
          </figure>
        ))}
      </div>
    </section>
  )
}
