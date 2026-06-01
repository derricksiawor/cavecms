import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { toEmbedSrc } from '@/lib/cms/embedHosts'
import type { BlockData } from '@/lib/cms/block-registry'

// Embed (Elementor: HTML / oEmbed). Tier-1: a curated allowlist of
// well-known embed hosts, normalised to a sandboxed iframe (the same
// model as lx_video / lx_map). The write boundary already rejected any
// non-allowlisted URL; toEmbedSrc() returns the canonical src here.
// Raw operator HTML is deliberately NOT supported (documented Tier-2).
// Server component.

const RATIO_CLASS: Record<BlockData<'lx_embed'>['ratio'], string> = {
  '21:9': 'aspect-[21/9]',
  '16:9': 'aspect-[16/9]',
  '4:3': 'aspect-[4/3]',
  '1:1': 'aspect-square',
  auto: 'min-h-[28rem]',
}

export function LxEmbed({
  data,
  outerClass,
}: {
  data: BlockData<'lx_embed'>
  outerClass?: string
}) {
  const src = toEmbedSrc(data.embedUrl)
  if (!src) return null // tampered cell — write boundary normally prevents this

  const composed = (
    <div className={clsx('mx-auto w-full max-w-4xl overflow-hidden rounded-2xl', outerClass)}>
      <iframe
        src={src}
        title={data.title}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowFullScreen
        className={clsx('w-full border-0', RATIO_CLASS[data.ratio])}
      />
    </div>
  )

  // lx_embed carries no animation field — iframes are static frames.
  return <MotionTarget preset="fade-in">{composed}</MotionTarget>
}
