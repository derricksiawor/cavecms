import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { AltTextOverlay } from '@/components/inline-edit/AltTextOverlay'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { RenderContext } from '..'

// Luxury figure — image with optional caption + parallax + gradient
// blur overlay. Per ~/.claude/CLAUDE.md "No borders/border lines"
// the previous draft's sharp/soft corner choice was a border-radius
// toggle; we honour the spirit by ALWAYS rounding to a luxury 2xl
// (24px) corner. The schema enum is preserved for back-compat but
// both values render with the same rounded-2xl treatment.
//
// goldOverlay layers a champagne gradient over the bottom 60% of
// the image — gives the bottom edge a warm "lit from below"
// atmosphere even on photos that don't have native champagne tones.

const RATIO_CLASS: Record<BlockData<'lx_figure'>['ratio'], string> = {
  '21:9': 'aspect-[21/9]',
  '16:9': 'aspect-video',
  '4:5': 'aspect-[4/5]',
  '1:1': 'aspect-square',
}

const FIT_CLASS: Record<BlockData<'lx_figure'>['fit'], string> = {
  cover: 'object-cover',
  contain: 'object-contain',
}

export function LxFigure({
  data,
  media,
  outerClass,
  inlineEdit,
}: {
  data: BlockData<'lx_figure'>
  media: RenderContext['media']
  outerClass?: string
  inlineEdit?: InlineEditContext
}) {
  const mediaEntry = media.get(data.image.media_id)
  const mediaMissing = !mediaEntry || !mediaEntry.variants

  // Missing-media placeholder — no border (per CLAUDE.md); instead
  // uses a champagne radial glow backdrop to read as "luxury empty
  // state" rather than "broken." aria-label stays neutral so AT
  // users on the public page don't hear operator instructions.
  const img = mediaMissing ? (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-2 bg-obsidian/40"
      role="img"
      aria-label="Image unavailable"
    >
      <div
        aria-hidden="true"
        className="lx-glow-champagne absolute inset-0"
      />
      <span
        aria-hidden="true"
        className="relative font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne"
      >
        Image missing
      </span>
      <span
        aria-hidden="true"
        className="relative font-sans text-sm font-medium text-ivory/70"
      >
        Pick a new image in the figure drawer.
      </span>
    </div>
  ) : (
    <MediaImg
      media={mediaEntry}
      alt={data.image.alt}
      variant="lg"
      className={clsx('w-full h-full', FIT_CLASS[data.fit])}
    />
  )

  const imgNode =
    data.animation === 'parallax' && !mediaMissing ? (
      <MotionTarget preset="parallax">{img}</MotionTarget>
    ) : (
      img
    )

  const aspectBox = (
    <div
      className={clsx(
        'relative overflow-hidden rounded-2xl',
        RATIO_CLASS[data.ratio],
      )}
    >
      {imgNode}
      {data.goldOverlay && !mediaMissing && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-champagne/30 via-obsidian/10 to-transparent"
        />
      )}
      {inlineEdit && (
        <AltTextOverlay
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="image.alt"
          initialValue={data.image.alt ?? ''}
        />
      )}
    </div>
  )

  // Caption is inline-editable on the editor surface (per
  // INLINE_EDITABLE_FIELDS.lx_figure). On the public surface the
  // figcaption is rendered only when there's caption text — keeping
  // the layout from acquiring a phantom margin on empty caption rows.
  // In editor mode we render the empty figcaption so the operator has
  // a clickable affordance to add caption text inline.
  const captionEditable = inlineEdit ? (
    <figcaption className="mt-4 font-sans text-sm font-medium text-ivory/85">
      <InlineEditable
        blockId={inlineEdit.blockId}
        blockVersion={inlineEdit.blockVersion}
        pageId={inlineEdit.pageId}
        pageVersion={inlineEdit.pageVersion}
        initialData={data}
        field="caption"
        kind="plain"
        initialValue={data.caption ?? ''}
        as="span"
        placeholder="Add a caption…"
      />
    </figcaption>
  ) : (
    data.caption && (
      <figcaption className="mt-4 font-sans text-sm font-medium text-ivory/85">
        {data.caption}
      </figcaption>
    )
  )

  const figure = (
    <figure className={outerClass}>
      {aspectBox}
      {captionEditable}
    </figure>
  )

  if (data.animation === 'none' || data.animation === 'parallax') {
    return figure
  }
  return <MotionTarget preset={data.animation}>{figure}</MotionTarget>
}
