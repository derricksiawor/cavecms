import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { AltTextOverlay } from '@/components/inline-edit/AltTextOverlay'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
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
// Optional text overlay — when any of eyebrow / title / body / cta is
// set, an absolutely-positioned text block sits over the image at
// `overlayAlignment` (9-point compass: top/center/bottom × left/center/
// right). Tone selects ivory text (default, for dark photos) or
// obsidian (for light photos). This turns the pure-image cover into a
// hero in one widget — replaces the separate cover + hero pair the
// templates used to ship.

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

// 9-point compass for the overlay block's anchor inside the cover
// image frame. The vertical + horizontal classes combine — top-left
// sits the block flush to the top-left edge with editorial padding;
// center is exact-centred both axes. Each anchor adds matching text
// alignment so a `bottom-right` block reads with right-aligned text.
const OVERLAY_ANCHOR_CLASS: Record<
  BlockData<'lx_cover_image'>['overlayAlignment'],
  string
> = {
  'top-left': 'top-0 left-0 items-start text-left',
  'top-center': 'top-0 left-1/2 -translate-x-1/2 items-center text-center',
  'top-right': 'top-0 right-0 items-end text-right',
  'center-left': 'top-1/2 -translate-y-1/2 left-0 items-start text-left',
  center:
    'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 items-center text-center',
  'center-right':
    'top-1/2 -translate-y-1/2 right-0 items-end text-right',
  'bottom-left': 'bottom-0 left-0 items-start text-left',
  'bottom-center':
    'bottom-0 left-1/2 -translate-x-1/2 items-center text-center',
  'bottom-right': 'bottom-0 right-0 items-end text-right',
}

const OVERLAY_TONE_CLASS: Record<
  BlockData<'lx_cover_image'>['overlayTone'],
  { eyebrow: string; title: string; body: string; cta: string }
> = {
  ivory: {
    eyebrow: 'text-champagne',
    title: 'text-ivory',
    body: 'text-ivory/85',
    cta: 'bg-champagne text-obsidian hover:bg-antique-gold hover:text-ivory',
  },
  obsidian: {
    eyebrow: 'text-copper-700',
    title: 'text-obsidian',
    body: 'text-obsidian/85',
    cta: 'bg-obsidian text-ivory hover:bg-near-black',
  },
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

  const hasOverlay =
    Boolean(data.eyebrow) ||
    Boolean(data.title) ||
    Boolean(data.body) ||
    Boolean(data.cta) ||
    // Always render the overlay block in edit mode so operators can
    // type a title onto a previously-imageless cover. Without this,
    // a fresh lx_cover_image (no eyebrow/title/body/cta yet) has no
    // overlay to click into.
    Boolean(inlineEdit)
  const toneClass = OVERLAY_TONE_CLASS[data.overlayTone]

  const eyebrowClass = clsx(
    'font-sans text-[11px] font-semibold uppercase tracking-[0.32em]',
    toneClass.eyebrow,
  )
  const titleClass = clsx(
    'font-serif text-4xl font-bold leading-tight tracking-tight sm:text-5xl md:text-6xl',
    toneClass.title,
  )
  const bodyClass = clsx(
    'max-w-2xl text-base leading-relaxed sm:text-lg',
    toneClass.body,
  )

  const overlayText = hasOverlay ? (
    <div
      className={clsx(
        'absolute z-10 flex w-full max-w-3xl flex-col gap-4 p-8 sm:p-12 lg:p-16',
        // pointer-events-none on the static overlay so clicks pass to
        // the image below; the editable wrappers + cta opt back in
        // with pointer-events-auto so operators can interact with
        // their controls.
        inlineEdit ? '' : 'pointer-events-none',
        OVERLAY_ANCHOR_CLASS[data.overlayAlignment],
      )}
    >
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="eyebrow"
          kind="text"
          initialValue={data.eyebrow ?? ''}
          as="p"
          className={eyebrowClass}
          placeholder="Eyebrow (optional)"
        />
      ) : (
        data.eyebrow && <p className={eyebrowClass}>{data.eyebrow}</p>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="title"
          kind="text"
          initialValue={data.title ?? ''}
          as="h1"
          className={titleClass}
          placeholder="Title (optional)"
        />
      ) : (
        data.title && <h1 className={titleClass}>{data.title}</h1>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="body"
          kind="text"
          initialValue={data.body ?? ''}
          as="p"
          className={bodyClass}
          placeholder="Body (optional)"
        />
      ) : (
        data.body && <p className={bodyClass}>{data.body}</p>
      )}
      {data.cta && (
        <a
          href={data.cta.href}
          className={clsx(
            'pointer-events-auto mt-2 inline-flex w-fit items-center justify-center rounded-full px-8 py-3 font-sans text-[13px] font-semibold uppercase tracking-[0.22em] shadow-lg transition-colors',
            toneClass.cta,
          )}
        >
          {data.cta.label}
        </a>
      )}
    </div>
  ) : null

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
      {overlayText}
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
