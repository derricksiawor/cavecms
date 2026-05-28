import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { RenderContext } from '..'

// Luxury video — cinematic aspect-ratio wrapper around a lazy-loaded
// YouTube / Vimeo iframe. The URL was validated at the write boundary
// (block-registry.ts isValidVideoUrl) so we can normalise to the
// privacy-enhanced embed shape with confidence — no script-injection
// surface.

const RATIO_CLASS: Record<BlockData<'lx_video'>['ratio'], string> = {
  '21:9': 'aspect-[21/9]',
  '16:9': 'aspect-video',
  '4:5': 'aspect-[4/5]',
  '1:1': 'aspect-square',
}

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/
const VIMEO_ID_RE = /^\d{1,12}$/

// Returns null if the URL doesn't match the validator. The schema's
// refine already enforces this — defence in depth at the render layer.
function toEmbedUrl(
  raw: string,
  opts: { autoplay: boolean; muted: boolean; loop: boolean },
): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') {
    let id: string | null = null
    if (url.pathname === '/watch') id = url.searchParams.get('v')
    else if (url.pathname.startsWith('/embed/')) id = url.pathname.slice('/embed/'.length)
    if (!id || !YT_ID_RE.test(id)) return null
    const params = new URLSearchParams()
    params.set('rel', '0')
    params.set('modestbranding', '1')
    if (opts.autoplay) params.set('autoplay', '1')
    if (opts.muted) params.set('mute', '1')
    if (opts.loop) {
      params.set('loop', '1')
      params.set('playlist', id)
    }
    // youtube-nocookie.com is the privacy-enhanced embed host.
    return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`
  }
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1)
    if (!YT_ID_RE.test(id)) return null
    const params = new URLSearchParams()
    params.set('rel', '0')
    params.set('modestbranding', '1')
    if (opts.autoplay) params.set('autoplay', '1')
    if (opts.muted) params.set('mute', '1')
    if (opts.loop) {
      params.set('loop', '1')
      params.set('playlist', id)
    }
    return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`
  }
  if (url.hostname === 'vimeo.com') {
    const id = url.pathname.slice(1)
    if (!VIMEO_ID_RE.test(id)) return null
    const params = new URLSearchParams()
    if (opts.autoplay) params.set('autoplay', '1')
    if (opts.muted) params.set('muted', '1')
    if (opts.loop) params.set('loop', '1')
    return `https://player.vimeo.com/video/${id}?${params.toString()}`
  }
  if (url.hostname === 'player.vimeo.com' && url.pathname.startsWith('/video/')) {
    const id = url.pathname.slice('/video/'.length)
    if (!VIMEO_ID_RE.test(id)) return null
    const params = new URLSearchParams()
    if (opts.autoplay) params.set('autoplay', '1')
    if (opts.muted) params.set('muted', '1')
    if (opts.loop) params.set('loop', '1')
    return `https://player.vimeo.com/video/${id}?${params.toString()}`
  }
  return null
}

export function LxVideo({
  data,
  media,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_video'>
  media: RenderContext['media']
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const embedUrl = toEmbedUrl(data.url, {
    autoplay: data.autoplay,
    muted: data.muted,
    loop: data.loop,
  })

  const posterEntry = data.poster ? media.get(data.poster.media_id) : null
  const hasPoster = !!posterEntry?.variants

  // `outerClass` lives ONLY on the outermost wrapper. With a caption,
  // the figure is inside a div that owns `outerClass`. Without one,
  // the figure IS the outermost wrapper so it owns it. Applying it to
  // both was a double-margin bug in 0.1.44.
  const frame = (
    <figure className={clsx('relative w-full overflow-hidden', RATIO_CLASS[data.ratio])}>
      {embedUrl ? (
        <iframe
          src={embedUrl}
          title={data.caption ?? 'Video'}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full border-0"
        />
      ) : hasPoster && posterEntry ? (
        <MediaImg
          media={posterEntry}
          alt={data.poster!.alt}
          variant="lg"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-obsidian/40 text-ivory/70">
          <span className="font-sans text-xs uppercase tracking-eyebrow">Video unavailable</span>
        </div>
      )}
    </figure>
  )

  const withCaption = inlineEdit ? (
    <div className={clsx(outerClass)}>
      {frame}
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
        className="mt-4 font-sans text-sm italic text-warm-stone"
        placeholder="Caption (optional)"
      />
    </div>
  ) : data.caption ? (
    <div className={clsx(outerClass)}>
      {frame}
      <figcaption className="mt-4 font-sans text-sm italic text-warm-stone">
        {data.caption}
      </figcaption>
    </div>
  ) : (
    <div className={clsx(outerClass)}>{frame}</div>
  )

  if (data.animation === 'none') return withCaption
  return <MotionTarget preset={data.animation}>{withCaption}</MotionTarget>
}
