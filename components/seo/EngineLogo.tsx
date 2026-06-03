import clsx from 'clsx'

// Renders an engine's official brand mark when one exists, or a clean
// lettered monogram when it doesn't (the IndexNow protocol itself,
// Seznam) — NEVER a hand-rolled approximation of a real logo (#0.57).
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
      className={clsx(
        'inline-flex items-center justify-center rounded-md bg-copper-500/12 font-serif font-bold text-copper-700',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}
