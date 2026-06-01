import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { MediaImg } from '../MediaImg'
import { Stars } from '../_shared/Stars'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Luxury reviews grid (Elementor: Reviews) — card grid of author +
// star rating + text + optional avatar. Server component.

const COLS: Record<BlockData<'lx_reviews'>['columns'], string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
}
const TONE_AUTHOR: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_TEXT: Record<string, string> = { obsidian: 'text-warm-stone', ivory: 'text-ivory/75' }
const TONE_BORDER: Record<string, string> = {
  obsidian: 'border-obsidian/10',
  ivory: 'border-ivory/15',
}

export function LxReviews({
  data,
  media,
  outerClass,
}: {
  data: BlockData<'lx_reviews'>
  media: RenderContext['media']
  outerClass?: string
}) {
  const isToken = isColorToken(data.tone)
  const authorClass = isToken ? TONE_AUTHOR[data.tone] : undefined
  const textClass = isToken ? TONE_TEXT[data.tone] : undefined
  const borderClass = isToken ? TONE_BORDER[data.tone] : undefined
  const custom = !isToken ? resolveColorValue(data.tone) : undefined

  const composed = (
    <ul className={clsx('mx-auto grid w-full max-w-6xl gap-6', COLS[data.columns], outerClass)}>
      {data.items.map((r, i) => (
        <li
          key={i}
          className={clsx('flex flex-col gap-4 rounded-2xl border p-7', borderClass)}
        >
          <Stars value={r.rating} max={5} size="sm" />
          <p
            className={clsx('font-sans text-base leading-relaxed', textClass)}
            style={custom ? { color: custom, opacity: 0.85 } : undefined}
          >
            &ldquo;{r.text}&rdquo;
          </p>
          <div className="mt-auto flex items-center gap-3">
            {r.avatar && (
              <MediaImg
                media={media.get(r.avatar.media_id)}
                alt={r.avatar.alt}
                variant="thumb"
                className="h-10 w-10 rounded-full object-cover"
              />
            )}
            <div className="flex flex-col">
              <span
                className={clsx('font-serif text-sm font-semibold tracking-tight', authorClass)}
                style={custom ? { color: custom } : undefined}
              >
                {r.author}
              </span>
              {r.role && (
                <span className="font-sans text-xs text-warm-stone">{r.role}</span>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
