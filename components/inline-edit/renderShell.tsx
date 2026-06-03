import { type ReactNode } from 'react'
import clsx from 'clsx'
import { getUploadedMedia } from '@/lib/cms/uploadedMediaRegistry'
import {
  clampColumnsCount,
  htmlIdForBlock,
  parseColumnMeta,
  parseSectionMeta,
  SECTION_BACKGROUND_CLASS,
  SECTION_COLUMNS_CLASS,
  SECTION_CONTENT_WIDTH_CLASS,
  SECTION_PADDING_CLASS,
  decorationStyle,
  decorationHoverClass,
  visibilityClasses,
  type SectionBackground,
  type SectionBackgroundFit,
  type SectionBackgroundOverlay,
  type SectionMinHeight,
} from '@/lib/cms/blockMeta'
import { spacingClass, spacingStyle } from '@/lib/cms/spacingClasses'
import { compileGradient } from '@/lib/cms/gradient'
import { buildScopedCss } from '@/lib/cms/customCss'
import { ShapeDivider } from '@/components/blocks/_shared/ShapeDivider'
import { SectionMotion } from '@/components/blocks/_shared/SectionMotion'
import { SectionBackdrop } from '@/components/blocks/_shared/SectionBackdrop'
import type { SectionBackgroundImage } from '@/lib/cms/blockMeta'

// Lookup tables for the new section background-image controls. JIT-
// static strings so Tailwind's scanner emits every utility used.
//
// `MIN_HEIGHT_CLASS` floor — pairs with the section's natural content
// height; the larger of the two wins. Mobile sizes use one tier lower
// so a phone doesn't waste half the screen on a hero band. `screen`
// uses `min-h-screen` which is plain `100vh` — for new code consider
// `100svh` once Tailwind v4's small-viewport-height utility lands.
const SECTION_MIN_HEIGHT_CLASS: Record<SectionMinHeight, string> = {
  none: '',
  sm: 'min-h-[320px] sm:min-h-[360px]',
  md: 'min-h-[420px] sm:min-h-[480px]',
  lg: 'min-h-[520px] sm:min-h-[620px]',
  xl: 'min-h-[640px] sm:min-h-[760px]',
  screen: 'min-h-screen',
}

// Overlay tint composited above the background image, below content.
// `gradient-bottom` is the editorial default for hero sections — darkens
// the lower third where the heading typically sits so the type stays
// legible without flattening the whole photo. `champagne` warms the
// image with the brand accent; `darken-strong` is for photos that need
// real contrast lift (text laid directly over a busy mid-tone image).
const SECTION_OVERLAY_CLASS: Record<SectionBackgroundOverlay, string> = {
  none: '',
  darken: 'bg-obsidian/35',
  'darken-strong': 'bg-obsidian/60',
  'gradient-bottom':
    'bg-gradient-to-t from-obsidian/85 via-obsidian/30 to-transparent',
  champagne:
    'bg-gradient-to-t from-champagne/35 via-obsidian/15 to-transparent',
}

// `object-fit` choice for the background image. Static strings so JIT
// picks every variant up. 'cover' is the hero default — fills the box,
// crops overflow. 'contain' shows the whole photo letterboxed (good for
// logos or aspect-mismatched portraits). 'fill' stretches (rarely
// editorially useful). 'none' + 'scale-down' are escape hatches.
const SECTION_BG_FIT_CLASS: Record<SectionBackgroundFit, string> = {
  cover: 'object-cover',
  contain: 'object-contain',
  fill: 'object-fill',
  none: 'object-none',
  'scale-down': 'object-scale-down',
}

// Shared layout primitives for the section→column→widget tree.
//
// Pure shape helpers — no client hooks, no server-only imports, no
// editable affordances. Both the server BlockTreeRenderer (anonymous /
// non-editable visitors) and the client EditableBlockTreeRenderer
// (active editor surface) import these to emit the SAME wrapper HTML
// so a section flipped in the editor renders identically the next
// time an anonymous visitor loads the page.
//
// Caller decides:
//   - whether to expose data-section-id / data-column-id (admin paths
//     ship the row PK; anonymous renders elide it for info-disclosure
//     hardening)
//   - whether `meta` is the persisted blob or a preview-merged overlay
//     (editor surface passes effective meta from useEffectiveBlockMeta;
//     non-editable passes block.meta verbatim)

export interface SectionFrameProps {
  /** Parsed-or-raw section meta. Caller can pass a preview-merged
   *  overlay (edit-mode live preview) or the persisted blob — the
   *  frame re-parses defensively. */
  meta: unknown
  /** Living column-row count. Drives the grid track count via
   *  clampColumnsCount — meta.columns is a creation hint only;
   *  the renderer follows whatever's actually there. */
  columnCount: number
  /** Section row PK. Emitted as `data-section-id` only when
   *  `exposeId` is true (admin surface). */
  sectionId: number
  exposeId: boolean
  /** Hydrated media map. Required only when the section's meta carries
   *  `backgroundImage` — the frame resolves media_id → variant URL for
   *  the cover-image render path. Both renderers (server + editable
   *  client) already hold this map for widget rendering; passing it
   *  here too lets the section frame paint the bg image without
   *  threading a separate lookup. */
  media?: Map<number, { variants: Record<string, string> | null }>
  children: ReactNode
}

export function SectionFrame({
  meta,
  columnCount,
  sectionId,
  exposeId,
  media,
  children,
}: SectionFrameProps) {
  const parsed = parseSectionMeta(meta)
  // Empty section (zero column rows) falls back to single-column so the
  // wrapper still renders with usable padding rather than collapsing
  // to zero height.
  const gridColumns =
    columnCount === 0 ? 1 : clampColumnsCount(columnCount)
  // Chunk E: per-side spacing overrides. The shorthand SECTION_PADDING
  // stays for back-compat; per-side classes use !-important so they
  // beat the shorthand at every responsive breakpoint without having
  // to generate matching sm:/md: variants.
  const spacing = spacingClass(parsed)
  // Arbitrary hex background override: inline style beats the token bg
  // utility class, so an operator/agent can match any brand colour exactly.
  // A gradient background (when set) wins over the hex/token via
  // background-image.
  const gradientCss = compileGradient(parsed.backgroundGradient)
  const style = {
    ...spacingStyle(parsed),
    ...((parsed as { backgroundColor?: string }).backgroundColor
      ? { backgroundColor: (parsed as { backgroundColor?: string }).backgroundColor }
      : {}),
    ...(gradientCss ? { backgroundImage: gradientCss } : {}),
    ...decorationStyle(parsed),
  }
  const visibility = visibilityClasses(parsed)
  const htmlId = htmlIdForBlock(parsed)

  // Cover-image background resolution. media_id → lg/md/og URL. We
  // render the photo as an absolutely-positioned <img> rather than a
  // CSS background-image so the browser preload scanner can discover
  // it directly from HTML (LCP win for hero sections — bg-image lives
  // in CSS that has to download + parse first). Falls back silently
  // when the media row is missing variants; the section still renders
  // with its background-token paint.
  const resolveBgSrc = (m: SectionBackgroundImage): string | null => {
    const md = media?.get(m.media_id) ?? getUploadedMedia(m.media_id)
    return md?.variants?.lg ?? md?.variants?.md ?? md?.variants?.og ?? null
  }
  // Build the slide list. A `backgroundSlides` array (2+ photos) drives the
  // animated slideshow; otherwise fall back to the single `backgroundImage`
  // so a lone image with Ken Burns still animates. Unresolved rows dropped.
  const slideMetas: SectionBackgroundImage[] =
    parsed.backgroundSlides && parsed.backgroundSlides.length
      ? parsed.backgroundSlides
      : parsed.backgroundImage
        ? [parsed.backgroundImage]
        : []
  const slides = slideMetas
    .map((m) => ({ src: resolveBgSrc(m), alt: m.alt }))
    .filter((s): s is { src: string; alt: string } => s.src !== null)
  const kenBurns = parsed.kenBurns ?? 'none'
  const overlay = parsed.backgroundOverlay ?? 'none'
  const minHeight = parsed.minHeight ?? 'none'
  const hasCoverImage = slides.length >= 1
  // Animated backdrop when there's a slideshow (2+) OR a single image with Ken
  // Burns; a lone static image keeps the zero-JS <img> path.
  const animatedBg = slides.length >= 2 || (slides.length === 1 && kenBurns !== 'none')
  // Background video (Elementor parity) — looping muted autoplay behind
  // content. Optional poster image resolved from media.
  const hasVideo = !!parsed.backgroundVideoUrl
  const posterMedia = parsed.backgroundVideoPoster
    ? (media?.get(parsed.backgroundVideoPoster.media_id) ??
       getUploadedMedia(parsed.backgroundVideoPoster.media_id))
    : undefined
  const posterSrc =
    posterMedia?.variants?.lg ?? posterMedia?.variants?.md ?? posterMedia?.variants?.og ?? undefined
  // Shape dividers (Elementor parity) — SVG separators on the top/bottom
  // edges. They need a positioning + clipping context on the section.
  const hasDivider = !!(parsed.shapeTop || parsed.shapeBottom)
  // Per-block custom CSS (E19) — scoped to `.cms-r-{sectionId}`.
  const sectionCss = buildScopedCss(sectionId, parsed.customCss, parsed.customCssHover)

  return (
    <section
      data-section-id={exposeId ? sectionId : undefined}
      id={htmlId}
      className={clsx(
        // `relative` so the absolutely-positioned <img> + overlay + shape
        // dividers anchor inside the section. `overflow-hidden` clips any
        // image overflow + the divider SVGs at the edges.
        (hasCoverImage || hasDivider || hasVideo) && 'relative overflow-hidden',
        decorationHoverClass(parsed),
        sectionCss && `cms-r-${sectionId}`,
        SECTION_BACKGROUND_CLASS[parsed.background],
        SECTION_PADDING_CLASS[parsed.padding],
        SECTION_MIN_HEIGHT_CLASS[minHeight],
        // When a cover image is set, the section is naturally a hero
        // box — center the content vertically so a single heading
        // doesn't collapse to the top of the box. flex+items-center
        // pairs with the min-h baseline above.
        hasCoverImage && 'flex flex-col justify-center',
        spacing,
        visibility,
      )}
      style={style}
    >
      {sectionCss && <style dangerouslySetInnerHTML={{ __html: sectionCss }} />}
      {parsed.motionEffect && parsed.motionEffect !== 'none' && (
        <SectionMotion effect={parsed.motionEffect} intensity={parsed.motionIntensity} />
      )}
      {parsed.shapeTop && (
        <ShapeDivider
          type={parsed.shapeTop}
          position="top"
          height={parsed.shapeTopHeight}
          color={parsed.shapeTopColor}
          flipX={parsed.shapeTopFlip}
        />
      )}
      {parsed.shapeBottom && (
        <ShapeDivider
          type={parsed.shapeBottom}
          position="bottom"
          height={parsed.shapeBottomHeight}
          color={parsed.shapeBottomColor}
          flipX={parsed.shapeBottomFlip}
        />
      )}
      {hasCoverImage && (
        <>
          {animatedBg ? (
            <SectionBackdrop
              slides={slides}
              fitClass={SECTION_BG_FIT_CLASS[parsed.backgroundFit ?? 'cover']}
              position={parsed.backgroundPosition}
              kenBurns={kenBurns}
              transition={parsed.slideTransition ?? 'through-black'}
              intervalMs={parsed.slideIntervalMs ?? 6000}
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={slides[0]!.src}
              // Decorative by default — content on top should carry the
              // semantic meaning. If the operator set alt text we honour it.
              alt={slides[0]!.alt}
              aria-hidden={slides[0]!.alt === '' ? 'true' : undefined}
              className={clsx(
                'absolute inset-0 h-full w-full',
                SECTION_BG_FIT_CLASS[parsed.backgroundFit ?? 'cover'],
              )}
              style={parsed.backgroundPosition ? { objectPosition: parsed.backgroundPosition } : undefined}
              // The hero section is virtually always above-the-fold; a
              // priority hint flips the browser's fetch strategy so the
              // image streams immediately. Cheap if not above the fold —
              // the browser falls back to normal priority.
              loading="eager"
              decoding="async"
              fetchPriority="high"
            />
          )}
          {overlay !== 'none' && (
            <div
              aria-hidden="true"
              className={clsx(
                'pointer-events-none absolute inset-0',
                SECTION_OVERLAY_CLASS[overlay],
              )}
            />
          )}
        </>
      )}
      {hasVideo && (
        <>
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src={parsed.backgroundVideoUrl}
            poster={posterSrc}
            autoPlay
            muted
            loop
            playsInline
            aria-hidden="true"
            style={parsed.backgroundPosition ? { objectPosition: parsed.backgroundPosition } : undefined}
          />
          {overlay !== 'none' && (
            <div
              aria-hidden="true"
              className={clsx('pointer-events-none absolute inset-0', SECTION_OVERLAY_CLASS[overlay])}
            />
          )}
        </>
      )}
      <div
        className={clsx(
          'mx-auto grid w-full gap-8 px-6 sm:px-10',
          SECTION_CONTENT_WIDTH_CLASS[parsed.contentMaxWidth ?? 'xl'],
          // Bump content above the bg + overlay layers so click
          // affordances + heading still respond to the cursor.
          (hasCoverImage || hasVideo) && 'relative z-10',
          SECTION_COLUMNS_CLASS[gridColumns],
        )}
      >
        {children}
      </div>
    </section>
  )
}

export interface ColumnFrameProps {
  columnId: number
  exposeId: boolean
  /** Chunk E: column meta carries per-side padding/margin overrides.
   *  Parsed defensively (same tolerant boundary the section frame uses)
   *  — a malformed blob renders with the column's natural flex stack
   *  rather than 500-ing the page. */
  meta?: unknown
  /** Hydrated media map. Required only when the column's meta carries
   *  `backgroundImage` — mirrors the SectionFrame `media` prop. */
  media?: Map<number, { variants: Record<string, string> | null }>
  children: ReactNode
}

export function ColumnFrame({
  columnId,
  exposeId,
  meta,
  media,
  children,
}: ColumnFrameProps) {
  const parsed = parseColumnMeta(meta)
  const spacing = spacingClass(parsed)
  // Arbitrary hex background override: inline style beats the token bg
  // utility class, so an operator/agent can match any brand colour exactly.
  // A gradient background (when set) wins over the hex/token via
  // background-image.
  const gradientCss = compileGradient(parsed.backgroundGradient)
  const style = {
    ...spacingStyle(parsed),
    ...((parsed as { backgroundColor?: string }).backgroundColor
      ? { backgroundColor: (parsed as { backgroundColor?: string }).backgroundColor }
      : {}),
    ...(gradientCss ? { backgroundImage: gradientCss } : {}),
    ...decorationStyle(parsed),
  }
  const visibility = visibilityClasses(parsed)
  const htmlId = htmlIdForBlock(parsed)

  // Inline row primitive — when childLayout === 'row', lay the column's
  // widgets HORIZONTALLY (flex flex-wrap) instead of the default vertical
  // block flow. Each child sizes to its content (the widget's own
  // mx-auto collapses to content width inside flex — exactly what a row
  // of buttons / badges / logos / stats wants). childJustify controls the
  // horizontal distribution. Default stays the vertical `space-y-6` stack.
  const isRow = parsed.childLayout === 'row'
  const isGrid = parsed.childLayout === 'grid'
  const rowJustify =
    parsed.childJustify === 'center'
      ? 'justify-center'
      : parsed.childJustify === 'end'
        ? 'justify-end'
        : parsed.childJustify === 'between'
          ? 'justify-between'
          : 'justify-start'
  // Grid columns map to Tailwind classes (1–4); the gap is an inline style
  // when overridden, else the tier default.
  const gridColsClass =
    parsed.childColumns === 1
      ? 'grid-cols-1'
      : parsed.childColumns === 3
        ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
        : parsed.childColumns === 4
          ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
          : 'grid-cols-1 sm:grid-cols-2'
  const childGapStyle =
    typeof parsed.childGap === 'number' ? { gap: `${parsed.childGap}px` } : undefined
  const childFlow = isGrid
    ? clsx('grid', gridColsClass, !childGapStyle && 'gap-6')
    : isRow
      ? clsx('flex flex-wrap items-center', !childGapStyle && 'gap-6', rowJustify)
      : 'space-y-6'

  // Cover-image background — same pattern as SectionFrame. Renders
  // an absolutely-positioned <img object-cover> behind the column's
  // content + an optional overlay. Lets the operator build "split
  // hero" layouts (text column next to a photo column) without
  // touching CSS.
  const bgImage = parsed.backgroundImage
  const bgMedia = bgImage
    ? (media?.get(bgImage.media_id) ?? getUploadedMedia(bgImage.media_id))
    : undefined
  const bgSrc =
    bgMedia?.variants?.lg ??
    bgMedia?.variants?.md ??
    bgMedia?.variants?.og ??
    null
  const overlay = parsed.backgroundOverlay ?? 'none'
  const minHeight = parsed.minHeight ?? 'none'
  const hasCoverImage = bgImage !== undefined && bgSrc !== null

  // CARD TREATMENT — a column with a SOLID background (a hex colour or a
  // gradient, but not a cover photo) reads as a card: round its corners and
  // give it interior padding so the content doesn't touch the edges. This
  // is the native primitive for "feature card" rows (heading + body on a
  // subtle surface) without forcing an icon (lx_icon_box). Padding is only
  // the default when the operator hasn't set explicit per-side padding, so
  // it never fights an intentional value.
  const colBgColor = (parsed as { backgroundColor?: string }).backgroundColor
  const hasSolidBg = !hasCoverImage && (!!colBgColor || !!parsed.backgroundGradient)
  const hasExplicitPadding =
    parsed.paddingTop !== undefined ||
    parsed.paddingBottom !== undefined ||
    parsed.paddingLeft !== undefined ||
    parsed.paddingRight !== undefined
  const cardClasses = hasSolidBg
    ? clsx('rounded-2xl', !hasExplicitPadding && 'p-8 sm:p-10')
    : undefined
  // Per-block custom CSS (E19) — scoped to `.cms-r-{columnId}`.
  const columnCss = buildScopedCss(columnId, parsed.customCss, parsed.customCssHover)

  // Whole-card link. Rendered as a stretched-link OVERLAY anchor (see
  // `.cms-card-link` in globals.css + the ColumnMeta.cardLink comment),
  // NOT a wrapping <a> — wrapping would nest interactive content (an
  // inner lx_action is its own <a>) and break the card click. The
  // overlay covers the whole column; inner interactive controls are
  // raised above it in CSS so they stay independently clickable.
  const cardLink = parsed.cardLink
  const hasCardLink = !!cardLink?.href
  const cardLinkOverlay = hasCardLink ? (
    <a
      href={cardLink!.href}
      aria-label={parsed.cardLinkLabel || undefined}
      className="cms-card-link__overlay"
      {...(cardLink!.openInNew
        ? { target: '_blank', rel: 'noopener noreferrer' }
        : {})}
    />
  ) : null

  return (
    <div
      data-column-id={exposeId ? columnId : undefined}
      id={htmlId}
      style={childGapStyle ? { ...style, ...childGapStyle } : style}
      className={clsx(
        // Block-flow stacking instead of `flex flex-col gap-6`. Widget
        // renderers wrap themselves in `<section class="max-w-4xl mx-auto">`
        // and similar — inside a flex container, the `mx-auto` collapses
        // each child to its content width (flex auto-margin semantics
        // override the max-width stretch), shrinking eyebrow/heading
        // widgets to ~120px. Block layout lets each widget fill the
        // column's width, with the widget's own max-w + mx-auto correctly
        // capping and centering. `space-y-6` reproduces the gap-6 visual
        // gap via sibling margin-top. In row mode (childLayout: 'row')
        // this becomes a horizontal flex-wrap instead — see childFlow.
        childFlow,
        // Cover-image columns need overflow-hidden so object-cover
        // crops cleanly + relative anchor for the absolute <img>.
        hasCoverImage && 'relative overflow-hidden rounded-2xl',
        // Solid-bg column → card (rounded + interior padding).
        cardClasses,
        decorationHoverClass(parsed),
        columnCss && `cms-r-${columnId}`,
        // Whole-card link: positions + isolates the stretched-link
        // overlay and enables the hover lift (see globals.css).
        hasCardLink && 'cms-card-link',
        SECTION_MIN_HEIGHT_CLASS[minHeight],
        parsed.verticalAlign === 'center' && 'self-center',
        parsed.verticalAlign === 'start' && 'self-start',
        parsed.verticalAlign === 'end' && 'self-end',
        spacing,
        visibility,
      )}
    >
      {columnCss && <style dangerouslySetInnerHTML={{ __html: columnCss }} />}
      {hasCoverImage && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={bgSrc}
            alt={bgImage!.alt}
            aria-hidden={bgImage!.alt === '' ? 'true' : undefined}
            className={clsx(
              'absolute inset-0 h-full w-full',
              SECTION_BG_FIT_CLASS[parsed.backgroundFit ?? 'cover'],
            )}
            loading="lazy"
            decoding="async"
          />
          {overlay !== 'none' && (
            <div
              aria-hidden="true"
              className={clsx(
                'pointer-events-none absolute inset-0',
                SECTION_OVERLAY_CLASS[overlay],
              )}
            />
          )}
          {/* Inner padding so widgets don't hug the rounded corner of
              the column when a bg image is set. Same horizontal floor
              the section uses for its grid container. The explicit z-10
              is DROPPED when a card link is present so the stretched-link
              overlay can sit above the content background; layering is
              handled by `.cms-card-link` in globals.css instead. */}
          <div
            className={clsx(
              'relative space-y-6 p-6 sm:p-8',
              !hasCardLink && 'z-10',
            )}
          >
            {children}
          </div>
        </>
      )}
      {!hasCoverImage && children}
      {parsed.motionEffect && parsed.motionEffect !== 'none' && (
        <SectionMotion effect={parsed.motionEffect} intensity={parsed.motionIntensity} />
      )}
      {cardLinkOverlay}
    </div>
  )
}

/** Resolve the section's background tone from any meta-shaped value
 *  (persisted or preview-merged). Used by the empty-column drop-zone
 *  on the editable surface to pick a contrast-safe palette. */
export function readSectionBackground(meta: unknown): SectionBackground {
  return parseSectionMeta(meta).background
}
