'use client'
import { Image as ImageIcon } from 'lucide-react'
import clsx from 'clsx'

// Live share-card previews. The whole point of the social settings page is
// to let the operator SEE how their link looks when shared — not type
// handles blind. These render the site's REAL default share image + a
// sample title/description/domain, styled to match each surface.
//
// Open Graph is the universal standard: Facebook, LinkedIn, WhatsApp,
// Slack, iMessage, Discord, Pinterest and most apps read the same og:*
// tags. X (Twitter) layers its own twitter:card on top. So we show ONE
// Open Graph card (what 90% of shares look like) + the X card variants.

export interface SharePreviewData {
  ogImageUrl: string | null
  domain: string
  title: string
  description: string
}

function PreviewImage({
  src,
  className,
  rounded,
}: {
  src: string | null
  className?: string
  rounded?: string
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={clsx('h-full w-full object-cover', rounded, className)}
      />
    )
  }
  return (
    <div
      className={clsx(
        'flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-cream-100 to-warm-stone/15 text-warm-stone',
        rounded,
        className,
      )}
      aria-hidden
    >
      <ImageIcon size={22} strokeWidth={1.5} />
      <span className="text-[10px] font-medium tracking-wide">No share image yet</span>
    </div>
  )
}

// The universal Open Graph link card — the look Facebook, LinkedIn,
// WhatsApp, Slack, iMessage etc. all render. 1.91:1 image, then domain →
// title → description.
export function OgSharePreview({ data }: { data: SharePreviewData }) {
  return (
    <div className="w-full max-w-md overflow-hidden rounded-xl border border-warm-stone/20 bg-white shadow-[0_10px_34px_-16px_rgba(15,13,12,0.25)]">
      <div className="aspect-[1.91/1] w-full">
        <PreviewImage src={data.ogImageUrl} />
      </div>
      <div className="border-t border-warm-stone/12 px-4 py-3">
        <p className="truncate text-[11px] uppercase tracking-[0.08em] text-warm-stone">
          {data.domain}
        </p>
        <p className="mt-1 line-clamp-2 text-[15px] font-semibold leading-snug text-near-black">
          {data.title}
        </p>
        <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-warm-stone">
          {data.description}
        </p>
      </div>
    </div>
  )
}

// The X (Twitter) card — large (summary_large_image) is a big edge image
// with the title over a footer; small (summary) is a square thumbnail
// beside the text.
export function XSharePreview({
  variant,
  data,
}: {
  variant: 'summary' | 'summary_large_image'
  data: SharePreviewData
}) {
  if (variant === 'summary_large_image') {
    return (
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-warm-stone/20 bg-white shadow-[0_10px_34px_-16px_rgba(15,13,12,0.25)]">
        <div className="aspect-[1.91/1] w-full">
          <PreviewImage src={data.ogImageUrl} />
        </div>
        <div className="px-3.5 py-2.5">
          <p className="truncate text-[12px] text-warm-stone">{data.domain}</p>
          <p className="mt-0.5 line-clamp-1 text-[14px] font-semibold leading-snug text-near-black">
            {data.title}
          </p>
          <p className="mt-0.5 line-clamp-1 text-[12.5px] leading-snug text-warm-stone">
            {data.description}
          </p>
        </div>
      </div>
    )
  }
  // summary (small)
  return (
    <div className="flex w-full max-w-md items-stretch overflow-hidden rounded-2xl border border-warm-stone/20 bg-white shadow-[0_10px_34px_-16px_rgba(15,13,12,0.25)]">
      <div className="aspect-square w-[116px] shrink-0">
        <PreviewImage src={data.ogImageUrl} />
      </div>
      <div className="flex min-w-0 flex-col justify-center px-3.5 py-2.5">
        <p className="truncate text-[12px] text-warm-stone">{data.domain}</p>
        <p className="mt-0.5 line-clamp-2 text-[14px] font-semibold leading-snug text-near-black">
          {data.title}
        </p>
        <p className="mt-0.5 line-clamp-1 text-[12.5px] leading-snug text-warm-stone">
          {data.description}
        </p>
      </div>
    </div>
  )
}

// "Works on …" row of official brand marks — communicates that Open Graph
// is universal, not X-only. Grayscale + muted by default for a calm row;
// each mark colours on hover. Official simple-icons SVGs in /public/icons.
const PLATFORMS: { slug: string; name: string }[] = [
  { slug: 'facebook', name: 'Facebook' },
  { slug: 'linkedin', name: 'LinkedIn' },
  { slug: 'whatsapp', name: 'WhatsApp' },
  { slug: 'x', name: 'X' },
  { slug: 'pinterest', name: 'Pinterest' },
]

export function PlatformRow() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-[12px] font-medium text-warm-stone">Works on</span>
      <div className="flex items-center gap-3.5">
        {PLATFORMS.map((p) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={p.slug}
            src={`/icons/${p.slug}.svg`}
            alt={p.name}
            title={p.name}
            width={18}
            height={18}
            className="h-[18px] w-[18px] opacity-55 grayscale transition-all duration-quick ease-standard hover:opacity-100 hover:grayscale-0"
          />
        ))}
      </div>
      <span className="text-[12px] text-warm-stone/80">
        Slack, iMessage, Discord &amp; more
      </span>
    </div>
  )
}
