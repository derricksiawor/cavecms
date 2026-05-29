import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

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
  // 'fill' has no fixed aspect — it stretches to its container's height
  // (h-full) with a min-height floor so it can never collapse to a squat
  // strip. Used in a side-by-side column to match the content beside it.
  fill: 'h-full min-h-[440px]',
}

export function LxMap({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_map'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const title = data.caption ?? 'Map'
  const isFill = data.ratio === 'fill'

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
        // Absolutely positioned to fill the box in BOTH modes: the
        // aspect-ratio box has a definite height, but the 'fill' box's
        // height comes from min-height — and a percentage `height:100%`
        // can't resolve against min-height, so a flow iframe collapses to
        // its 150px default. inset-0 fills the box's rendered size either
        // way.
        className="absolute inset-0 h-full w-full border-0"
      />
      {data.goldOverlay && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-champagne/20 via-obsidian/5 to-transparent"
        />
      )}
    </div>
  )

  // Fill mode — the map stretches to its column's height (h-full + the
  // min-h floor baked into RATIO_CLASS.fill). No editorial py/max-w cap,
  // no sub-caption (a full-height panel doesn't carry one), and no
  // MotionTarget wrapper (an extra wrapper div would break the h-full
  // chain up to the stretched grid column).
  if (isFill) {
    return <figure className={clsx('h-full w-full', outerClass)}>{aspectBox}</figure>
  }

  const figure = (
    <figure
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      {aspectBox}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="caption"
          kind="text"
          initialValue={data.caption ?? ''}
          as="p"
          className="mt-4 font-sans text-sm font-medium text-current opacity-70 text-center"
          placeholder="Caption (optional)"
        />
      ) : (
        data.caption && (
          // `text-current opacity-70` inherits the parent section's
          // foreground color (ivory on obsidian, obsidian on ivory)
          // and dims it for the editorial caption rhythm.
          <figcaption className="mt-4 font-sans text-sm font-medium text-current opacity-70 text-center">
            {data.caption}
          </figcaption>
        )
      )}
    </figure>
  )

  if (data.animation === 'none') return figure
  return <MotionTarget preset={data.animation}>{figure}</MotionTarget>
}
