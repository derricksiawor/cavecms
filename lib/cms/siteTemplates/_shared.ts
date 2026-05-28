// Shared block-spec helpers for site-template authoring. Each helper
// returns a WidgetSpec / ColumnSpec / SectionSpec so a template file
// reads like a layout sketch instead of a wall of nested JSON literals.
//
// Helpers exist for every primitive the templates use:
//   - eyebrow / heading / text / action
//   - channelCard / stat / quote / map / spacer
//   - column / col-shorthands
//   - section / oneCol / twoCols / threeCols
//   - composite: hero, ctaBanner, threeColCards, statRow
//
// Backgrounds are the validated section meta enum from blockMeta.ts:
//   cream | near-black | copper-tint | obsidian | ivory | champagne |
//   bone | charcoal
//
// Padding is the validated enum: sm | md | lg | xl | 2xl

import type { ColumnSpec, SectionSpec, WidgetSpec } from './types'

export type SectionBackground =
  | 'cream'
  | 'near-black'
  | 'copper-tint'
  | 'obsidian'
  | 'ivory'
  | 'champagne'
  | 'bone'
  | 'charcoal'

export type SectionPadding = 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'

export type Tone = 'obsidian' | 'ivory' | 'champagne' | 'warm-stone' | 'bone'

// ─── Primitives ────────────────────────────────────────────────────

export function eyebrow(
  text: string,
  opts: {
    tone?: Tone
    alignment?: 'left' | 'center' | 'right'
    prefix?: 'rule' | 'none'
  } = {},
): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'lx_eyebrow',
    data: {
      text,
      prefix: opts.prefix ?? 'none',
      tone: opts.tone ?? 'champagne',
      alignment: opts.alignment ?? 'left',
      animation: 'fade-in',
    },
  }
}

export function heading(
  text: string,
  opts: {
    level?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
    size?:
      | 'display-2xl'
      | 'display-xl'
      | 'display-lg'
      | 'display-md'
      | 'display-sm'
    alignment?: 'left' | 'center' | 'right'
    tone?: Tone
    italic?: boolean
    animation?: 'none' | 'fade-in' | 'slide-up' | 'line-reveal'
    marginTop?: 'xs' | 'sm' | 'md' | 'lg'
  } = {},
): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'lx_heading',
    data: {
      text,
      level: opts.level ?? 'h2',
      size: opts.size ?? 'display-lg',
      alignment: opts.alignment ?? 'left',
      tone: opts.tone ?? 'ivory',
      italic: opts.italic ?? false,
      animation: opts.animation ?? 'slide-up',
    },
    meta: opts.marginTop ? { marginTop: opts.marginTop } : undefined,
  }
}

export function text(
  richtext: string,
  opts: {
    size?: 'body-lg' | 'body-md' | 'body-sm'
    alignment?: 'left' | 'center'
    tone?: Tone
    maxWidth?: 'narrow' | 'medium' | 'wide' | 'full'
    animation?: 'none' | 'fade-in' | 'slide-up'
    marginTop?: 'xs' | 'sm' | 'md' | 'lg'
  } = {},
): WidgetSpec {
  // Auto-wrap raw strings without HTML tags into a <p>. Lets template
  // authors write `text('Some sentence.')` and `text('<p>X</p><p>Y</p>')`
  // interchangeably without remembering when wrapping is required.
  const body = /<\w+/.test(richtext) ? richtext : `<p>${richtext}</p>`
  return {
    kind: 'widget',
    blockType: 'lx_text',
    data: {
      body_richtext: body,
      size: opts.size ?? 'body-md',
      alignment: opts.alignment ?? 'left',
      tone: opts.tone ?? 'ivory',
      maxWidth: opts.maxWidth ?? 'medium',
      animation: opts.animation ?? 'fade-in',
    },
    meta: opts.marginTop ? { marginTop: opts.marginTop } : undefined,
  }
}

export function action(
  label: string,
  href: string,
  opts: {
    variant?: 'primary-gold' | 'secondary-outline' | 'ghost' | 'link-arrow'
    size?: 'sm' | 'md' | 'lg'
    alignment?: 'left' | 'center' | 'right'
    openInNew?: boolean
    marginTop?: 'xs' | 'sm' | 'md' | 'lg'
  } = {},
): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'lx_action',
    data: {
      label,
      href,
      openInNew: opts.openInNew ?? false,
      variant: opts.variant ?? 'primary-gold',
      size: opts.size ?? 'md',
      alignment: opts.alignment ?? 'left',
      animation: 'fade-in',
    },
    meta: opts.marginTop ? { marginTop: opts.marginTop } : undefined,
  }
}

export function channelCard(opts: {
  label: string
  value: string
  description?: string
  href?: string
  icon?: string
  tone?: Tone
}): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'lx_channel_card',
    data: {
      label: opts.label,
      value: opts.value,
      description: opts.description,
      href: opts.href,
      icon: opts.icon,
      tone: opts.tone ?? 'ivory',
    },
  }
}

export function stat(opts: {
  value: number
  label: string
  prefix?: string
  suffix?: string
  decimals?: number
  alignment?: 'left' | 'center' | 'right'
  tone?: Tone
}): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'lx_stat',
    data: {
      value: opts.value,
      label: opts.label,
      prefix: opts.prefix,
      suffix: opts.suffix,
      decimals: opts.decimals ?? 0,
      duration_ms: 1800,
      alignment: opts.alignment ?? 'center',
      tone: opts.tone ?? 'ivory',
    },
  }
}

export function quote(
  body: string,
  attribution?: string,
  opts: { alignment?: 'left' | 'center'; tone?: Tone } = {},
): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'lx_quote',
    data: {
      quote: body,
      attribution,
      alignment: opts.alignment ?? 'center',
      tone: opts.tone ?? 'ivory',
      animation: 'line-reveal',
    },
  }
}

export function spacer(
  size:
    | 'section-xs'
    | 'section-sm'
    | 'section-md'
    | 'section-lg'
    | 'section-xl'
    | 'section-2xl' = 'section-md',
): WidgetSpec {
  return { kind: 'widget', blockType: 'lx_space', data: { size } }
}

export function map(opts: {
  embedUrl: string
  ratio?: '21:9' | '16:9' | '4:5' | '1:1'
  caption?: string
}): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'lx_map',
    data: {
      embedUrl: opts.embedUrl,
      ratio: opts.ratio ?? '16:9',
      caption: opts.caption,
      goldOverlay: false,
      animation: 'fade-in',
    },
  }
}

export function contactForm(opts: {
  heading?: string
  intro?: string
  submitLabel?: string
  successHeadline?: string
  successBody?: string
} = {}): WidgetSpec {
  return {
    kind: 'widget',
    blockType: 'contact_form',
    data: {
      heading: opts.heading ?? 'Send us a note.',
      intro:
        opts.intro ??
        'A short message about what you need — we will come back within one business day.',
      submit_label: opts.submitLabel ?? 'Send message',
      success_headline:
        opts.successHeadline ?? 'Thanks — we received your message.',
      success_body:
        opts.successBody ?? 'A member of our team will be in touch shortly.',
    },
  }
}

// ─── Column + section builders ─────────────────────────────────────

export function col(...widgets: WidgetSpec[]): ColumnSpec {
  return { kind: 'column', widgets }
}

export function section(opts: {
  background: SectionBackground
  padding?: SectionPadding
  columns: ColumnSpec[]
}): SectionSpec {
  return {
    kind: 'section',
    meta: {
      columns: opts.columns.length,
      background: opts.background,
      padding: opts.padding ?? 'md',
    },
    columns: opts.columns,
  }
}

export function oneCol(
  background: SectionBackground,
  padding: SectionPadding,
  ...widgets: WidgetSpec[]
): SectionSpec {
  return section({ background, padding, columns: [col(...widgets)] })
}

export function twoCols(
  background: SectionBackground,
  padding: SectionPadding,
  c1: WidgetSpec[],
  c2: WidgetSpec[],
): SectionSpec {
  return section({
    background,
    padding,
    columns: [col(...c1), col(...c2)],
  })
}

export function threeCols(
  background: SectionBackground,
  padding: SectionPadding,
  c1: WidgetSpec[],
  c2: WidgetSpec[],
  c3: WidgetSpec[],
): SectionSpec {
  return section({
    background,
    padding,
    columns: [col(...c1), col(...c2), col(...c3)],
  })
}

export function fourCols(
  background: SectionBackground,
  padding: SectionPadding,
  c1: WidgetSpec[],
  c2: WidgetSpec[],
  c3: WidgetSpec[],
  c4: WidgetSpec[],
): SectionSpec {
  return section({
    background,
    padding,
    columns: [col(...c1), col(...c2), col(...c3), col(...c4)],
  })
}

// ─── Composite blocks ──────────────────────────────────────────────

export function hero(opts: {
  background?: SectionBackground
  eyebrow?: string
  title: string
  body?: string
  cta?: { label: string; href: string }
  secondaryCta?: { label: string; href: string }
  tone?: Tone
}): SectionSpec {
  const tone = opts.tone ?? (opts.background === 'obsidian' ? 'ivory' : 'obsidian')
  const widgets: WidgetSpec[] = []
  if (opts.eyebrow) widgets.push(eyebrow(opts.eyebrow, { tone: 'champagne' }))
  widgets.push(
    heading(opts.title, {
      level: 'h1',
      size: 'display-2xl',
      tone,
      animation: 'slide-up',
      marginTop: opts.eyebrow ? 'sm' : undefined,
    }),
  )
  if (opts.body) {
    widgets.push(
      text(opts.body, { size: 'body-lg', tone, marginTop: 'md' }),
    )
  }
  if (opts.cta) {
    widgets.push(
      action(opts.cta.label, opts.cta.href, {
        size: 'lg',
        variant: 'primary-gold',
        marginTop: 'md',
      }),
    )
    if (opts.secondaryCta) {
      widgets.push(
        action(opts.secondaryCta.label, opts.secondaryCta.href, {
          size: 'lg',
          variant: 'ghost',
          marginTop: 'sm',
        }),
      )
    }
  }
  return oneCol(opts.background ?? 'obsidian', 'lg', ...widgets)
}

export function ctaBanner(opts: {
  background?: SectionBackground
  title: string
  body?: string
  cta: { label: string; href: string }
  tone?: Tone
}): SectionSpec {
  const tone = opts.tone ?? (opts.background === 'obsidian' ? 'ivory' : 'obsidian')
  const widgets: WidgetSpec[] = [
    heading(opts.title, {
      level: 'h2',
      size: 'display-md',
      tone,
      alignment: 'center',
    }),
  ]
  if (opts.body) {
    widgets.push(
      text(opts.body, {
        tone,
        alignment: 'center',
        maxWidth: 'medium',
        marginTop: 'sm',
      }),
    )
  }
  widgets.push(
    action(opts.cta.label, opts.cta.href, {
      alignment: 'center',
      size: 'lg',
      marginTop: 'md',
    }),
  )
  return oneCol(opts.background ?? 'obsidian', 'md', ...widgets)
}

/**
 * Three-column "cards" — for room lists, service lists, feature lists,
 * agent grids, etc. Each card is a heading + body, optionally with a
 * leading kicker (price tag, room number, sermon date).
 */
export function threeColCards(opts: {
  background?: SectionBackground
  sectionTitle?: string
  sectionBody?: string
  sectionTone?: Tone
  cards: Array<{
    kicker?: string
    title: string
    body: string
    cta?: { label: string; href: string }
  }>
}): SectionSpec[] {
  const bg = opts.background ?? 'ivory'
  const tone: Tone = bg === 'obsidian' || bg === 'near-black' || bg === 'charcoal'
    ? 'ivory'
    : 'obsidian'
  const sections: SectionSpec[] = []
  if (opts.sectionTitle || opts.sectionBody) {
    const intro: WidgetSpec[] = []
    if (opts.sectionTitle) {
      intro.push(
        heading(opts.sectionTitle, {
          level: 'h2',
          size: 'display-md',
          tone: opts.sectionTone ?? tone,
        }),
      )
    }
    if (opts.sectionBody) {
      intro.push(
        text(opts.sectionBody, {
          tone: opts.sectionTone ?? tone,
          marginTop: 'sm',
        }),
      )
    }
    sections.push(oneCol(bg, 'md', ...intro))
  }
  // Pad cards to a multiple of 3 so the grid stays even.
  const cards = opts.cards
  for (let i = 0; i < cards.length; i += 3) {
    const slice = cards.slice(i, i + 3)
    while (slice.length < 3) {
      slice.push({ title: '', body: '' })
    }
    const cols: ColumnSpec[] = slice.map((c) => {
      const widgets: WidgetSpec[] = []
      if (!c.title && !c.body) {
        // empty pad column — still need at least the column shell so
        // the grid row spaces correctly. Push a tiny spacer.
        widgets.push(spacer('section-xs'))
        return col(...widgets)
      }
      if (c.kicker) widgets.push(eyebrow(c.kicker, { tone: 'champagne' }))
      if (c.title) {
        widgets.push(
          heading(c.title, {
            level: 'h3',
            size: 'display-sm',
            tone,
            marginTop: c.kicker ? 'xs' : undefined,
          }),
        )
      }
      if (c.body) {
        widgets.push(
          text(c.body, {
            tone,
            maxWidth: 'wide',
            marginTop: 'xs',
          }),
        )
      }
      if (c.cta) {
        widgets.push(
          action(c.cta.label, c.cta.href, {
            variant: 'link-arrow',
            marginTop: 'sm',
          }),
        )
      }
      return col(...widgets)
    })
    sections.push({
      kind: 'section',
      meta: { columns: 3, background: bg, padding: 'md' },
      columns: cols,
    })
  }
  return sections
}

/** Three-column row of lx_stat — for "by the numbers" sections. */
export function statRow(opts: {
  background?: SectionBackground
  stats: Array<Parameters<typeof stat>[0]>
}): SectionSpec {
  const bg = opts.background ?? 'obsidian'
  const tone: Tone = bg === 'obsidian' || bg === 'near-black' || bg === 'charcoal'
    ? 'ivory'
    : 'obsidian'
  const cols = opts.stats.map((s) => col(stat({ ...s, tone })))
  return {
    kind: 'section',
    meta: { columns: cols.length, background: bg, padding: 'md' },
    columns: cols,
  }
}

/** Closing quote section — generous vertical space + centered italic display. */
export function closingQuote(opts: {
  background?: SectionBackground
  text: string
  attribution?: string
}): SectionSpec {
  const bg = opts.background ?? 'ivory'
  const tone: Tone = bg === 'obsidian' || bg === 'near-black' || bg === 'charcoal'
    ? 'ivory'
    : 'obsidian'
  return oneCol(
    bg,
    'lg',
    quote(opts.text, opts.attribution, { tone, alignment: 'center' }),
  )
}

/**
 * Three contact "channel cards" arranged as a 3-column row. Standard
 * shape: email, phone, address. Used at the bottom of Contact pages
 * and on landing hero "ways to reach us" strips.
 */
export function contactChannels(opts: {
  background?: SectionBackground
  email?: { value: string; href: string; description?: string }
  phone?: { value: string; href: string; description?: string }
  address?: { value: string; description?: string }
  hours?: { value: string; description?: string }
}): SectionSpec {
  const bg = opts.background ?? 'obsidian'
  const tone: Tone = bg === 'obsidian' || bg === 'near-black' || bg === 'charcoal'
    ? 'ivory'
    : 'obsidian'
  const cards: WidgetSpec[] = []
  if (opts.email) {
    cards.push(
      channelCard({
        label: 'Email',
        value: opts.email.value,
        description: opts.email.description,
        href: opts.email.href,
        icon: 'mail',
        tone,
      }),
    )
  }
  if (opts.phone) {
    cards.push(
      channelCard({
        label: 'Phone',
        value: opts.phone.value,
        description: opts.phone.description,
        href: opts.phone.href,
        icon: 'phone',
        tone,
      }),
    )
  }
  if (opts.address) {
    cards.push(
      channelCard({
        label: 'Address',
        value: opts.address.value,
        description: opts.address.description,
        icon: 'map-pin',
        tone,
      }),
    )
  }
  if (opts.hours) {
    cards.push(
      channelCard({
        label: 'Hours',
        value: opts.hours.value,
        description: opts.hours.description,
        icon: 'clock',
        tone,
      }),
    )
  }
  return {
    kind: 'section',
    meta: { columns: cards.length, background: bg, padding: 'sm' },
    columns: cards.map((c) => col(c)),
  }
}

// ─── Image-bearing helpers ─────────────────────────────────────────
//
// Templates declare image SLOTS by stable string keys. Each helper
// produces a WidgetSpec whose `data` field holds every non-image
// schema value (ratio, overlay, etc.) and whose `_imageKeys` +
// `_imageAlts` siblings carry the unresolved keys.
//
// The install-time resolver (app/api/install/template/route.ts) reads
// `<INSTALL_ROOT>/template-media/<slug>/manifest.json`, copies bundled
// variants to UPLOADS_ROOT/variants/<fresh-uuid>-*, INSERTs the media
// row, and INJECTs the resulting MediaRef ({media_id, alt}) into the
// data field named by the _imageKeys map. Then _imageKeys and
// _imageAlts are stripped before parseAndSanitize fires.
//
// Authors write:
//   coverImage({ imageKey: 'hero-exterior', alt: 'Hotel facade at dusk' })
// and never see media_ids — those don't exist until install time.

function withImageKeys(
  widget: WidgetSpec,
  refs: Record<string, { imageKey: string; alt: string }>,
): WidgetSpec {
  const _imageKeys: Record<string, string> = {}
  const _imageAlts: Record<string, string> = {}
  for (const [field, ref] of Object.entries(refs)) {
    _imageKeys[field] = ref.imageKey
    _imageAlts[field] = ref.alt
  }
  return { ...widget, _imageKeys, _imageAlts }
}

/**
 * Full-bleed cover image (lx_cover_image). The image slot is named
 * 'image' in the schema. Use for editorial hero strips, marquee
 * page-toppers, and full-viewport-height immersive covers.
 */
export function coverImage(opts: {
  imageKey: string
  alt: string
  ratio?: '21:9' | '16:9' | '4:3' | '3:2' | '4:5' | 'auto'
  minHeight?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'screen'
  overlay?: 'none' | 'darken' | 'darken-strong' | 'gradient-bottom' | 'champagne'
  animation?: 'none' | 'fade-in' | 'parallax'
  /** Optional editorial overlay text — turns a pure-image cover into
   *  a hero with eyebrow + title + body + CTA painted over the
   *  photo. Pair with `overlay: 'darken'` or `'gradient-bottom'` for
   *  legibility on bright photos. */
  eyebrow?: string
  title?: string
  body?: string
  cta?: { label: string; href: string }
  overlayAlignment?:
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'center-left'
    | 'center'
    | 'center-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right'
  overlayTone?: 'ivory' | 'obsidian'
}): WidgetSpec {
  const data: Record<string, unknown> = {
    ratio: opts.ratio ?? '21:9',
    minHeight: opts.minHeight ?? 'lg',
    overlay: opts.overlay ?? 'none',
    animation: opts.animation ?? 'fade-in',
    eyebrow: opts.eyebrow ?? '',
    title: opts.title ?? '',
    body: opts.body ?? '',
    cta: opts.cta ?? null,
    overlayAlignment: opts.overlayAlignment ?? 'bottom-left',
    overlayTone: opts.overlayTone ?? 'ivory',
  }
  return withImageKeys(
    { kind: 'widget', blockType: 'lx_cover_image', data },
    { image: { imageKey: opts.imageKey, alt: opts.alt } },
  )
}

/**
 * Editorial figure (lx_figure). Single photo with optional caption,
 * editorial aspect-ratio set, sharp corners. Use for inline body
 * imagery (story-page chapter photos, gallery-style detail shots).
 */
export function figure(opts: {
  imageKey: string
  alt: string
  ratio?: '21:9' | '16:9' | '4:5' | '1:1'
  fit?: 'cover' | 'contain'
  caption?: string
  goldOverlay?: boolean
  corners?: 'sharp' | 'soft'
  animation?: 'none' | 'fade-in' | 'slide-up' | 'parallax'
}): WidgetSpec {
  const data: Record<string, unknown> = {
    ratio: opts.ratio ?? '16:9',
    fit: opts.fit ?? 'cover',
    goldOverlay: opts.goldOverlay ?? false,
    corners: opts.corners ?? 'sharp',
    animation: opts.animation ?? 'fade-in',
  }
  if (opts.caption) data.caption = opts.caption
  return withImageKeys(
    { kind: 'widget', blockType: 'lx_figure', data },
    { image: { imageKey: opts.imageKey, alt: opts.alt } },
  )
}

/**
 * Staggered image pair (lx_image_pair). Two photos in the signature
 * "lifted" composition — one lifts above the column baseline, the
 * other tucks underneath with horizontal overlap. Both images
 * required (the schema has no half-empty state).
 */
export function imagePair(opts: {
  leftImageKey: string
  leftAlt: string
  rightImageKey: string
  rightAlt: string
  layout?: 'lift-left' | 'lift-right'
  overlap?: 'sm' | 'md' | 'lg'
  ratio?: '3:4' | '4:5' | '1:1'
  animation?: 'none' | 'fade-in' | 'slide-up'
}): WidgetSpec {
  return withImageKeys(
    {
      kind: 'widget',
      blockType: 'lx_image_pair',
      data: {
        layout: opts.layout ?? 'lift-left',
        overlap: opts.overlap ?? 'md',
        ratio: opts.ratio ?? '4:5',
        animation: opts.animation ?? 'fade-in',
      },
    },
    {
      leftImage: { imageKey: opts.leftImageKey, alt: opts.leftAlt },
      rightImage: { imageKey: opts.rightImageKey, alt: opts.rightAlt },
    },
  )
}

/**
 * Composite: hero with a full-bleed background photo + eyebrow,
 * heading, body, and optional CTAs in a text section immediately
 * below. Returns TWO sections — caller spreads them via `...`:
 *
 *   ...heroWithImage({ imageKey: 'hero', alt: '...', title: '...' }),
 *
 * The image and text are intentionally separate sections (vs. a
 * single overlaid block) so the operator can edit the photo and the
 * copy independently through the admin UI, and so the cover image
 * block stays a single-responsibility primitive.
 */
/**
 * Cover-image hero in a single flush section. Combines a full-bleed
 * photo + editorial text overlay (eyebrow / title / body / CTA) in
 * one widget, anchored to the section's TOP with zero vertical
 * padding so the photo sits flush against the site header.
 *
 * Replaces the older `coverImage(...) + hero(...)` two-section pattern
 * the templates shipped through 0.1.42 — that pair painted a 32–40px
 * dead band of section background between the header and the photo,
 * and left the photo without any text overlay. Templates from 0.1.43
 * onward use this helper for their first-impression cover.
 */
export function heroCover(opts: {
  imageKey: string
  alt: string
  background?: SectionBackground
  ratio?: '21:9' | '16:9' | '4:3' | '3:2' | '4:5' | 'auto'
  minHeight?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'screen'
  overlay?: 'none' | 'darken' | 'darken-strong' | 'gradient-bottom' | 'champagne'
  animation?: 'none' | 'fade-in' | 'parallax'
  eyebrow?: string
  title?: string
  body?: string
  cta?: { label: string; href: string }
  overlayAlignment?:
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'center-left'
    | 'center'
    | 'center-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right'
  overlayTone?: 'ivory' | 'obsidian'
}): SectionSpec {
  return oneCol(
    opts.background ?? 'obsidian',
    'none',
    coverImage({
      imageKey: opts.imageKey,
      alt: opts.alt,
      ratio: opts.ratio ?? '21:9',
      minHeight: opts.minHeight ?? 'lg',
      // Default to gradient-bottom — gives the bottom-left overlay
      // block enough contrast on any photo without darkening the
      // whole image flat.
      overlay: opts.overlay ?? 'gradient-bottom',
      animation: opts.animation ?? 'fade-in',
      eyebrow: opts.eyebrow,
      title: opts.title,
      body: opts.body,
      cta: opts.cta,
      overlayAlignment: opts.overlayAlignment ?? 'bottom-left',
      overlayTone: opts.overlayTone ?? 'ivory',
    }),
  )
}

export function heroWithImage(opts: {
  imageKey: string
  alt: string
  ratio?: '21:9' | '16:9' | '4:3' | '3:2' | '4:5'
  minHeight?: 'sm' | 'md' | 'lg' | 'xl' | 'screen'
  overlay?: 'none' | 'darken' | 'darken-strong' | 'gradient-bottom' | 'champagne'
  background?: SectionBackground
  eyebrow?: string
  title: string
  body?: string
  cta?: { label: string; href: string }
  secondaryCta?: { label: string; href: string }
  tone?: Tone
}): SectionSpec[] {
  const bg = opts.background ?? 'obsidian'
  const tone = opts.tone ?? (bg === 'obsidian' || bg === 'near-black' || bg === 'charcoal' ? 'ivory' : 'obsidian')

  const imageSection = oneCol(
    bg,
    'sm',
    coverImage({
      imageKey: opts.imageKey,
      alt: opts.alt,
      ratio: opts.ratio ?? '21:9',
      minHeight: opts.minHeight ?? 'lg',
      overlay: opts.overlay ?? 'none',
      animation: 'fade-in',
    }),
  )

  const textWidgets: WidgetSpec[] = []
  if (opts.eyebrow) textWidgets.push(eyebrow(opts.eyebrow, { tone: 'champagne' }))
  textWidgets.push(
    heading(opts.title, {
      level: 'h1',
      size: 'display-2xl',
      tone,
      animation: 'slide-up',
      marginTop: opts.eyebrow ? 'sm' : undefined,
    }),
  )
  if (opts.body) {
    textWidgets.push(text(opts.body, { size: 'body-lg', tone, marginTop: 'md' }))
  }
  if (opts.cta) {
    textWidgets.push(
      action(opts.cta.label, opts.cta.href, {
        size: 'lg',
        variant: 'primary-gold',
        marginTop: 'md',
      }),
    )
    if (opts.secondaryCta) {
      textWidgets.push(
        action(opts.secondaryCta.label, opts.secondaryCta.href, {
          size: 'lg',
          variant: 'ghost',
          marginTop: 'sm',
        }),
      )
    }
  }
  const textSection = oneCol(bg, 'md', ...textWidgets)
  return [imageSection, textSection]
}

/**
 * Image + text two-column section. One column holds an editorial
 * lx_figure, the other a column of standard text widgets. Caller
 * supplies the text-side widgets array directly — keeps the helper
 * agnostic to whether the text side carries eyebrow + heading,
 * just text, a quote, etc.
 *
 *   imageWithText({
 *     imageKey: 'spa-treatment-room',
 *     alt: '...',
 *     side: 'left',
 *     text: [eyebrow('...'), heading('...'), text('...')],
 *   })
 */
export function imageWithText(opts: {
  imageKey: string
  alt: string
  side?: 'left' | 'right'
  background?: SectionBackground
  padding?: SectionPadding
  ratio?: '21:9' | '16:9' | '4:5' | '1:1'
  text: WidgetSpec[]
}): SectionSpec {
  const bg = opts.background ?? 'ivory'
  const padding = opts.padding ?? 'lg'
  const fig = figure({
    imageKey: opts.imageKey,
    alt: opts.alt,
    ratio: opts.ratio ?? '4:5',
    animation: 'fade-in',
  })
  return opts.side === 'right'
    ? twoCols(bg, padding, opts.text, [fig])
    : twoCols(bg, padding, [fig], opts.text)
}

/**
 * Three-column row of image cards. Each card = a figure above a small
 * heading + body. For room categories, project tiles, service
 * thumbnails, agent grids, sample-dish thumbnails. The image+text
 * combo lives inside a single column; the section meta is columns=3.
 *
 * Cards beyond 3 are split across multiple rows. Each row is a
 * separate section so the operator can re-arrange rows in the admin.
 */
export function imageCardsRow(opts: {
  background?: SectionBackground
  ratio?: '4:5' | '1:1' | '16:9' | '21:9'
  sectionTitle?: string
  sectionBody?: string
  sectionTone?: Tone
  cards: Array<{
    imageKey: string
    alt: string
    kicker?: string
    title: string
    body?: string
    cta?: { label: string; href: string }
  }>
}): SectionSpec[] {
  const bg = opts.background ?? 'ivory'
  const tone: Tone = bg === 'obsidian' || bg === 'near-black' || bg === 'charcoal'
    ? 'ivory'
    : 'obsidian'
  const ratio = opts.ratio ?? '4:5'
  const sections: SectionSpec[] = []
  if (opts.sectionTitle || opts.sectionBody) {
    const intro: WidgetSpec[] = []
    if (opts.sectionTitle) {
      intro.push(
        heading(opts.sectionTitle, {
          level: 'h2',
          size: 'display-md',
          tone: opts.sectionTone ?? tone,
        }),
      )
    }
    if (opts.sectionBody) {
      intro.push(
        text(opts.sectionBody, {
          tone: opts.sectionTone ?? tone,
          marginTop: 'sm',
        }),
      )
    }
    sections.push(oneCol(bg, 'md', ...intro))
  }
  const cards = opts.cards
  for (let i = 0; i < cards.length; i += 3) {
    const slice = cards.slice(i, i + 3)
    const cols: ColumnSpec[] = slice.map((c) => {
      const widgets: WidgetSpec[] = [
        figure({ imageKey: c.imageKey, alt: c.alt, ratio, animation: 'fade-in' }),
      ]
      if (c.kicker) widgets.push(eyebrow(c.kicker, { tone: 'champagne' }))
      widgets.push(
        heading(c.title, {
          level: 'h3',
          size: 'display-sm',
          tone,
          marginTop: c.kicker ? 'xs' : 'sm',
        }),
      )
      if (c.body) {
        widgets.push(text(c.body, { tone, maxWidth: 'wide', marginTop: 'xs' }))
      }
      if (c.cta) {
        widgets.push(
          action(c.cta.label, c.cta.href, {
            variant: 'link-arrow',
            marginTop: 'sm',
          }),
        )
      }
      return col(...widgets)
    })
    // Pad to a multiple of 3 so the grid stays even.
    while (cols.length < 3) cols.push(col(spacer('section-xs')))
    sections.push({
      kind: 'section',
      meta: { columns: 3, background: bg, padding: 'md' },
      columns: cols,
    })
  }
  return sections
}
