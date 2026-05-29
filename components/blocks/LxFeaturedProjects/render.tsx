import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { RenderContext } from '..'
import { isSectionSurfaceDark, type SectionMeta } from '@/lib/cms/blockMeta'

// Data-driven project card grid (0.1.54 — the lx_ successor to the
// purged legacy `featured_projects`). There is no per-block selection:
// the grid auto-renders the projects the operator marked Featured (via
// projects.featured_order, managed in the Projects admin). hydrate.ts
// fetches them in featured order + fills RenderContext.projects with
// their hero images, so each card resolves name / tagline / hero photo
// live — rename a project, swap its hero, or re-order Featured, and the
// grid follows automatically.

const COLS_CLASS: Record<BlockData<'lx_featured_projects'>['columns'], string> = {
  2: 'grid-cols-1 sm:grid-cols-2 gap-8 sm:gap-10',
  3: 'grid-cols-1 md:grid-cols-3 gap-8 sm:gap-10',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8',
}

export function LxFeaturedProjects({
  data,
  projects,
  media,
  inlineEdit,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_featured_projects'>
  projects: RenderContext['projects']
  media: RenderContext['media']
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  // Text colour AUTO-CONTRASTS the ancestor section's surface (light text
  // on dark sections, dark text on light) so the grid is legible wherever
  // it's dropped. There is no per-block tone field to mismatch the
  // background — the section background is the single source of truth.
  const onDark = isSectionSurfaceDark(sectionMeta)
  const headingClass = onDark ? 'text-ivory' : 'text-obsidian'
  const nameClass = onDark ? 'text-ivory' : 'text-obsidian'
  const taglineClass = onDark ? 'text-ivory/70' : 'text-obsidian/70'

  // hydrate fills `projects` with the Featured projects in featured
  // order; the Map preserves that order, so iterate its values directly.
  const list = [...projects.values()]

  // No Featured projects. In the editor, surface a hint pointing the
  // operator at the Projects admin; on the public page render nothing
  // rather than an empty grid frame.
  if (list.length === 0) {
    if (!inlineEdit) return null
    return (
      <section className={clsx('mx-auto max-w-7xl px-4 sm:px-8 py-12 sm:py-20', outerClass)}>
        <div className="rounded-2xl bg-champagne/10 p-10 text-center">
          <p className="font-sans text-sm font-medium text-warm-stone">
            No featured projects yet. Mark projects as Featured under
            Projects &rarr; Featured order, and they&rsquo;ll appear here
            automatically.
          </p>
        </div>
      </section>
    )
  }

  const section = (
    <section className={clsx('mx-auto max-w-7xl px-4 sm:px-8 py-12 sm:py-20', outerClass)}>
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
          as="h2"
          className={clsx(
            'font-serif text-3xl sm:text-4xl font-bold tracking-tight mb-10',
            headingClass,
          )}
          placeholder="Section heading…"
        />
      ) : (
        data.heading && (
          <h2
            className={clsx(
              'font-serif text-3xl sm:text-4xl font-bold tracking-tight mb-10',
              headingClass,
            )}
          >
            {data.heading}
          </h2>
        )
      )}
      <ul className={clsx('grid', COLS_CLASS[data.columns])}>
        {list.map((p) => (
          <li key={p.slug}>
            <a href={`/projects/${p.slug}`} className="block group">
              <MediaImg
                media={p.hero_image_id ? media.get(p.hero_image_id) : undefined}
                alt={p.name}
                variant="lg"
                className="w-full h-80 sm:h-96 lg:h-[28rem] object-cover rounded-2xl transition-transform duration-standard ease-standard group-hover:scale-[1.02]"
              />
              <h3
                className={clsx(
                  'mt-5 font-serif text-xl sm:text-2xl font-bold tracking-tight',
                  nameClass,
                )}
              >
                {p.name}
              </h3>
              {p.tagline && (
                <p className={clsx('mt-2 text-base leading-relaxed', taglineClass)}>
                  {p.tagline}
                </p>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )

  // 'none' early-return narrows data.animation to the MotionPreset
  // union (MotionTarget's preset type excludes 'none'). Mirrors LxGallery.
  if (data.animation === 'none') return section
  return <MotionTarget preset={data.animation}>{section}</MotionTarget>
}
