import { categoryUrl, tagUrl } from '@/lib/blog/urls'

export interface TermLink {
  slug: string
  name: string
}

// Renders a post's categories + tags as pills that LINK to their archives —
// the associative-interconnectivity wiring (global rule #0.592): every post
// cross-links into the taxonomy so a reader can travel from a post to "more
// like this" without bouncing to the nav. Pure server component (just <a>s).
// Categories render copper-tinted (the primary grouping); tags render as quiet
// outlined pills. Renders nothing when the post has no terms.
export function TaxonomyPills({
  categories,
  tags,
  className,
}: {
  categories: TermLink[]
  tags: TermLink[]
  className?: string
}) {
  if (categories.length === 0 && tags.length === 0) return null
  return (
    <div className={['flex flex-wrap items-center gap-2', className ?? ''].join(' ')}>
      {categories.map((c) => (
        <a
          key={`c-${c.slug}`}
          href={categoryUrl(c.slug)}
          className="inline-flex w-fit items-center rounded-full bg-copper-500/12 px-3.5 py-1.5 text-xs font-semibold text-copper-700 ring-1 ring-copper-400/30 transition-colors hover:bg-copper-500/20"
        >
          {c.name}
        </a>
      ))}
      {tags.map((t) => (
        <a
          key={`t-${t.slug}`}
          href={tagUrl(t.slug)}
          className="inline-flex w-fit items-center rounded-full border border-warm-stone/30 px-3.5 py-1.5 text-xs font-medium text-warm-stone transition-colors hover:border-copper-400 hover:text-copper-700"
        >
          #{t.name}
        </a>
      ))}
    </div>
  )
}
