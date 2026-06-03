import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import type { BlockData } from '@/lib/cms/block-registry'
import type { RenderContext } from '..'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Marquee (logo / text ticker). Pure-CSS seamless scroll: the track is
// duplicated and translated -50%, so one set scrolls off as the copy
// scrolls in. prefers-reduced-motion disables the animation (the inline
// <style> media query). Server component.

const MARQUEE_CSS = `
@keyframes lx-marquee-left { from { transform: translateX(0) } to { transform: translateX(-50%) } }
@keyframes lx-marquee-right { from { transform: translateX(-50%) } to { transform: translateX(0) } }
@media (prefers-reduced-motion: reduce) { .lx-marquee-track { animation: none !important } }
`
const SPEED_DUR: Record<BlockData<'lx_marquee'>['speed'], string> = {
  slow: '40s',
  medium: '25s',
  fast: '14s',
}
const TONE_TEXT: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }

export function LxMarquee({
  data,
  media,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_marquee'>
  media: RenderContext['media']
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  // Empty-content guard — a text marquee with no text or a logo marquee
  // with no logos would render a blank scrolling band. Render nothing
  // instead (mirrors LxPosts / LxFeaturedProjects empty handling).
  if (data.mode === 'text' && !data.text?.trim()) return null
  if (data.mode === 'logos' && data.logos.length === 0) return null

  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const textClass = isToken ? TONE_TEXT[tone] : undefined
  const custom = !isToken ? resolveColorValue(tone) : undefined
  const anim = `lx-marquee-${data.direction} ${SPEED_DUR[data.speed]} linear infinite`

  const oneSet =
    data.mode === 'logos' ? (
      <div className="flex shrink-0 items-center gap-16 px-8">
        {data.logos.map((logo, i) => (
          <MediaImg
            key={i}
            media={media.get(logo.media_id)}
            alt={logo.alt}
            variant="thumb"
            className="h-10 w-auto object-contain opacity-60 grayscale transition hover:opacity-100 hover:grayscale-0"
          />
        ))}
      </div>
    ) : (
      <div
        className={clsx('flex shrink-0 items-center gap-8 px-8 font-serif text-3xl font-semibold tracking-tight sm:text-4xl', textClass)}
        style={custom ? { color: custom } : undefined}
      >
        {/* Repeat the phrase a few times within one set so short text
            still fills the viewport before the duplicate begins. */}
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className="whitespace-nowrap">
            {data.text}
            <span className="mx-8 text-champagne">&bull;</span>
          </span>
        ))}
      </div>
    )

  return (
    <div className={clsx('w-full overflow-hidden', outerClass)} aria-label={data.mode === 'text' ? data.text : 'Logos'}>
      <style dangerouslySetInnerHTML={{ __html: MARQUEE_CSS }} />
      <div className="flex w-max lx-marquee-track" style={{ animation: anim }}>
        {oneSet}
        <div aria-hidden="true" className="flex">
          {oneSet}
        </div>
      </div>
    </div>
  )
}
