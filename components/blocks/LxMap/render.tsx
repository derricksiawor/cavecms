import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'

// Luxury map embed. Mirrors lx_figure's editorial shell: aspect-ratio
// frame, rounded-2xl corners (no borders per ~/.claude/CLAUDE.md),
// optional champagne overlay for brand cohesion. The iframe is the
// authoritative trust boundary — the embed URL passes the Zod
// `isValidMapEmbedUrl` gate before it reaches this renderer, but the
// sandbox + referrerPolicy here is the second layer.
//
// Sandbox tokens match the VideoEmbed pattern. allow-top-navigation
// is INTENTIONALLY ABSENT — a compromised Google subdomain cannot
// navigate the parent frame. Google Maps tile-loading requires
// allow-scripts + allow-same-origin; without those, the map renders
// as a static placeholder. CSP middleware allows the two Google hosts
// in frame-src so the iframe can load at all.

const RATIO_CLASS: Record<BlockData<'lx_map'>['ratio'], string> = {
  '21:9': 'aspect-[21/9]',
  '16:9': 'aspect-video',
  '4:5': 'aspect-[4/5]',
  '1:1': 'aspect-square',
}

export function LxMap({
  data,
  outerClass,
}: {
  data: BlockData<'lx_map'>
  outerClass?: string
}) {
  const title = data.caption ?? 'Map'

  const aspectBox = (
    <div
      className={clsx(
        'relative overflow-hidden rounded-2xl bg-obsidian/40 shadow-[0_20px_56px_-28px_rgba(5,5,5,0.5)]',
        RATIO_CLASS[data.ratio],
      )}
    >
      <iframe
        src={data.embedUrl}
        title={title}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        referrerPolicy="no-referrer-when-downgrade"
        allow="fullscreen"
        className="h-full w-full border-0"
      />
      {data.goldOverlay && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-champagne/20 via-obsidian/5 to-transparent"
        />
      )}
    </div>
  )

  const figure = (
    <figure
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      {aspectBox}
      {data.caption && (
        // `text-current opacity-70` inherits the parent section's
        // foreground color (ivory on obsidian, obsidian on ivory)
        // and dims it for the editorial caption rhythm. Hardcoded
        // warm-stone read as muddy charcoal on the obsidian
        // contact-page section.
        <figcaption className="mt-4 font-sans text-sm font-medium text-current opacity-70 text-center">
          {data.caption}
        </figcaption>
      )}
    </figure>
  )

  if (data.animation === 'none') return figure
  return <MotionTarget preset={data.animation}>{figure}</MotionTarget>
}
