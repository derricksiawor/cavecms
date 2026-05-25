import type { ReactNode } from 'react'
import { MediaImg } from '@/components/blocks/MediaImg'
import { statusLabel } from '../_shared/labels'
import type { HeroData, MediaMap, ProjectPublicContext } from '../_shared/types'

// Full-bleed hero. Anna-tier: full-viewport-height image, layered
// gradient overlay for legibility, eyebrow + serif H2 + tagline,
// dual-CTA cluster (Schedule a tour / Download brochure) that
// scrolls to the corresponding section IDs.
//
// Renders nothing when `banner_image` is null AND tagline/status
// are empty — a fresh project should not look like an error page.
// When banner_image is null but other content exists, falls back
// to a textured cream panel (no broken image).
//
// CTAs hash-link to in-page section IDs:
//   #inquiry-form   (anchored by the InquiryForm section render)
//   #brochure        (anchored by the Brochure section render)
// Browsers handle the smooth-scroll via globals; the StickyHeader's
// CTA does the same hop.

export function HeroSection({
  data,
  media,
  ctx,
}: {
  data: HeroData
  media: MediaMap
  ctx: ProjectPublicContext
}): ReactNode {
  const m = data.banner_image ? media.get(data.banner_image.media_id) : undefined
  const hasImage = !!data.banner_image && !!m?.variants
  const badge =
    (data.status_label && data.status_label.trim()) ||
    statusLabel(ctx.projectStatus)

  return (
    <section
      id="project-hero"
      className="relative isolate overflow-hidden bg-near-black text-cream"
      // animate-cavecms-rise reserved for hero entrances per Chunk D.
      // Applied to the inner block so the section background does not
      // flash from cream to near-black after the page paints.
    >
      {hasImage && data.banner_image && m ? (
        <MediaImg
          media={m}
          alt={data.banner_image.alt || ctx.projectName}
          variant="lg"
          priority
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        // Textured cream fallback — better than an empty void for an
        // unpublished-but-being-edited hero with no image yet.
        <div
          aria-hidden
          className="absolute inset-0 bg-cream-100"
          style={{
            backgroundImage:
              'radial-gradient(circle at 30% 20%, rgba(184,115,51,0.16), transparent 60%), radial-gradient(circle at 70% 80%, rgba(110,102,90,0.10), transparent 60%)',
          }}
        />
      )}

      {/* Layered overlay for caption legibility on any image. The two
          gradients work together: bottom-up dark for the text band,
          subtle vignette to settle the edges. Skipped on no-image
          fallback so the cream texture stays bright. */}
      {hasImage && (
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-near-black/85 via-near-black/30 to-near-black/40"
        />
      )}

      {/* Status badge — pinned top-left per the project-detail spec.
         Spec calls for top-left so it reads first on entry; the
         name/tagline/CTAs sit at the bottom-left as the "ground-up"
         luxury composition. */}
      {badge && (
        <span
          className={[
            'absolute left-4 top-32 z-10 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 sm:left-6 sm:top-36 lg:left-10',
            'text-[10px] font-semibold uppercase tracking-[0.32em]',
            hasImage
              ? 'border-cream/40 bg-near-black/40 text-cream backdrop-blur-sm'
              : 'border-copper-300 bg-cream-50 text-copper-700',
          ].join(' ')}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-copper-400 animate-cavecms-pulse-copper"
            aria-hidden
          />
          {badge}
        </span>
      )}

      <div className="relative z-10 mx-auto flex min-h-[78vh] max-w-7xl flex-col justify-end px-4 sm:px-6 lg:px-10 pb-16 sm:pb-20 lg:pb-24 pt-32 sm:pt-40 animate-cavecms-rise">
        <h2
          className={[
            'max-w-4xl font-serif font-semibold tracking-tight',
            'text-4xl sm:text-5xl md:text-6xl lg:text-7xl',
            hasImage ? 'text-cream' : 'text-near-black',
          ].join(' ')}
        >
          {ctx.projectName}
        </h2>

        {ctx.projectTagline && (
          <p
            className={[
              'mt-5 max-w-2xl text-base sm:text-lg md:text-xl leading-relaxed',
              hasImage ? 'text-cream/85' : 'text-warm-stone',
            ].join(' ')}
          >
            {ctx.projectTagline}
          </p>
        )}

        <div className="mt-9 flex flex-wrap items-center gap-3 sm:gap-4">
          <a
            href="#inquiry-form"
            className={[
              'inline-flex items-center justify-center gap-2 rounded-full px-7 py-3.5',
              'text-sm font-semibold tracking-wide',
              // copper-700 (#8B5320) on cream (#f3e9dc) clears
              // WCAG AA 4.5:1 contrast — copper-600 was 3.87:1
              // (axe color-contrast violation). Hover bumps to
              // copper-800 for the depth-on-hover signal.
              'bg-copper-700 text-cream',
              'transition-all duration-standard ease-standard',
              'hover:bg-copper-800 hover:shadow-lg hover:shadow-copper-900/20 hover:-translate-y-0.5',
              'min-h-[44px]',
            ].join(' ')}
          >
            Schedule a tour
          </a>
          <a
            href="#brochure"
            className={[
              'inline-flex items-center justify-center gap-2 rounded-full px-7 py-3.5',
              'text-sm font-semibold tracking-wide border',
              'transition-all duration-standard ease-standard',
              hasImage
                ? 'border-cream/50 text-cream hover:bg-cream/10 hover:border-cream'
                : 'border-near-black/30 text-near-black hover:bg-near-black/5 hover:border-near-black',
              'min-h-[44px]',
            ].join(' ')}
          >
            Download brochure
          </a>
        </div>
      </div>
    </section>
  )
}
