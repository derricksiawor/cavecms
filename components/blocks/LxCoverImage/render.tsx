import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { AltTextOverlay } from '@/components/inline-edit/AltTextOverlay'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { RenderContext } from '..'

// Luxury cover image — edge-to-edge full-bleed hero photo. The block
// breaks out of any centred section container using the classic
// `w-screen + relative + left-1/2 + -translate-x-1/2` pattern: it
// expands to the full viewport width regardless of the parent's
// max-width, then re-centres itself horizontally so left/right edges
// align with the viewport instead of the content column.
//
// Why not section meta? A "full-bleed" toggle on the section would
// require every renderer to honour it, and would still be coupled
// to a single image. Letting the BLOCK own the breakout keeps the
// CMS-first contract intact — operator drops in lx_cover_image, it
// renders edge-to-edge, no section-meta dance required.
//
// Object-fit: cover ensures the photo fills the frame even when the
// aspect ratio of the image differs from the requested ratio. The
// MotionTarget wrapper handles entrance animation; parallax is a
// scroll-linked transform that scales the image across the viewport.

const RATIO_CLASS: Record<BlockData<'lx_cover_image'>['ratio'], string> = {
  '21:9': 'aspect-[21/9]',
  '16:9': 'aspect-video',
  '4:3': 'aspect-[4/3]',
  '3:2': 'aspect-[3/2]',
  '4:5': 'aspect-[4/5]',
  // auto = no aspect-ratio class; minHeight controls the box.
  auto: '',
}

// Min-height in pixels (px) or viewport-height (vh). Pairs with the
// ratio so the renderer picks whichever resolves taller — `min-h-` on
// a short viewport keeps the cover from collapsing to a band on
// 16:9-ratio + small screens.
const MIN_HEIGHT_CLASS: Record<
  BlockData<'lx_cover_image'>['minHeight'],
  string
> = {
  none: '',
  sm: 'min-h-[320px]',
  md: 'min-h-[420px]',
  lg: 'min-h-[540px]',
  xl: 'min-h-[680px]',
  screen: 'min-h-screen',
}

// Overlay tint over the image. Applied as an absolutely-positioned
// pointer-events-none div so the operator can still click the image
// in edit mode (the AltTextOverlay sits above the tint).
const OVERLAY_CLASS: Record<
  BlockData<'lx_cover_image'>['overlay'],
  string
> = {
  none: '',
  darken: 'bg-obsidian/30',
  'darken-strong': 'bg-obsidian/55',
  'gradient-bottom':
    'bg-gradient-to-t from-obsidian/80 via-obsidian/30 to-transparent',
  champagne:
    'bg-gradient-to-t from-champagne/35 via-obsidian/15 to-transparent',
}

export function LxCoverImage({
  data,
  media,
  outerClass,
  inlineEdit,
}: {
  data: BlockData<'lx_cover_image'>
  media: RenderContext['media']
  outerClass?: string
  inlineEdit?: InlineEditContext
}) {
  const entry = media.get(data.image.media_id)
  const missing = !entry || !entry.variants

  const img = missing ? (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-2 bg-obsidian/40"
      role="img"
      aria-label="Image unavailable"
    >
      <div aria-hidden="true" className="lx-glow-champagne absolute inset-0" />
      <span
        aria-hidden="true"
        className="relative font-sans text-[10px] font-semibold uppercase tracking-eyebrow text-champagne"
      >
        Image missing
      </span>
      <span
        aria-hidden="true"
        className="relative font-sans text-xs font-medium text-ivory/70"
      >
        Pick a cover image in the drawer.
      </span>
    </div>
  ) : (
    <MediaImg
      media={entry}
      alt={data.image.alt}
      variant="lg"
      priority
      className="h-full w-full object-cover"
    />
  )

  // Break out of the parent's content column to span the full viewport.
  // `w-screen relative left-1/2 -translate-x-1/2` is the canonical
  // centred-container breakout — the absolute width is the viewport,
  // and the negative translate cancels the half-shift introduced by
  // `left-1/2` so the visual position stays centred.
  const frame = (
    <div
      className={clsx(
        'relative left-1/2 -translate-x-1/2 w-screen overflow-hidden',
        RATIO_CLASS[data.ratio],
        MIN_HEIGHT_CLASS[data.minHeight],
        outerClass,
      )}
    >
      {img}
      {data.overlay !== 'none' && !missing && (
        <div
          aria-hidden="true"
          className={clsx('pointer-events-none absolute inset-0', OVERLAY_CLASS[data.overlay])}
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

  if (data.animation === 'none') return frame
  if (data.animation === 'parallax' && !missing) {
    return <MotionTarget preset="parallax">{frame}</MotionTarget>
  }
  return <MotionTarget preset={data.animation}>{frame}</MotionTarget>
}
