import clsx from 'clsx'
import { ArrowRight } from 'lucide-react'
import { MediaImg } from '../MediaImg'
import type { RenderContext } from '..'
import type { HydratedPostCardCtx } from '..'
import {
  ASPECT_CLASS,
  CARD_PAD,
  IMAGE_HOVER_ZOOM,
  cardChrome,
  cardSizes,
  clampClass,
  textTones,
  type CardStyle,
  type Columns,
  type ImageAspect,
  type Spacing,
} from './styles'

// One post card — the shared primitive for grid / cards / list / magazine.
// Synchronous (server + editor-canvas safe). The WHOLE card is a real <a> with
// an accessible name + a visible focus ring; category pills render OUTSIDE the
// anchor (no nested <a>) so each pill is its own term-archive link (#0.592).

export interface PostCardToggles {
  showImage: boolean
  showDate: boolean
  showAuthor: boolean
  showCategory: boolean
  showExcerpt: boolean
  showReadingTime: boolean
  showReadMore: boolean
  readMoreLabel?: string
  titleClamp: number
  excerptClamp: number
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// First letter of the author name → monogram fallback (no avatar column).
function monogram(name: string | null | undefined): string {
  const c = (name ?? '').trim().charAt(0)
  return c ? c.toUpperCase() : '·'
}

/** The meta row (date · author · reading time). Rendered inside the card text
 *  block, above the title, when any meta toggle is on. */
function MetaRow({
  card,
  toggles,
  onDark,
}: {
  card: HydratedPostCardCtx
  toggles: PostCardToggles
  onDark: boolean
}) {
  const tones = textTones(onDark)
  const date = toggles.showDate ? formatDate(card.published_at) : null
  const showReading = toggles.showReadingTime && typeof card.reading_minutes === 'number'
  const author = toggles.showAuthor ? card.author : undefined
  const hasAuthorName = !!author && !!author.name
  if (!date && !showReading && !author) return null
  const dot = (
    <span aria-hidden className={clsx('text-xs', tones.meta)}>
      ·
    </span>
  )
  const parts: React.ReactNode[] = []
  if (date) {
    parts.push(
      <time
        key="date"
        className="font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne"
        dateTime={new Date(card.published_at as string | Date).toISOString()}
      >
        {date}
      </time>,
    )
  }
  if (author) {
    parts.push(
      <span key="author" className="inline-flex items-center gap-2">
        <span
          aria-hidden
          className={clsx(
            'grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold',
            onDark ? 'bg-ivory/10 text-ivory/80' : 'bg-champagne/20 text-antique-gold',
          )}
        >
          {monogram(author.name)}
        </span>
        <span className={clsx('font-sans text-xs font-medium', tones.meta)}>
          {hasAuthorName ? author.name : 'Staff'}
        </span>
      </span>,
    )
  }
  if (showReading) {
    parts.push(
      <span
        key="reading"
        className={clsx('font-sans text-xs font-medium uppercase tracking-eyebrow', tones.meta)}
      >
        {card.reading_minutes} min read
      </span>,
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-3">
          {i > 0 && dot}
          {p}
        </span>
      ))}
    </div>
  )
}

/** Category cross-link pills — OUTSIDE the card anchor (no nested <a>). Each is
 *  its own link to the term archive (#0.592). */
export function CategoryPills({
  card,
  onDark,
  overImage = false,
}: {
  card: HydratedPostCardCtx
  onDark: boolean
  overImage?: boolean
}) {
  if (!card.categories || card.categories.length === 0) return null
  const tones = textTones(onDark)
  return (
    <div className={clsx('flex flex-wrap gap-2', overImage ? '' : 'mt-3')}>
      {card.categories.map((c) => (
        <a
          key={c.slug}
          href={c.url}
          className={clsx(
            'inline-flex w-fit items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-eyebrow ring-1 transition-colors',
            overImage
              ? 'bg-obsidian/70 text-ivory ring-ivory/20 backdrop-blur-sm hover:bg-obsidian/85'
              : tones.pill,
          )}
        >
          {c.name}
        </a>
      ))}
    </div>
  )
}

/** The image block — aspect-ratio box (no CLS) + srcset/sizes/lazy + a tasteful
 *  fallback when the post has no hero (#3, #7). `priority` skips lazy-load for
 *  the above-the-fold first row (LCP protection). */
export function CardImage({
  card,
  media,
  aspect,
  columns,
  priority,
  onDark,
  rounded = true,
  className,
}: {
  card: HydratedPostCardCtx
  media: RenderContext['media']
  aspect: ImageAspect
  columns: Columns
  priority: boolean
  onDark: boolean
  rounded?: boolean
  className?: string
}) {
  const tones = textTones(onDark)
  const m = card.hero_image_id ? media.get(card.hero_image_id) : undefined
  return (
    <div
      className={clsx(
        'relative w-full overflow-hidden',
        ASPECT_CLASS[aspect],
        rounded && 'rounded-2xl',
        className,
      )}
    >
      {m && m.variants ? (
        <MediaImg
          media={m}
          alt={card.title}
          variant="md"
          priority={priority}
          sizes={cardSizes(columns)}
          className={clsx('absolute inset-0 h-full w-full object-cover', IMAGE_HOVER_ZOOM)}
        />
      ) : (
        // Designed fallback — a tinted monogram surface, never a broken gap.
        <div
          className={clsx('absolute inset-0 grid place-items-center', tones.fallback)}
          aria-hidden
        >
          <span className="font-serif text-5xl font-bold">{monogram(card.title)}</span>
        </div>
      )}
    </div>
  )
}

/** A full card. `variant` switches the internal layout: 'stacked' (image-top,
 *  grid/cards), 'row' (image-left/right, list), 'feature' (large magazine
 *  lead). `padded` wraps the text in inner padding (cards/soft/elevated). */
export function PostCard({
  card,
  media,
  toggles,
  cardStyle,
  spacing,
  aspect,
  columns,
  onDark,
  priority = false,
  variant = 'stacked',
  imageSide = 'left',
}: {
  card: HydratedPostCardCtx
  media: RenderContext['media']
  toggles: PostCardToggles
  cardStyle: CardStyle
  spacing: Spacing
  aspect: ImageAspect
  columns: Columns
  onDark: boolean
  priority?: boolean
  variant?: 'stacked' | 'row' | 'feature'
  imageSide?: 'left' | 'right' | 'none'
}) {
  const tones = textTones(onDark)
  const padded = cardStyle !== 'flat' && variant !== 'row'
  const readMoreLabel = toggles.readMoreLabel?.trim() || 'Read more'

  const textBlock = (
    <div className={clsx(variant === 'row' && 'sm:flex-1', padded && CARD_PAD[spacing])}>
      <MetaRow card={card} toggles={toggles} onDark={onDark} />
      <h3
        className={clsx(
          'mt-2 font-serif font-bold tracking-tight',
          variant === 'feature' ? 'text-2xl sm:text-3xl' : 'text-xl sm:text-2xl',
          tones.title,
          clampClass(toggles.titleClamp),
        )}
      >
        {card.title}
      </h3>
      {toggles.showExcerpt && card.excerpt && (
        <p
          className={clsx(
            'mt-2 font-sans text-base leading-relaxed',
            tones.excerpt,
            clampClass(toggles.excerptClamp),
          )}
        >
          {card.excerpt}
        </p>
      )}
      {toggles.showReadMore && (
        <span
          className={clsx(
            'mt-4 inline-flex w-fit items-center gap-1.5 font-sans text-sm font-semibold tracking-wide text-champagne',
            'motion-safe:transition-transform',
          )}
          aria-hidden
        >
          {readMoreLabel}
          <ArrowRight className="h-4 w-4 motion-safe:transition-transform motion-safe:group-hover:translate-x-1" strokeWidth={2} />
        </span>
      )}
    </div>
  )

  const imageBlock =
    toggles.showImage && imageSide !== 'none' ? (
      <CardImage
        card={card}
        media={media}
        aspect={aspect}
        columns={columns}
        priority={priority}
        onDark={onDark}
        rounded={cardStyle === 'flat'}
        className={clsx(
          variant === 'row' && 'sm:w-2/5 sm:shrink-0',
        )}
      />
    ) : null

  // Accessible name: the title carries the link text; the whole card is the
  // anchor with a visible focus ring. Category pills live OUTSIDE the anchor.
  return (
    <div className="group flex h-full flex-col">
      <a
        href={card.url}
        className={clsx(
          'block h-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-champagne focus-visible:ring-offset-2',
          onDark ? 'focus-visible:ring-offset-obsidian' : 'focus-visible:ring-offset-cream-50',
          cardChrome(cardStyle, onDark),
          variant === 'row' && 'flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8',
          variant === 'row' && imageSide === 'right' && 'sm:flex-row-reverse',
        )}
      >
        {variant !== 'row' && imageBlock}
        {variant === 'row' && imageBlock}
        {textBlock}
      </a>
      {toggles.showCategory && <CategoryPills card={card} onDark={onDark} />}
    </div>
  )
}
