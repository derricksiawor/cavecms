import type { ReactNode } from 'react'

export function MediaImg({ media, alt, variant = 'md', className, priority = false }: {
  media: { variants: Record<string, string> | null; width?: number | null; height?: number | null } | undefined
  alt: string
  variant?: 'thumb' | 'md' | 'lg' | 'og'
  className?: string
  priority?: boolean
}): ReactNode {
  // Missing-media render: returns a className-inheriting empty
  // <div> so the wrapping widget keeps its laid-out height. The
  // Hero widget's `<section>` derives its 60vh band from this div's
  // `h-[60vh]` className; returning null collapses the section to
  // 0px (text content is absolutely positioned) and the Hero
  // disappears entirely.
  //
  // Audit V1 ("blue rectangle on the homepage") turned out to NOT
  // be a missing-media render — the dev DB has an actual uploaded
  // 1600×900 solid-blue WebP that MediaImg loads correctly. Code
  // can't fix that; the proper fix is a content/seed pass that
  // replaces the placeholder upload with a real hero photo. Earlier
  // self-review caught a "return null" attempt here that broke the
  // Hero widget without addressing V1 — reverted.
  if (!media || !media.variants) return <div className={className} aria-label={alt} />
  const src = media.variants[variant] ?? media.variants.md ?? Object.values(media.variants)[0]
  if (!src) return <div className={className} aria-label={alt} />

  // Build srcset from known variant widths when at least 2 variants are present.
  const variantWidths: Array<[string, number]> = [
    ['thumb', 400],
    ['md', 800],
    ['lg', 1600],
  ]
  const srcsetParts: string[] = []
  for (const [key, w] of variantWidths) {
    const url = media.variants[key]
    if (url) srcsetParts.push(`${url} ${w}w`)
  }
  const srcset = srcsetParts.length >= 2 ? srcsetParts.join(', ') : undefined

  const w = media.width ?? undefined
  const h = media.height ?? undefined

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      {...(srcset ? { srcSet: srcset, sizes: '100vw' } : {})}
      {...(w != null && h != null ? { width: w, height: h } : {})}
    />
  )
}
