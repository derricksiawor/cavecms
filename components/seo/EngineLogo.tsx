import clsx from 'clsx'
import { Globe } from 'lucide-react'

// Renders an engine's official brand mark when one exists. For the few
// endpoints with no usable square brand SVG (the IndexNow protocol itself,
// Seznam — whose only official asset is a wide wordmark that would shrink
// to an unreadable sliver in a 24px tile, "Ask & others"), we fall back to
// a clean lucide glyph in a copper chip — NEVER a hand-rolled letter
// monogram or an invented logo (#0.57 / #0.58: official mark, else a
// professional icon library, never freehand).
//
// `object-contain` so wide wordmarks (Yandex) and tall marks (Bing) both
// center cleanly inside a square box without distortion.
export function EngineLogo({
  logo,
  name,
  size = 24,
  className,
}: {
  logo: string | null
  name: string
  size?: number
  className?: string
}) {
  if (logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt={`${name} logo`}
        width={size}
        height={size}
        className={clsx('object-contain', className)}
        style={{ width: size, height: size }}
        loading="lazy"
        decoding="async"
      />
    )
  }
  return (
    <span
      aria-hidden
      title={name}
      className={clsx(
        'inline-flex items-center justify-center rounded-md bg-copper-500/12 text-copper-700',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Globe size={Math.round(size * 0.62)} strokeWidth={1.75} />
    </span>
  )
}
