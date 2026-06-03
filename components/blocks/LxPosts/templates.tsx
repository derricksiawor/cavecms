import clsx from 'clsx'
import type { RenderContext, HydratedPostCardCtx } from '..'
import { PostCard, CardImage, CategoryPills, type PostCardToggles } from './PostCard'
import {
  GRID_COLS,
  GRID_GAP,
  clampClass,
  textTones,
  type CardStyle,
  type Columns,
  type ImageAspect,
  type Spacing,
} from './styles'

// The four SYNCHRONOUS layout templates (grid / cards / list / magazine).
// The carousel template is a separate client shell (PostsCarousel). Each
// template lays out the SAME PostCard primitive so card content toggles +
// presets stay consistent across templates. The first row is rendered with
// `priority` so its hero images skip lazy-load → protect LCP (#7).

export interface TemplateProps {
  cards: HydratedPostCardCtx[]
  media: RenderContext['media']
  toggles: PostCardToggles
  cardStyle: CardStyle
  spacing: Spacing
  aspect: ImageAspect
  columns: Columns
  onDark: boolean
  /** list-template image position. */
  imageSide?: 'left' | 'right' | 'none'
}

// Grid — uniform image-top cards, equal height. cardStyle 'flat' makes it the
// classic borderless editorial grid; soft/elevated add the panel.
export function GridTemplate(p: TemplateProps) {
  const cols = p.columns
  return (
    <ul className={clsx('grid', GRID_COLS[cols], GRID_GAP[p.spacing])}>
      {p.cards.map((c, i) => (
        <li key={c.id} className="flex">
          <div className="w-full">
            <PostCard
              card={c}
              media={p.media}
              toggles={p.toggles}
              cardStyle={p.cardStyle}
              spacing={p.spacing}
              aspect={p.aspect}
              columns={cols}
              onDark={p.onDark}
              // First row above the fold → eager (LCP). The row size is the
              // column count.
              priority={i < cols}
              variant="stacked"
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

// Cards — like grid but forces an elevated card treatment with a category badge
// over the image. We reuse PostCard with cardStyle forced to elevated when the
// operator left it flat (cards template implies a card), category badge over
// the image. Columns capped at 3 (handled at the dispatcher).
export function CardsTemplate(p: TemplateProps) {
  const cols = p.columns
  const style: CardStyle = p.cardStyle === 'flat' ? 'soft' : p.cardStyle
  return (
    <ul className={clsx('grid', GRID_COLS[cols], GRID_GAP[p.spacing])}>
      {p.cards.map((c, i) => {
        // Category badge OVER the image (#1 cards spec). Rendered outside the
        // card anchor as absolutely-positioned pills so they stay real links.
        return (
          <li key={c.id} className="flex">
            <div className="group relative flex h-full w-full flex-col">
              {/* Badge overlay — positioned over the image's top-left. Its own
                  links, above the card anchor (z-10). */}
              {p.toggles.showCategory && c.categories.length > 0 && (
                <div className="pointer-events-none absolute left-4 top-4 z-10">
                  <div className="pointer-events-auto">
                    <CategoryPills card={c} onDark={p.onDark} overImage />
                  </div>
                </div>
              )}
              <PostCard
                card={c}
                media={p.media}
                toggles={{ ...p.toggles, showCategory: false }}
                cardStyle={style}
                spacing={p.spacing}
                aspect={p.aspect}
                columns={cols}
                onDark={p.onDark}
                priority={i < cols}
                variant="stacked"
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// List — stacked rows, image-left + text-right (image position option). One
// column; great for archives / sidebars.
export function ListTemplate(p: TemplateProps) {
  return (
    <ul className={clsx('flex flex-col', GRID_GAP[p.spacing])}>
      {p.cards.map((c, i) => (
        <li key={c.id}>
          <PostCard
            card={c}
            media={p.media}
            toggles={p.toggles}
            cardStyle={p.cardStyle}
            spacing={p.spacing}
            aspect={p.aspect}
            columns={1}
            onDark={p.onDark}
            priority={i < 1}
            variant="row"
            imageSide={p.imageSide ?? 'left'}
          />
        </li>
      ))}
    </ul>
  )
}

// Magazine — ONE large featured lead post + a grid of smaller ones. Editorial
// asymmetric, featured-first. The lead spans full width; the rest fill a
// columns-driven grid beneath. Degrades gracefully to a single feature when
// there's only one post.
export function MagazineTemplate(p: TemplateProps) {
  const [lead, ...rest] = p.cards
  if (!lead) return null
  const tones = textTones(p.onDark)
  // The rest grid uses up to 3 columns (a magazine secondary rail), clamped by
  // the operator's columns choice.
  const restCols: Columns = Math.min(3, Math.max(2, p.columns)) as Columns
  const readMore = p.toggles.readMoreLabel?.trim() || 'Read the story'
  return (
    <div className={clsx('flex flex-col', GRID_GAP[p.spacing])}>
      {/* Lead — large feature. Image left, copy right on wide screens. */}
      <article className="group">
        <a
          href={lead.url}
          className={clsx(
            'grid gap-6 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-champagne focus-visible:ring-offset-2 lg:grid-cols-2 lg:items-center lg:gap-10',
            p.onDark ? 'focus-visible:ring-offset-obsidian' : 'focus-visible:ring-offset-cream-50',
          )}
        >
          {p.toggles.showImage && (
            <CardImage
              card={lead}
              media={p.media}
              aspect={p.aspect}
              columns={1}
              priority
              onDark={p.onDark}
            />
          )}
          <div>
            {p.toggles.showDate && lead.published_at && (
              <time
                className="font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne"
                dateTime={new Date(lead.published_at as string | Date).toISOString()}
              >
                {new Date(lead.published_at as string | Date).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
            )}
            <h3
              className={clsx(
                'mt-2 font-serif text-3xl font-bold tracking-tight sm:text-4xl',
                tones.title,
                clampClass(p.toggles.titleClamp || 3),
              )}
            >
              {lead.title}
            </h3>
            {p.toggles.showExcerpt && lead.excerpt && (
              <p className={clsx('mt-3 font-sans text-base leading-relaxed sm:text-lg', tones.excerpt, clampClass(p.toggles.excerptClamp || 4))}>
                {lead.excerpt}
              </p>
            )}
            <span className="mt-5 inline-flex w-fit items-center gap-1.5 font-sans text-sm font-semibold tracking-wide text-champagne" aria-hidden>
              {readMore}
            </span>
          </div>
        </a>
        {p.toggles.showCategory && <CategoryPills card={lead} onDark={p.onDark} />}
      </article>

      {/* Secondary grid of the remaining posts. */}
      {rest.length > 0 && (
        <ul className={clsx('grid', GRID_COLS[restCols], GRID_GAP[p.spacing])}>
          {rest.map((c) => (
            <li key={c.id} className="flex">
              <div className="w-full">
                <PostCard
                  card={c}
                  media={p.media}
                  toggles={p.toggles}
                  cardStyle={p.cardStyle}
                  spacing={p.spacing}
                  aspect={p.aspect}
                  columns={restCols}
                  onDark={p.onDark}
                  variant="stacked"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
