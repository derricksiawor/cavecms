import clsx from 'clsx'
import { Quote } from 'lucide-react'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { BlockData } from '@/lib/cms/block-registry'

// Inline media/projects Map types match what the BLOCK_RENDERERS
// dispatcher in components/blocks/index.tsx passes - it forwards the
// per-page RenderContext maps directly. Importing RenderContext from
// the dispatcher would create a circular module dependency, so we
// duplicate the narrow shape here (matches FeaturedProjects /
// AboutHistory which also rebind the same Map signature locally).
type MediaMap = Map<
  number,
  {
    variants: Record<string, string> | null
    alt_text: string
    width: number | null
    height: number | null
  }
>

type ProjectsMap = Map<
  number,
  {
    slug: string
    name: string
    tagline: string | null
    hero_image_id: number | null
  }
>

// Elementor-parity Testimonial widget. Canonical fields per
// `includes/widgets/testimonial.php`:
//   - testimonial_content (textarea — the quote)
//   - image + image_size
//   - name + job (title/role/company)
//   - link (optional)
//   - alignment + image position
//
// Richer than the plain `quote` widget which is text-only. Carries
// optional headshot (media_id, resolved via RenderContext.media) +
// optional project link (project_id, resolved via RenderContext.projects).
//
// Luxury real-estate visual default per researcher: large decorative
// serif quote glyph in copper at top-left, italic serif body, small
// circular avatar (48-56px) with copper 1px ring, attribution in
// small-caps tracked-out sans. Centred layout reserved for hero
// single-quote sections; left-aligned for sidebar / inline cards.
//
// Inline-edit registers `quote` as 'plain' (matches the existing
// Quote widget). RICHTEXT_FIELDS in parse.ts catches `quote` too -
// defense-in-depth sanitization on a plain field is a no-op but
// guards against a future code change that flips the kind.
//
// Reference URLs:
//   - https://elementor.com/help/testimonial-widget/
//   - https://elementor.com/help/testimonial-carousel-pro/

type TestimonialData = BlockData<'testimonial'>

export function Testimonial({
  data,
  media,
  projects,
  inlineEdit,
  outerClass,
}: {
  data: TestimonialData
  media: MediaMap
  projects: ProjectsMap
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const isCentered = data.alignment === 'center'
  const photo = data.image ? media.get(data.image.media_id) ?? null : null
  // Variant fallback chain spans the full BWC variant set. The media
  // pipeline can produce {sm,md,lg,xl} or a subset depending on source
  // dimensions; we accept any available variant rather than dropping
  // the avatar when the canonical 'md' isn't present.
  const photoSrc =
    photo?.variants?.['md'] ??
    photo?.variants?.['lg'] ??
    photo?.variants?.['sm'] ??
    photo?.variants?.['xl'] ??
    null
  const project = data.project_id ? projects.get(data.project_id) ?? null : null

  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-3xl mx-auto',
        isCentered ? 'text-center' : 'text-left',
        outerClass,
      )}
    >
      <figure className="relative space-y-6">
        {/* Decorative copper quote glyph. aria-hidden because the
            <figure> + role context already signals "this is a quote";
            the glyph is pure visual. */}
        <Quote
          aria-hidden="true"
          strokeWidth={1.25}
          className={clsx(
            'h-10 w-10 text-copper-500',
            isCentered && 'mx-auto',
          )}
        />
        <blockquote
          className={clsx(
            'font-serif text-xl italic leading-relaxed text-near-black sm:text-2xl',
            isCentered ? 'mx-auto max-w-2xl' : 'max-w-2xl',
          )}
        >
          {inlineEdit ? (
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
              className="font-serif italic"
              placeholder="Type the testimonial…"
            />
          ) : (
            <p>&ldquo;{data.quote}&rdquo;</p>
          )}
        </blockquote>
        <figcaption
          className={clsx(
            'flex items-center gap-4',
            isCentered && 'justify-center',
          )}
        >
          {photoSrc && data.image && (
            // RenderContext supplies pre-resolved variant URLs; routing
            // through Next <Image> here re-pipes the same path through
            // the loader for no benefit.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoSrc}
              alt={data.image.alt}
              loading="lazy"
              className="h-14 w-14 rounded-full object-cover ring-1 ring-copper-400/40"
            />
          )}
          {(data.attribution || data.role || project) && (
            <div className="flex flex-col">
              {data.attribution && (
                <span className="text-sm font-semibold text-near-black">
                  {data.attribution}
                </span>
              )}
              {(data.role || project) && (
                <span className="text-[11px] uppercase tracking-[0.18em] text-warm-stone">
                  {data.role}
                  {data.role && project && ' • '}
                  {project && (
                    <a
                      href={`/projects/${project.slug}`}
                      className="hover:text-copper-700"
                    >
                      {project.name}
                    </a>
                  )}
                </span>
              )}
            </div>
          )}
        </figcaption>
      </figure>
    </section>
  )
}
