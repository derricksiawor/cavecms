'use client'

import { useCallback, useState } from 'react'
import clsx from 'clsx'
import { MediaImg } from '../MediaImg'
import type { RenderContext } from '..'
import {
  ASPECT_CLASS,
  GRID_COLS,
  GRID_GAP,
  cardSizes,
  clampClass,
  textTones,
  type Columns,
  type ImageAspect,
  type Spacing,
} from './styles'
import type { PostCardToggles } from './PostCard'

// Load-more pagination shell (#4). Wraps the SERVER-rendered first page
// (passed as `children`) and, on click, fetches the NEXT page's cards from
// /api/blog/loop and appends them below — preserving scroll (appending below
// the fold doesn't move the viewport), showing a loading state, and announcing
// the new count via an aria-live region. Only the `current` (blog archive)
// source uses this; the bounded keyset query behind the route caps cost at
// scale (#0.251). Stops + hides the button when the server says there is no
// next page.

interface LoopItemDTO {
  id: number
  slug: string
  title: string
  excerpt: string | null
  published_at: string | null
  hero_image_id: number | null
  reading_minutes: number
  categories: Array<{ slug: string; name: string; url: string }>
  url: string
}

function fmtDate(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// Compact client card for APPENDED pages (mirrors the server grid card shape).
// The first server page is rendered by the server template; this only renders
// the JSON cards the route returns.
function AppendedCard({
  c,
  media,
  toggles,
  aspect,
  columns,
  onDark,
}: {
  c: LoopItemDTO
  media: RenderContext['media']
  toggles: PostCardToggles
  aspect: ImageAspect
  columns: Columns
  onDark: boolean
}) {
  const tones = textTones(onDark)
  const m = c.hero_image_id ? media.get(c.hero_image_id) : undefined
  const date = toggles.showDate ? fmtDate(c.published_at) : null
  return (
    <li className="flex">
      <div className="group flex h-full w-full flex-col">
        <a
          href={c.url}
          className={clsx(
            'block h-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-champagne focus-visible:ring-offset-2',
            onDark ? 'focus-visible:ring-offset-obsidian' : 'focus-visible:ring-offset-cream-50',
          )}
        >
          {toggles.showImage && (
            <div className={clsx('relative w-full overflow-hidden rounded-2xl', ASPECT_CLASS[aspect])}>
              {m && m.variants ? (
                <MediaImg
                  media={m}
                  alt={c.title}
                  variant="md"
                  sizes={cardSizes(columns)}
                  className="absolute inset-0 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-standard motion-safe:ease-standard motion-safe:group-hover:scale-[1.03]"
                />
              ) : (
                <div className={clsx('absolute inset-0 grid place-items-center', tones.fallback)} aria-hidden>
                  <span className="font-serif text-5xl font-bold">
                    {(c.title.trim().charAt(0) || '·').toUpperCase()}
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="pt-4">
            {date && (
              <time
                className="font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne"
                dateTime={new Date(c.published_at as string).toISOString()}
              >
                {date}
              </time>
            )}
            <h3 className={clsx('mt-2 font-serif text-xl font-bold tracking-tight sm:text-2xl', tones.title, clampClass(toggles.titleClamp))}>
              {c.title}
            </h3>
            {toggles.showExcerpt && c.excerpt && (
              <p className={clsx('mt-2 font-sans text-base leading-relaxed', tones.excerpt, clampClass(toggles.excerptClamp))}>
                {c.excerpt}
              </p>
            )}
          </div>
        </a>
        {toggles.showCategory && c.categories.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {c.categories.map((cat) => (
              <a
                key={cat.slug}
                href={cat.url}
                className={clsx(
                  'inline-flex w-fit items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-eyebrow ring-1 transition-colors',
                  tones.pill,
                )}
              >
                {cat.name}
              </a>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

export function PostsLoadMore({
  children,
  media,
  toggles,
  aspect,
  columns,
  spacing,
  onDark,
  initialPage,
  initialHasNext,
  perPage,
  category,
  tag,
}: {
  children: React.ReactNode
  media: RenderContext['media']
  toggles: PostCardToggles
  aspect: ImageAspect
  columns: Columns
  spacing: Spacing
  onDark: boolean
  initialPage: number
  initialHasNext: boolean
  perPage?: number
  category?: string
  tag?: string
}) {
  const [pages, setPages] = useState<LoopItemDTO[][]>([])
  const [nextPage, setNextPage] = useState(initialPage + 1)
  const [hasNext, setHasNext] = useState(initialHasNext)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')

  const loadMore = useCallback(async () => {
    if (loading || !hasNext) return
    setLoading(true)
    setStatus('Loading more posts…')
    try {
      const qs = new URLSearchParams({ page: String(nextPage) })
      if (typeof perPage === 'number') qs.set('perPage', String(perPage))
      if (category) qs.set('category', category)
      else if (tag) qs.set('tag', tag)
      const res = await fetch(`/api/blog/loop?${qs.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        // Fail soft — stop offering more rather than surfacing a raw error.
        setHasNext(false)
        setStatus('No more posts to load.')
        return
      }
      const data = (await res.json()) as { items: LoopItemDTO[]; hasNext: boolean }
      const items = Array.isArray(data.items) ? data.items : []
      if (items.length > 0) setPages((prev) => [...prev, items])
      setNextPage((p) => p + 1)
      setHasNext(Boolean(data.hasNext))
      setStatus(
        items.length > 0
          ? `Loaded ${items.length} more posts.`
          : 'No more posts to load.',
      )
    } catch {
      setHasNext(false)
      setStatus('Could not load more posts.')
    } finally {
      setLoading(false)
    }
  }, [loading, hasNext, nextPage, perPage, category, tag])

  return (
    <div>
      {/* Server-rendered first page. */}
      {children}

      {/* Appended pages — each its own grid <ul> matching the server grid. */}
      {pages.map((items, pi) => (
        <ul key={pi} className={clsx('mt-8 grid', GRID_COLS[columns], GRID_GAP[spacing], 'sm:mt-10')}>
          {items.map((c) => (
            <AppendedCard
              key={c.id}
              c={c}
              media={media}
              toggles={toggles}
              aspect={aspect}
              columns={columns}
              onDark={onDark}
            />
          ))}
        </ul>
      ))}

      {/* aria-live status for screen readers. */}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>

      {hasNext && (
        <div className="mt-12 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className={clsx(
              'inline-flex w-fit items-center gap-2 rounded-full px-7 py-3 font-sans text-sm font-semibold tracking-wide transition-colors duration-standard ease-standard min-h-[44px] cavecms-focus-ring disabled:opacity-60',
              onDark
                ? 'bg-champagne text-obsidian hover:bg-champagne/90'
                : 'bg-obsidian text-ivory hover:bg-obsidian/90',
            )}
            aria-busy={loading || undefined}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
}
