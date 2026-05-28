import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { AltTextOverlay } from '@/components/inline-edit/AltTextOverlay'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { RenderContext } from '..'

// Luxury image pair — staggered overlap composition. Two photos that
// read as a single editorial moment: one lifts above the column
// baseline, the other tucks underneath with a horizontal overlap so
// the negative space between them carries the composition.
//
// Visual rules:
//   - Both images render at the same aspect ratio so the baseline
//     stays balanced; the lift on one side is what creates rhythm.
//   - The "lifted" image sits at the front (z-10) with a stronger
//     drop-shadow; the underlay sits at z-0 with a softer shadow.
//   - Negative margin between the two images is the overlap; the
//     enum keys to fixed Tailwind classes so JIT can statically
//     extract them.
//   - Mobile collapses to a vertical stack (no overlap on narrow
//     screens — the staggered composition only reads at md+).
//
// Missing-media placeholder mirrors lx_figure exactly — champagne
// glow over an obsidian backdrop with "Image missing" label so the
// operator never sees a broken layout, only an authored empty state.

const RATIO_CLASS: Record<BlockData<'lx_image_pair'>['ratio'], string> = {
  '3:4': 'aspect-[3/4]',
  '4:5': 'aspect-[4/5]',
  '1:1': 'aspect-square',
}

// Pull-in between the two images on md+. JIT-static strings; on
// mobile the gap collapses to zero because the layout itself stacks
// vertically (gap-y handles vertical rhythm there).
const OVERLAP_CLASS: Record<
  BlockData<'lx_image_pair'>['overlap'],
  { left: string; right: string }
> = {
  sm: { left: 'md:mr-[-2rem]', right: 'md:ml-[-2rem]' },
  md: { left: 'md:mr-[-3.5rem]', right: 'md:ml-[-3.5rem]' },
  lg: { left: 'md:mr-[-6rem]', right: 'md:ml-[-6rem]' },
}

// Vertical lift / drop applied to each side per layout. The "lifted"
// side translates up; the underlay sits with a slight downward offset
// so the composition reads as deliberate rather than misaligned.
const LAYOUT_CLASS: Record<
  BlockData<'lx_image_pair'>['layout'],
  { left: string; right: string; leftZ: string; rightZ: string }
> = {
  'lift-left': {
    left: 'md:-translate-y-6 md:translate-x-0',
    right: 'md:translate-y-12 md:translate-x-0',
    leftZ: 'z-10',
    rightZ: 'z-0',
  },
  'lift-right': {
    left: 'md:translate-y-12 md:translate-x-0',
    right: 'md:-translate-y-6 md:translate-x-0',
    leftZ: 'z-0',
    rightZ: 'z-10',
  },
}

interface ImageFrameProps {
  mediaId: number
  alt: string
  variant: 'left' | 'right'
  ratioClass: string
  layoutClass: string
  overlapClass: string
  zClass: string
  shadowClass: string
  media: RenderContext['media']
  inlineEdit?: InlineEditContext
  /** Full lx_image_pair `data` object — threaded through so the
   *  AltTextOverlay's PATCH body reconstructs the BOTH-image-refs
   *  shape. Passing `{}` here causes the new data to be `{leftImage:
   *  {alt: 'new'}}` only, which fails Zod (rightImage MediaRef
   *  missing) and the save silently 422s. */
  blockData: Record<string, unknown>
}

function ImageFrame({
  mediaId,
  alt,
  variant,
  ratioClass,
  layoutClass,
  overlapClass,
  zClass,
  shadowClass,
  media,
  inlineEdit,
  blockData,
}: ImageFrameProps) {
  const entry = media.get(mediaId)
  const missing = !entry || !entry.variants

  const inner = missing ? (
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
        className="relative font-sans text-[10px] font-semibold uppercase tracking-eyebrow text-champagne"
      >
        Image missing
      </span>
      <span
        aria-hidden="true"
        className="relative font-sans text-xs font-medium text-ivory/70"
      >
        Pick a new image in the pair drawer.
      </span>
    </div>
  ) : (
    <MediaImg
      media={entry}
      alt={alt}
      variant="lg"
      className="h-full w-full object-cover"
    />
  )

  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-2xl transition-transform duration-300',
        ratioClass,
        layoutClass,
        overlapClass,
        zClass,
        shadowClass,
      )}
    >
      {inner}
      {inlineEdit && (
        <AltTextOverlay
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          // Threading the full block data — the overlay's PATCH body
          // reconstructs the lx_image_pair shape with BOTH MediaRefs
          // intact via setFieldValue. Passing `{}` here caused the
          // save to silently 422 because Zod rejected the resulting
          // {leftImage:{alt:...}} (no rightImage required field).
          initialData={blockData}
          field={variant === 'left' ? 'leftImage.alt' : 'rightImage.alt'}
          initialValue={alt}
        />
      )}
    </div>
  )
}

export function LxImagePair({
  data,
  media,
  outerClass,
  inlineEdit,
}: {
  data: BlockData<'lx_image_pair'>
  media: RenderContext['media']
  outerClass?: string
  inlineEdit?: InlineEditContext
}) {
  const layout = LAYOUT_CLASS[data.layout]
  const overlap = OVERLAP_CLASS[data.overlap]
  const ratio = RATIO_CLASS[data.ratio]

  const pair = (
    <div
      className={clsx(
        // grid-cols-1 on mobile keeps the two images stacked; md+
        // splits to a 2-column composition where the overlap +
        // translate classes engage.
        'mx-auto grid w-full max-w-5xl grid-cols-1 items-center gap-8 md:grid-cols-2 md:gap-0',
        outerClass,
      )}
    >
      <ImageFrame
        mediaId={data.leftImage.media_id}
        alt={data.leftImage.alt}
        variant="left"
        ratioClass={ratio}
        layoutClass={layout.left}
        overlapClass={overlap.left}
        zClass={layout.leftZ}
        // The "lifted" side carries a stronger shadow so it visually
        // sits in front of the underlay even when their overlap is
        // narrow. The underlay gets a softer shadow — present enough
        // to lift it off the obsidian section, not so loud it
        // competes with the lifted side.
        shadowClass={
          data.layout === 'lift-left'
            ? 'shadow-[0_40px_80px_-30px_rgba(5,5,5,0.9)]'
            : 'shadow-[0_24px_50px_-20px_rgba(5,5,5,0.7)]'
        }
        media={media}
        inlineEdit={inlineEdit}
        blockData={data as unknown as Record<string, unknown>}
      />
      <ImageFrame
        mediaId={data.rightImage.media_id}
        alt={data.rightImage.alt}
        variant="right"
        ratioClass={ratio}
        layoutClass={layout.right}
        overlapClass={overlap.right}
        zClass={layout.rightZ}
        shadowClass={
          data.layout === 'lift-right'
            ? 'shadow-[0_40px_80px_-30px_rgba(5,5,5,0.9)]'
            : 'shadow-[0_24px_50px_-20px_rgba(5,5,5,0.7)]'
        }
        media={media}
        inlineEdit={inlineEdit}
        blockData={data as unknown as Record<string, unknown>}
      />
    </div>
  )

  if (data.animation === 'none') return pair
  return <MotionTarget preset={data.animation}>{pair}</MotionTarget>
}
