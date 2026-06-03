import clsx from 'clsx'
import { Newspaper } from 'lucide-react'
import type { HydratedPostCardCtx } from '..'
import { textTones, type PostsTemplate } from './styles'

// Client-bundle-safe JSON-for-<script> escaper. We deliberately do NOT import
// lib/seo/escape (it carries `import 'server-only'`, and this module is reached
// from the CLIENT editor-canvas renderer via render.tsx). Same escapes as
// safeJsonForScript: neutralise </script> + line/paragraph separators so the
// JSON can't break out of the <script> tag or trip a JS parser.
const LINE_TERMINATORS = new RegExp('[\u2028\u2029]', 'g')
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\u003e')
    .replace(LINE_TERMINATORS, (ch) =>
      ch.charCodeAt(0) === 0x2028 ? '\\u2028' : '\\u2029',
    )
}

// ── Structured data (#7) ─────────────────────────────────────────────────
// Emit an ItemList of BlogPosting items for the rendered card list so the
// post grid is machine-readable (rich results / discovery). URLs are the
// segment-aware permalinks baked at hydrate. safeJsonForScript escapes the
// JSON for safe inlining (< → < etc). Server-only-safe (pure render).
export function PostsItemListJsonLd({ cards }: { cards: HydratedPostCardCtx[] }) {
  if (cards.length === 0) return null
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: cards.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'BlogPosting',
        headline: c.title,
        url: c.url,
        ...(c.excerpt ? { description: c.excerpt } : {}),
        ...(c.published_at
          ? { datePublished: new Date(c.published_at as string | Date).toISOString() }
          : {}),
        ...(c.author && c.author.name
          ? { author: { '@type': 'Person', name: c.author.name } }
          : {}),
      },
    })),
  }
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: jsonForScript(itemList) }}
    />
  )
}

// ── Empty state (#7) ──────────────────────────────────────────────────────
// A designed, on-brand "no posts" state per template — never a blank gap. The
// recent/home teaser path (handled upstream) still renders nothing so a teaser
// disappears cleanly; this is for the operator-styled surfaces.
export function PostsEmptyState({
  heading,
  onDark,
  template,
}: {
  heading?: string
  onDark: boolean
  template: PostsTemplate
}) {
  const tones = textTones(onDark)
  const copy =
    template === 'carousel' || template === 'magazine'
      ? 'No stories to feature yet — check back soon.'
      : 'No posts here yet — check back soon.'
  return (
    <div className="mx-auto w-full max-w-6xl">
      {heading && (
        <h2 className={clsx('mb-8 font-serif text-3xl font-bold tracking-tight sm:text-4xl', tones.heading)}>
          {heading}
        </h2>
      )}
      <div
        className={clsx(
          'flex flex-col items-center justify-center gap-4 rounded-2xl px-6 py-16 text-center',
          onDark ? 'bg-ivory/[0.05]' : 'bg-cream-50/70',
        )}
      >
        <span
          className={clsx(
            'grid h-14 w-14 place-items-center rounded-full',
            onDark ? 'bg-ivory/10 text-ivory/50' : 'bg-champagne/20 text-antique-gold',
          )}
          aria-hidden
        >
          <Newspaper className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <p className={clsx('font-sans text-base', tones.excerpt)}>{copy}</p>
      </div>
    </div>
  )
}

// ── Widget heading ────────────────────────────────────────────────────────
export function PostsHeading({ heading, onDark }: { heading?: string; onDark: boolean }) {
  if (!heading) return null
  const tones = textTones(onDark)
  return (
    <h2 className={clsx('mb-10 font-serif text-3xl font-bold tracking-tight sm:text-4xl', tones.heading)}>
      {heading}
    </h2>
  )
}
