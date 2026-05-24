import clsx from 'clsx'
import { MediaImg } from '../MediaImg'

interface HeroData { title: string; subtitle?: string; image: { media_id: number; alt: string }; cta?: { text: string; href: string; openInNew?: boolean } }

// Internal hrefs must not carry "nofollow" (blocks PageRank flow inside
// the site — explicit SEO anti-pattern). "noopener noreferrer" still
// applies to internal new-tab opens for window.opener safety.
const EXTERNAL_HREF_RE = /^https?:/i
function linkRel(href: string, openInNew?: boolean): string | undefined {
  if (!openInNew) return undefined
  return EXTERNAL_HREF_RE.test(href)
    ? 'noopener noreferrer nofollow'
    : 'noopener noreferrer'
}

export function Hero({
  data,
  media,
  outerClass,
}: {
  data: HeroData
  media: Map<number, { variants: Record<string, string> | null; alt_text: string }>
  outerClass?: string
}) {
  const m = media.get(data.image.media_id)
  return (
    // Hero is intentionally full-bleed — `py-*` would shrink the
    // image off the page. Internal text padding (p-8 sm:p-16) is the
    // hero's analogue of the "natural padding" every other widget
    // uses via py-12 sm:py-16.
    <section className={clsx('relative bg-near-black text-cream-50', outerClass)}>
      <MediaImg media={m} alt={data.image.alt} variant="lg" className="w-full h-[60vh] object-cover opacity-70" priority />
      <div className="absolute inset-0 flex flex-col justify-end p-8 sm:p-16 max-w-4xl">
        <h1 className="font-serif text-3xl sm:text-5xl font-bold tracking-tight">{data.title}</h1>
        {data.subtitle && <p className="mt-3 text-lg opacity-90">{data.subtitle}</p>}
        {data.cta && (
          <a href={data.cta.href} target={data.cta.openInNew ? '_blank' : undefined} rel={linkRel(data.cta.href, data.cta.openInNew)}
             className="mt-6 inline-block bg-copper-600 hover:bg-copper-700 text-cream-50 px-7 py-3 w-fit rounded-full text-sm font-semibold tracking-wide transition-colors">
            {data.cta.text}
          </a>
        )}
      </div>
    </section>
  )
}
