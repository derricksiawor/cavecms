import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury social icons — a row of brand glyphs sourced from official
// simple-icons SVGs (bundled under /public/icons/social/). The legacy
// renderer hand-rolled SVGs which violates ~/.claude/CLAUDE.md #0.57.
// Each platform name maps to a fixed asset path; an enum at the
// schema layer guarantees we never get an unknown name at render.

const PLATFORM_LABEL: Record<BlockData<'lx_social_icons'>['items'][number]['platform'], string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  twitter: 'X (Twitter)',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  whatsapp: 'WhatsApp',
  github: 'GitHub',
  dribbble: 'Dribbble',
  behance: 'Behance',
  pinterest: 'Pinterest',
  vimeo: 'Vimeo',
  spotify: 'Spotify',
  'apple-music': 'Apple Music',
  soundcloud: 'SoundCloud',
  threads: 'Threads',
}

const SIZE_PX: Record<BlockData<'lx_social_icons'>['size'], number> = {
  sm: 18,
  md: 22,
  lg: 28,
}

const ALIGN_CLASS: Record<BlockData<'lx_social_icons'>['alignment'], string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}

const TONE_CLASS: Record<string, string> = {
  obsidian: 'text-obsidian/80 hover:text-champagne',
  ivory: 'text-ivory/75 hover:text-champagne',
  'warm-stone': 'text-warm-stone hover:text-champagne',
}

export function LxSocialIcons({
  data,
  outerClass,
}: {
  data: BlockData<'lx_social_icons'>
  outerClass?: string
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const toneClass = isToken ? TONE_CLASS[tone] : undefined
  const customStyle = !isToken ? { color: resolveColorValue(tone) } : undefined
  const px = SIZE_PX[data.size]

  const items = data.items.map((item, idx) => (
    <a
      key={idx}
      href={item.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={PLATFORM_LABEL[item.platform]}
      className={clsx(
        'inline-flex items-center justify-center transition-colors duration-300',
        toneClass,
      )}
      style={customStyle}
    >
      {/*
        CSS-mask sourcing official simple-icons brand SVG. The mask
        approach lets currentColor drive the glyph fill — official
        outline + tone control without hand-rolling paths. Asset path
        convention: /icons/social/<platform>.svg (bundled at build).
      */}
      <span
        aria-hidden="true"
        className="block bg-current"
        style={{
          width: `${px}px`,
          height: `${px}px`,
          WebkitMaskImage: `url(/icons/social/${item.platform}.svg)`,
          maskImage: `url(/icons/social/${item.platform}.svg)`,
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
        }}
      />
    </a>
  ))

  const composed = (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-6',
        ALIGN_CLASS[data.alignment],
        outerClass,
      )}
    >
      {items}
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
