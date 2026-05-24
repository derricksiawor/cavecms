import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
interface FeaturedProjectsData { title?: string; project_ids: number[]; layout: 'grid' | 'carousel' }

// Featured-projects card grid. Sizing tuned to read as the page's
// signature moment rather than a thumbnail strip: wider container
// (max-w-7xl), taller images (h-80 / sm:h-96 / lg:h-[28rem]),
// editorial spacing, and larger card type. The 3-up grid stays the
// same — only the cell dimensions grow.
export function FeaturedProjects({
  data,
  projects,
  media,
  outerClass,
}: {
  data: FeaturedProjectsData
  projects: Map<number, { slug: string; name: string; tagline: string | null; hero_image_id: number | null }>
  media: Map<number, { variants: Record<string, string> | null }>
  outerClass?: string
}) {
  const list = data.project_ids.map((id) => projects.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
  return (
    <section className={clsx('py-12 sm:py-20 px-4 sm:px-8 max-w-7xl mx-auto', outerClass)}>
      {data.title && <h2 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight mb-10">{data.title}</h2>}
      <ul className="grid grid-cols-1 md:grid-cols-3 gap-8 sm:gap-10">
        {list.map((p) => (
          <li key={p.slug}>
            <a href={`/projects/${p.slug}`} className="block group">
              <MediaImg
                media={p.hero_image_id ? media.get(p.hero_image_id) : undefined}
                alt={p.name}
                variant="lg"
                className="w-full h-80 sm:h-96 lg:h-[28rem] object-cover rounded-2xl transition-transform duration-standard ease-standard group-hover:scale-[1.02]"
              />
              <h3 className="mt-5 font-serif text-xl sm:text-2xl font-bold tracking-tight">{p.name}</h3>
              {p.tagline && <p className="mt-2 text-base leading-relaxed opacity-80">{p.tagline}</p>}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
