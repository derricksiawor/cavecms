import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
interface ImageData { image: { media_id: number; alt: string }; caption?: string; alignment?: 'left' | 'center' | 'right' }
export function ImageBlock({
  data,
  media,
  outerClass,
}: {
  data: ImageData
  media: Map<number, { variants: Record<string, string> | null }>
  outerClass?: string
}) {
  const m = media.get(data.image.media_id)
  // Universal widget padding pattern: py-12 sm:py-16 + px-4 sm:px-6.
  // Centred horizontally via mx-auto unless `alignment` overrides.
  const align = { left: 'mr-auto', center: 'mx-auto', right: 'ml-auto' }[data.alignment ?? 'center']
  return (
    <figure className={clsx('py-12 sm:py-16 px-4 sm:px-6 max-w-3xl', align, outerClass)}>
      <MediaImg media={m} alt={data.image.alt} variant="lg" className="w-full h-auto rounded-xl" />
      {data.caption && <figcaption className="text-sm text-warm-stone mt-3">{data.caption}</figcaption>}
    </figure>
  )
}
