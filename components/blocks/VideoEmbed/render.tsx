import clsx from 'clsx'
import { parseVideoEmbedUrl, buildEmbedSrc } from '@/lib/cms/videoHostAllowlist'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Elementor-parity Video widget. Canonical fields per
// `includes/widgets/video.php`:
//   - video_type (youtube | vimeo | dailymotion | hosted)
//   - per-host URL inputs + start/end seconds
//   - autoplay, mute, loop, controls, modestbranding, privacy_mode
//   - aspect_ratio (16:9 | 21:9 | 4:3 | 3:2 | 1:1 | 9:16)
//   - image_overlay (custom poster) + lightbox + lazy_load
//
// BWC ships a CURATED subset: youtube + vimeo only (dailymotion is
// negligible traffic; hosted/self-hosted needs storage infra that
// the master spec defers). NO autoplay, NO loop - autoplay-with-sound
// is a usability anti-pattern; muted-autoplay is unreliable in iframe
// sandboxes (every browser gates it on a different heuristic). Single
// caption field below the player carries operator copy.
//
// Security:
//   - URL passes through parseVideoEmbedUrl at the Zod boundary -
//     exact host allowlist + path grammar + id regex. Operator URL
//     never reaches the iframe `src`; the renderer rebuilds the src
//     from { kind, id } via buildEmbedSrc. See lib/cms/videoHostAllowlist.
//   - Iframe sandbox: allow-scripts allow-same-origin allow-popups.
//     NEVER allow-top-navigation - prevents a compromised video host
//     from navigating the parent frame. Matches the project-detail
//     Location iframe pattern.
//   - referrerPolicy="strict-origin-when-cross-origin" mirrors the
//     default browser policy but is set explicitly so a future browser
//     policy change doesn't loosen it.
//
// Reference URLs:
//   - https://elementor.com/help/video-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/video.php
//   - https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox

type VideoEmbedData = BlockData<'video_embed'>

// Tailwind's `aspect-ratio` utilities cover the named ratios cleanly.
// '21:9' has no aspect-* utility so we set the CSS property directly.
const ASPECT_CLASS: Record<VideoEmbedData['aspect_ratio'], string> = {
  '16:9': 'aspect-video',
  '4:3': 'aspect-[4/3]',
  '1:1': 'aspect-square',
  '21:9': 'aspect-[21/9]',
}

export function VideoEmbed({
  data,
  inlineEdit,
  outerClass,
}: {
  data: VideoEmbedData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  // Re-parse at render time. The schema's refine() already validated
  // the URL on save, so this should never be null in practice - the
  // null path covers a DB restore that bypasses the parser or a
  // pre-Chunk-G row that somehow stored an invalid URL.
  const parsed = parseVideoEmbedUrl(data.url)
  if (!parsed) {
    // In edit mode, render a visible placeholder so the operator can
    // see something is wrong and re-open the drawer. The public path
    // returns null silently - the page still loads.
    if (inlineEdit) {
      return (
        <section
          className={clsx(
            'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
            outerClass,
          )}
        >
          <div className="rounded-2xl border border-dashed border-warm-stone/40 bg-cream-50/60 px-6 py-10 text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
              Video URL is invalid
            </p>
            <p className="mt-2 text-sm text-near-black">
              Open the drawer and paste a YouTube embed URL or Vimeo player URL.
            </p>
          </div>
        </section>
      )
    }
    return null
  }
  const src = buildEmbedSrc(parsed)
  const platformName = parsed.kind === 'youtube' ? 'YouTube' : 'Vimeo'

  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      <figure className="space-y-3">
        <div
          className={clsx(
            'overflow-hidden rounded-2xl bg-near-black shadow-[0_20px_56px_-28px_rgba(5,5,5,0.5)]',
            ASPECT_CLASS[data.aspect_ratio],
          )}
        >
          <iframe
            src={src}
            title={data.caption ?? `${platformName} video`}
            loading="lazy"
            // The sandbox attribute is the trust boundary. Each
            // token granted is a capability the iframe host gets;
            // missing tokens are denied. allow-top-navigation is
            // deliberately absent so a compromised host cannot
            // navigate the parent frame.
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            referrerPolicy="strict-origin-when-cross-origin"
            // allow attribute lists feature-policy tokens for media
            // playback. Fullscreen + picture-in-picture cover the
            // visitor's reasonable expectations; encrypted-media is
            // needed for some Vimeo DRM content.
            allow="fullscreen; picture-in-picture; encrypted-media"
            className="h-full w-full border-0"
          />
        </div>
        {data.caption && (
          <figcaption className="text-center text-[11px] font-medium uppercase tracking-[0.2em] text-warm-stone">
            {data.caption}
          </figcaption>
        )}
      </figure>
    </section>
  )
}
