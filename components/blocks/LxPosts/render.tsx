import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { MediaImg } from '../MediaImg'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'
import { isSectionSurfaceDark, type SectionMeta } from '@/lib/cms/blockMeta'

// Dynamic posts loop (Elementor: Posts / Loop Grid). Renders the latest
// published posts, resolved by hydrate.ts (never queried here — same
// contract as lx_featured_projects). Text auto-contrasts the ancestor
// section surface. Server component.

const COLS: Record<BlockData<'lx_posts'>['columns'], string> = {
  2: 'grid-cols-1 sm:grid-cols-2 gap-8 sm:gap-10',
  3: 'grid-cols-1 md:grid-cols-3 gap-8 sm:gap-10',
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function LxPosts({
  data,
  posts,
  media,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_posts'>
  posts?: RenderContext['posts']
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const onDark = isSectionSurfaceDark(sectionMeta)
  const headingClass = onDark ? 'text-ivory' : 'text-obsidian'
  const titleClass = onDark ? 'text-ivory' : 'text-obsidian'
  const excerptClass = onDark ? 'text-ivory/70' : 'text-warm-stone'

  const list = [...(posts?.values() ?? [])].slice(0, data.limit)

  if (list.length === 0) {
    // No published posts. Public render: nothing. (The editor preview
    // path doesn't thread posts, so this also covers "in editor".)
    return null
  }

  const isList = data.layout === 'list'

  const section = (
    <section className={clsx('mx-auto w-full max-w-6xl', outerClass)}>
      {data.heading && (
        <h2 className={clsx('mb-10 font-serif text-3xl font-bold tracking-tight sm:text-4xl', headingClass)}>
          {data.heading}
        </h2>
      )}
      <ul
        className={clsx(
          isList ? 'flex flex-col gap-8' : 'grid',
          !isList && COLS[data.columns],
        )}
      >
        {list.map((p) => {
          const date = data.showDate ? formatDate(p.published_at) : null
          return (
            <li key={p.id}>
              <a
                href={`/blog/${p.slug}`}
                className={clsx('group block', isList && 'flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8')}
              >
                <div className={clsx('overflow-hidden rounded-2xl', isList && 'sm:w-2/5 sm:shrink-0')}>
                  <MediaImg
                    media={p.hero_image_id ? media.get(p.hero_image_id) : undefined}
                    alt={p.title}
                    variant="md"
                    className={clsx(
                      'w-full object-cover transition-transform duration-standard ease-standard group-hover:scale-[1.02]',
                      isList ? 'h-48 sm:h-44' : 'h-56',
                    )}
                  />
                </div>
                <div className={clsx(isList && 'sm:flex-1')}>
                  {date && (
                    <time
                      className="mt-4 block font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne sm:mt-0"
                      dateTime={new Date(p.published_at as string | Date).toISOString()}
                    >
                      {date}
                    </time>
                  )}
                  <h3 className={clsx('mt-2 font-serif text-xl font-bold tracking-tight sm:text-2xl', titleClass)}>
                    {p.title}
                  </h3>
                  {data.showExcerpt && p.excerpt && (
                    <p className={clsx('mt-2 line-clamp-3 font-sans text-base leading-relaxed', excerptClass)}>
                      {p.excerpt}
                    </p>
                  )}
                </div>
              </a>
            </li>
          )
        })}
      </ul>
    </section>
  )

  if (data.animation === 'none') return section
  return <MotionTarget preset={data.animation}>{section}</MotionTarget>
}
