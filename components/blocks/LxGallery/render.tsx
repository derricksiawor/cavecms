import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { RenderContext } from '..'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury gallery — grid of editorial photos. Each tile is sharp-
// cornered (architectural), with a subtle hover lift + photo scale.
// Captions slide up from a bottom-aligned gradient on hover.

const COLS_CLASS: Record<BlockData<'lx_gallery'>['columns'], string> = {
  2: 'grid-cols-1 sm:grid-cols-2 gap-8',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4',
}

const RATIO_CLASS: Record<BlockData<'lx_gallery'>['ratio'], string> = {
  '1:1': 'aspect-square',
  '4:5': 'aspect-[4/5]',
  '4:3': 'aspect-[4/3]',
  '3:2': 'aspect-[3/2]',
}

const TONE_CAPTION: Record<string, string> = {
  obsidian: 'text-ivory',
  ivory: 'text-ivory',
}

export function LxGallery({
  data,
  media,
  // Per-image alt + caption inline-edit is a follow-up — the field
  // paths are registered in INLINE_EDITABLE_FIELDS so adding overlays
  // later doesn't require schema work. Operators edit via the drawer.
  inlineEdit: _inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_gallery'>
  media: RenderContext['media']
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const captionClass = isToken ? TONE_CAPTION[tone] : undefined
  const customStyle = !isToken ? { color: resolveColorValue(tone) } : undefined

  const tiles = data.images.map((img, idx) => {
    const entry = media.get(img.media_id)
    if (!entry?.variants) {
      return (
        <div
          key={idx}
          className={clsx(
            'relative overflow-hidden bg-obsidian/40',
            RATIO_CLASS[data.ratio],
          )}
        >
          <div aria-hidden="true" className="lx-glow-champagne absolute inset-0" />
        </div>
      )
    }
    return (
      <figure
        key={idx}
        className={clsx(
          'group relative overflow-hidden',
          RATIO_CLASS[data.ratio],
          'transition-transform duration-500 hover:-translate-y-1',
        )}
      >
        <MediaImg
          media={entry}
          alt={img.alt}
          variant="lg"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
        {img.caption && (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-gradient-to-t from-obsidian/80 via-obsidian/20 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
            />
            <figcaption
              className={clsx(
                'absolute bottom-0 left-0 right-0 px-6 py-5 font-sans text-sm italic',
                'translate-y-2 opacity-0 transition-all duration-500 group-hover:translate-y-0 group-hover:opacity-100',
                captionClass,
              )}
              style={customStyle}
            >
              {img.caption}
            </figcaption>
          </>
        )}
      </figure>
    )
  })

  const grid = (
    <div className={clsx('grid w-full', COLS_CLASS[data.columns], outerClass)}>
      {tiles}
    </div>
  )

  if (data.animation === 'none') return grid
  return <MotionTarget preset={data.animation}>{grid}</MotionTarget>
}
