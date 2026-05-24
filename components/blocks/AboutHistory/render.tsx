import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
interface AboutHistoryData { title: string; body_richtext: string; image?: { media_id: number; alt: string } }
export function AboutHistory({
  data,
  media,
  outerClass,
}: {
  data: AboutHistoryData
  media: Map<number, { variants: Record<string, string> | null }>
  outerClass?: string
}) {
  const m = data.image ? media.get(data.image.media_id) : undefined
  return (
    <section className={clsx('py-12 sm:py-16 px-4 sm:px-6 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-10 items-center', outerClass)}>
      <div>
        <h2 className="text-3xl font-semibold tracking-tight mb-3">{data.title}</h2>
        {/* server-sanitized via parseForRead */}
        <div className="prose" dangerouslySetInnerHTML={{ __html: data.body_richtext }} />
      </div>
      {m && data.image && <MediaImg media={m} alt={data.image.alt} variant="lg" className="w-full h-72 object-cover rounded-xl" />}
    </section>
  )
}
