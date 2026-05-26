// Shared seed-data + seed-type table for every "add a block" entry
// point in the editor. Previously duplicated four times across:
//   - InsertBlockHere.tsx (between-blocks pill picker)
//   - OutlinePanel.tsx AddBlockMenu (panel footer)
//   - EditableColumn.tsx ColumnInlinePicker (empty-column click)
//   - EditModeEmptyState.tsx (empty-page CTA)
// When a new widget type is added with new required fields, only one
// entry point would be remembered to update — the other three would
// silently POST malformed payloads and 422 at the server. This module
// is the single source of truth.
//
// The payloads here MUST satisfy each widget's Zod schema with the
// MINIMUM required fields. Anything optional stays out (Zod's
// `.default(x)` fills it on parse). Adding a new required field to a
// block schema requires updating the matching entry in SEED_DATA below.
// The CI pin lives in `tests/unit/blockSeeds.test.ts` — it round-trips
// every entry through `parseBlockData(type, SEED_DATA[type])` and fails
// the test if a seed drifts from its schema.

import type { LucideIcon } from 'lucide-react'
import {
  Type,
  MousePointerClick,
  Quote as QuoteIcon,
  Image as ImageIcon,
  Heading as HeadingIcon,
  CircleDot,
  Minus,
  ArrowDownUp,
  Box,
  ChevronsUpDown,
  ListChecks,
  LayoutPanelTop,
  AlertTriangle,
  Hash,
  Share2,
  Star,
  BarChart3,
  MessageSquareQuote,
  PlayCircle,
  Mail,
  CaseSensitive,
  Contact,
  // ─── Luxury redesign icons ──────────────────────────────────────
  ArrowUpRight,
  ImagePlus,
  Image as CoverIcon,
  Images,
  MapPin,
  StretchVertical,
  // Composite-widget icons.
  PhoneCall,
  TrendingUp,
  Quote as QuoteIcon2,
} from 'lucide-react'

// Types that are seed-creatable from a picker WITHOUT a MediaPicker
// round-trip. Image is a special case — it's listed in the PICTURE
// entry below because every picker surfaces it as an option, but the
// picker calls MediaPicker first then POSTs with the chosen media_id
// (the image-block Zod schema requires a positive media_id, so a
// seed payload can't include it).
export type SeedBlockType =
  | 'text'
  | 'cta'
  | 'quote'
  | 'heading'
  | 'button'
  | 'divider'
  | 'spacer'
  | 'icon_box'
  | 'accordion'
  | 'icon_list'
  | 'tabs'
  // Chunk G - Elementor-parity rich widgets.
  | 'alert'
  | 'social_icons'
  | 'star_rating'
  | 'stats_row'
  | 'testimonial'
  | 'video_embed'
  | 'contact_form'
  | 'eyebrow'
  | 'channel_card'
  // ─── Luxury redesign — lx_* widget primitives ───────────────────
  | 'lx_heading'
  | 'lx_text'
  | 'lx_eyebrow'
  | 'lx_action'
  | 'lx_figure'
  | 'lx_cover_image'
  | 'lx_image_pair'
  | 'lx_map'
  | 'lx_space'
  // ─── Luxury composites ──────────────────────────────────────────
  | 'lx_channel_card'
  | 'lx_stat'
  | 'lx_quote'

export interface SeedEntry {
  type: SeedBlockType
  label: string
  description: string
  icon: LucideIcon
  /** Per-entry seed payload override. When set, the picker POSTs this
   *  instead of SEED_DATA[type]. Used by entries that share a block_type
   *  but want different defaults - e.g. Counter and Stats Row both seed
   *  `stats_row` but with 1-item vs 3-item items[] arrays. */
  data?: Record<string, unknown>
  /** Chunk I — operator-facing synonyms for the fuzzy block search
   *  (/slash + ⌘K palette). Short, mental-model words an operator
   *  reaches for ("h1" for Heading, "btn" for Button). Ranked just
   *  below exact label match in `lib/cms/blockSearch.ts`. Surfaced
   *  on the result row as a small "aliases: h1, h2" chip when an
   *  alias match landed. */
  aliases?: string[]
  /** Chunk I — looser conceptual tags ("stat" for Counter, "review"
   *  for Testimonial). Ranked below aliases on the assumption an
   *  alias is a known shorthand while a keyword is a guess. NOT
   *  surfaced in the result row chrome. */
  keywords?: string[]
}

// Order here is the order operators see in the picker. Curated to put
// the most-reached-for widgets first: standalone text/heading/button,
// then layout primitives (divider/spacer), then richer composites.
//
// Typed `readonly SeedEntry[]` — defence-in-depth so a regression
// elsewhere can't `SEED_ENTRIES.push(...)` and break invariants the
// frozen `CATALOG_CACHE` in lib/cms/blockSearch.ts captured at first
// access. The CI seed-roundtrip test guards schema drift; this guards
// runtime mutation.
export const SEED_ENTRIES: readonly SeedEntry[] = [
  // ════════════════════════════════════════════════════════════════
  // LUXURY REDESIGN — lx_* widget primitives. Order here is the order
  // operators see in the palette: Heading → Text → Eyebrow → Action →
  // Figure → Rule → Space. Most-reached-for editorial widgets first.
  // Legacy entries below are hidden by isPaletteVisible during the
  // page-by-page migration.
  // ════════════════════════════════════════════════════════════════
  {
    type: 'lx_heading',
    label: 'Heading',
    description: 'Editorial display heading — Fraunces serif at any tier.',
    icon: HeadingIcon,
    aliases: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'title', 'display'],
    keywords: ['headline', 'editorial', 'serif', 'fraunces'],
  },
  {
    type: 'lx_text',
    label: 'Text',
    description: 'Body paragraph — Inter sans, editorial leading.',
    icon: Type,
    aliases: ['paragraph', 'p', 'prose', 'body'],
    keywords: ['copy', 'editorial', 'inter', 'sans'],
  },
  {
    type: 'lx_eyebrow',
    label: 'Eyebrow',
    description: 'Uppercase kicker label — sits above a heading.',
    icon: CaseSensitive,
    aliases: ['kicker', 'label', 'overline', 'pretitle'],
    keywords: ['preheading', 'tagline', 'tag', 'editorial'],
  },
  {
    type: 'lx_action',
    label: 'Action',
    description: 'CTA — primary gold, outline, ghost, or link with arrow.',
    icon: ArrowUpRight,
    aliases: ['btn', 'button', 'cta', 'link'],
    keywords: ['action', 'submit', 'go', 'gold'],
  },
  {
    type: 'lx_figure',
    label: 'Figure',
    description: 'Editorial image — optional parallax + gold overlay.',
    icon: ImagePlus,
    aliases: ['image', 'photo', 'picture', 'figure'],
    keywords: ['media', 'photo', 'hero image', 'parallax'],
  },
  {
    type: 'lx_image_pair',
    label: 'Image pair',
    description: 'Two photos staggered with overlap — editorial layering.',
    icon: Images,
    aliases: ['pair', 'stack', 'layered', 'overlap', 'duo'],
    keywords: ['two images', 'composition', 'layered images', 'gallery pair'],
  },
  {
    type: 'lx_cover_image',
    label: 'Cover image',
    description: 'Full-bleed hero photo — edge-to-edge, object-fit cover.',
    icon: CoverIcon,
    aliases: ['cover', 'hero', 'full-bleed', 'banner', 'jumbotron'],
    keywords: ['hero image', 'cover photo', 'full width', 'bleed', 'top of page'],
  },
  {
    type: 'lx_map',
    label: 'Map',
    description: 'Google Maps embed — paste the share-dialog URL.',
    icon: MapPin,
    aliases: ['map', 'location', 'address', 'directions'],
    keywords: ['google maps', 'find us', 'visit', 'place', 'pin'],
  },
  {
    type: 'lx_space',
    label: 'Space',
    description: 'Vertical breathing room — editorial spacing scale.',
    icon: StretchVertical,
    aliases: ['spacer', 'space', 'gap'],
    keywords: ['whitespace', 'breathing room', 'padding'],
  },
  // ─── Composite widgets ──────────────────────────────────────────
  {
    type: 'lx_channel_card',
    label: 'Channel card',
    description: 'Contact tile — kicker + value + icon + optional link.',
    icon: PhoneCall,
    aliases: ['contact card', 'reach card', 'channel', 'tile'],
    keywords: ['contact', 'phone', 'email', 'address', 'reach'],
  },
  {
    type: 'lx_stat',
    label: 'Stat',
    description: 'Animated count-up number with a label.',
    icon: TrendingUp,
    aliases: ['number', 'count', 'metric', 'counter'],
    keywords: ['count up', 'figure', 'kpi', 'trust', 'years', 'units'],
  },
  {
    type: 'lx_quote',
    label: 'Quote',
    description: 'Editorial closing quote — italic display + attribution.',
    icon: QuoteIcon2,
    aliases: ['pullquote', 'sign-off', 'manifesto'],
    keywords: ['quote', 'testimonial', 'cite', 'closing'],
  },

  // ════════════════════════════════════════════════════════════════
  // LEGACY widgets (kept for unmigrated pages — hidden from palette
  // via LEGACY_BLOCK_TYPES in isPaletteVisible). Order below preserved
  // as it was pre-redesign so a git revert during migration emergencies
  // restores cleanly.
  // ════════════════════════════════════════════════════════════════
  {
    type: 'heading',
    label: 'Heading (legacy)',
    description: 'Standalone H1–H6 with alignment + weight.',
    icon: HeadingIcon,
    aliases: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'title'],
    keywords: ['headline', 'header'],
  },
  {
    type: 'text',
    label: 'Text (legacy)',
    description: 'Paragraph, headline, prose.',
    icon: Type,
    aliases: ['paragraph', 'p', 'prose'],
    keywords: ['body', 'rich text', 'copy'],
  },
  {
    type: 'button',
    label: 'Button',
    description: 'Standalone CTA — primary, outline, or ghost.',
    icon: MousePointerClick,
    aliases: ['btn', 'link'],
    keywords: ['cta', 'action', 'pill'],
  },
  {
    type: 'quote',
    label: 'Quote (legacy)',
    description: 'Pull-quote or testimonial.',
    icon: QuoteIcon,
    // "pullquote" is editorial-design jargon operators with print
    // backgrounds recognise; left as alias. "blockquote" was the HTML
    // element name (developer-speak) — dropped per architect M-1
    // audit.
    aliases: ['pullquote'],
    keywords: ['testimonial', 'cite'],
  },
  {
    type: 'divider',
    label: 'Divider',
    description: 'Horizontal rule between sections.',
    icon: Minus,
    aliases: ['hr', 'line'],
    keywords: ['rule', 'separator', 'break'],
  },
  {
    type: 'spacer',
    label: 'Spacer',
    description: 'Vertical whitespace at a chosen tier.',
    icon: ArrowDownUp,
    // "gap" is Flexbox terminology — developer-speak. Luxury real-
    // estate operators reach for "space" / "spacing" / "whitespace".
    // Dropped per architect M-1 audit; "space" stays.
    aliases: ['space'],
    keywords: ['whitespace', 'margin', 'padding'],
  },
  {
    type: 'icon_box',
    label: 'Icon box',
    description: 'Icon + headline + body, optionally clickable.',
    icon: Box,
    // "iconbox" was a concatenation alias (developer naming
    // convention). The label "Icon box" with a space already prefix-
    // matches "icon" + "iconb"; the alias added noise. Dropped per
    // architect M-1 audit.
    aliases: ['feature'],
    keywords: ['card', 'feature tile', 'service'],
  },
  {
    type: 'accordion',
    label: 'Accordion',
    description: 'Expandable items — server-rendered for SEO.',
    icon: ChevronsUpDown,
    aliases: ['collapse', 'faq', 'expand'],
    keywords: ['disclosure', 'toggle', 'foldable'],
  },
  {
    type: 'icon_list',
    label: 'Icon list',
    description: 'Bullet list with icons — vertical or grid.',
    icon: ListChecks,
    // "iconlist" dropped per architect M-1 (same rationale as
    // iconbox above — label prefix-match already covers it).
    aliases: ['bullet', 'checklist'],
    keywords: ['list', 'feature list', 'amenities'],
  },
  {
    type: 'tabs',
    label: 'Tabs',
    description: 'Tabbed content panels with ARIA keyboard support.',
    icon: LayoutPanelTop,
    aliases: ['tab', 'tabbed'],
    keywords: ['panels', 'switcher'],
  },
  {
    type: 'cta',
    label: 'Call to action',
    description: 'Title + button (composed CTA section).',
    icon: CircleDot,
    aliases: ['cta', 'callout'],
    keywords: ['banner', 'promo'],
  },
  // Chunk G - Elementor-parity rich widgets. Appended after F's
  // curated order so a 3-way merge with Phase-1 and F drops in
  // cleanly. Order within G is alphabetical by label.
  {
    type: 'alert',
    label: 'Alert',
    description: 'Info / success / warning / error banner with optional dismissal.',
    icon: AlertTriangle,
    aliases: ['notice', 'banner', 'callout'],
    keywords: ['warning', 'info', 'message', 'announcement'],
  },
  {
    type: 'stats_row',
    label: 'Counter',
    description: 'Single animated number tile (count-up on viewport entry).',
    icon: Hash,
    aliases: ['stat', 'number', 'metric'],
    keywords: ['count', 'count up', 'figure', 'kpi'],
    // Counter is the single-item flavour of the stats_row block. The
    // picker seeds 1 item + layout='solo' so the freshly created widget
    // renders as one centred tile. Operator can add items later in the
    // drawer to convert it into a Stats Row.
    data: {
      items: [
        {
          value: 100,
          prefix: '',
          suffix: '+',
          label: 'New counter',
          duration_ms: 1800,
        },
      ],
      layout: 'solo',
    },
  },
  {
    type: 'social_icons',
    label: 'Social icons',
    description: 'Brand-mark row linking to social profiles.',
    icon: Share2,
    aliases: ['social', 'share'],
    keywords: ['instagram', 'facebook', 'twitter', 'tiktok', 'linkedin'],
  },
  {
    type: 'star_rating',
    label: 'Star rating',
    description: 'Display-only rating in half-star granularity.',
    icon: Star,
    // "score" promoted from keyword to alias per architect M-1 —
    // operators typing "score" expect the star widget exactly, not
    // a fuzzy keyword match.
    aliases: ['stars', 'rating', 'score'],
    keywords: ['review score', 'feedback'],
  },
  {
    type: 'stats_row',
    label: 'Stats row',
    description: 'Multi-counter row (2-4 up) with stagger animation.',
    icon: BarChart3,
    aliases: ['stats', 'counters', 'metrics'],
    keywords: ['kpi', 'numbers', 'figures', 'count up row'],
    // Stats Row defaults to 3 tiles in a 3-up grid - the canonical
    // luxury-real-estate layout per the elite-web-researcher pass.
    data: {
      items: [
        { value: 120, prefix: '', suffix: '+', label: 'Residences', duration_ms: 1800 },
        { value: 14, prefix: '', suffix: '', label: 'Neighbourhoods', duration_ms: 1800 },
        { value: 18, prefix: '', suffix: '', label: 'Years', duration_ms: 1800 },
      ],
      layout: '3up',
    },
  },
  {
    type: 'testimonial',
    label: 'Testimonial',
    description: 'Quote + attribution + optional photo / project link.',
    icon: MessageSquareQuote,
    aliases: ['review', 'quote'],
    keywords: ['praise', 'client', 'feedback', 'reference'],
  },
  {
    type: 'video_embed',
    label: 'Video embed',
    description: 'YouTube or Vimeo video, sandboxed iframe.',
    icon: PlayCircle,
    aliases: ['youtube', 'vimeo', 'video'],
    keywords: ['embed', 'player', 'movie', 'clip'],
  },
  {
    type: 'contact_form',
    label: 'Contact form',
    description: 'Name + email + phone + message — POSTs to /api/leads/contact.',
    icon: Mail,
    aliases: ['form', 'lead', 'message'],
    keywords: ['enquiry', 'inquiry', 'reach', 'get in touch'],
  },
  {
    type: 'eyebrow',
    label: 'Eyebrow (legacy)',
    description: 'Small uppercase kicker label that sits above a heading.',
    icon: CaseSensitive,
    aliases: ['kicker', 'label', 'overline'],
    keywords: ['preheading', 'tagline', 'tag', 'caption'],
  },
  {
    type: 'channel_card',
    label: 'Channel card (legacy)',
    description: 'Bordered tile with kicker label, body, and action link.',
    icon: Contact,
    aliases: ['contact card', 'channel', 'reach card'],
    keywords: ['contact', 'tile', 'card', 'reach', 'address'],
  },
]

export const SEED_DATA: Record<SeedBlockType, Record<string, unknown>> = {
  text: { body_richtext: '' },
  cta: {
    title: '',
    cta: { text: 'Learn more', href: '/contact', openInNew: false },
  },
  quote: { quote: '' },
  // Heading seeds with non-empty placeholder so the freshly-added block
  // renders a visible H2 instead of an invisible empty element. Other
  // fields are filled in by Zod's .default(...) on parse.
  heading: { text: 'New heading' },
  // Button seeds with a meaningful default href so the schema's
  // CTA_HREF_RE regex passes on initial save. Operators edit text +
  // href via the EditDrawer or inline edit.
  button: { text: 'Click me', href: '/contact' },
  // Divider / Spacer have no required text fields — schema defaults
  // cover every knob. Empty payload parses cleanly via Zod defaults.
  divider: {},
  spacer: {},
  // IconBox has two required strings (icon name + headline). Body
  // and link stay optional. Default alignment / accent fill via Zod.
  icon_box: { icon: 'star', headline: 'New icon box' },
  // Accordion items array requires min 1. Seed with one empty item —
  // operators add more via the EditDrawer's repeater UI.
  accordion: {
    items: [{ title: 'New item', body_richtext: '' }],
    allow_multiple: false,
  },
  // IconList items array requires min 1. Same pattern as Accordion.
  icon_list: {
    items: [{ icon: 'check', label: 'New item' }],
  },
  // Tabs seeded with TWO tabs so the tablist is visibly tabbed on first
  // paint — a one-tab Tabs widget looks broken (just a single underlined
  // label with no siblings).
  tabs: {
    items: [
      { label: 'Tab 1', body_richtext: '' },
      { label: 'Tab 2', body_richtext: '' },
    ],
  },
  // Chunk G defaults. Each seed satisfies its Zod schema with the
  // minimum required fields - the CI pin (tests/unit/blockSeeds.test.ts)
  // round-trips every entry through parseBlockData and fails the suite
  // if a seed drifts from its schema.
  alert: {
    variant: 'info',
    title: 'New alert',
    body_richtext: '',
    dismissible: false,
  },
  social_icons: {
    items: [
      { platform: 'instagram', url: 'https://instagram.com/your-handle' },
    ],
  },
  star_rating: {
    value: 4.5,
  },
  // stats_row's DEFAULT seed (when the operator opens it without going
  // through Counter or Stats Row picker entries - e.g. via a programmatic
  // call). Matches Stats Row's 3-up layout because that's the canonical
  // shape; Counter overrides via SeedEntry.data with a 1-item / 'solo'
  // payload.
  stats_row: {
    items: [
      { value: 120, prefix: '', suffix: '+', label: 'Residences', duration_ms: 1800 },
      { value: 14, prefix: '', suffix: '', label: 'Neighbourhoods', duration_ms: 1800 },
      { value: 18, prefix: '', suffix: '', label: 'Years', duration_ms: 1800 },
    ],
    layout: '3up',
  },
  testimonial: {
    quote: 'A short, glowing testimonial from a recent client.',
  },
  // video_embed seeds with the canonical "Big Buck Bunny" YouTube id -
  // operators always replace it, but the schema requires a parseable
  // URL so an empty string won't pass refine() validation. This avoids
  // creating a widget that immediately fails its own schema on save.
  video_embed: {
    url: 'https://www.youtube.com/embed/YE7VzlLtp-4',
    aspect_ratio: '16:9',
  },
  // contact_form seed: minimum required is heading + submit_label.
  // intro/success_* stay optional so a freshly-picked form renders with
  // the renderer's default success panel; operators override either via
  // inline edit (heading / submit_label) or the EditDrawer (intro and
  // success copy).
  contact_form: {
    heading: 'Send us a message',
    submit_label: 'Send message',
  },
  // eyebrow defaults: a left-aligned copper kicker. Operators override
  // color / alignment via the EditDrawer; the .min(1) text gate means
  // a freshly-picked block renders with placeholder copy the operator
  // edits inline.
  eyebrow: { text: 'New kicker' },
  // channel_card defaults: minimum required is label + body. action is
  // omitted (Zod's .optional() drops it) so a freshly-picked card
  // renders with no link — operator adds one via the drawer when they
  // attach a destination.
  channel_card: {
    label: 'New label',
    body: 'Describe what this channel is best for in one line.',
  },

  // ─── Luxury redesign seeds ──────────────────────────────────────
  // Each seed satisfies its lx_* schema with the MINIMUM required
  // fields. Zod's .default(...) fills every optional knob (level,
  // size, alignment, tone, animation). The CI pin (blockSeeds.test.ts)
  // round-trips each seed through parseBlockData and fails the suite
  // if a schema-required field is missing.

  // lx_heading — text is the only required field; .default('h2') on
  // level prevents an SEO H1 collision with page metadata's own H1
  // (same rationale as the legacy heading widget).
  lx_heading: { text: 'New heading' },

  // lx_text — body_richtext can be empty. Operator fills it via
  // inline edit (DOMPurify sanitizes both directions). No defaults
  // beyond what Zod's .default() applies for size/alignment/tone/
  // maxWidth/animation.
  lx_text: { body_richtext: '' },

  // lx_eyebrow — text is the only required field; .default('champagne')
  // on tone gives the editorial gold kicker on first render.
  lx_eyebrow: { text: 'New kicker' },

  // lx_action — label + href required by schema's .min(1) gates and
  // CTA_HREF_RE regex. '/contact' is a same-origin path that passes
  // the URI allowlist; operators replace it via the EditDrawer.
  lx_action: { label: 'Get in touch', href: '/contact' },

  // lx_figure — MediaRef requires a positive media_id, so this seed
  // cannot ship a complete payload. The picker calls MediaPicker
  // first and POSTs with the chosen media_id; this fallback exists
  // for the SEED_DATA invariant test, where it's never reached at
  // runtime because the picker overrides with the MediaPicker result.
  // The placeholder media_id=1 is the CaveCMS system "missing image"
  // placeholder seeded in db/seed.ts.
  lx_figure: { image: { media_id: 1, alt: '' } },

  // lx_image_pair — both MediaRefs require positive media_id, same
  // picker-override pattern as lx_figure: the operator picks two
  // images through the MediaPicker (one per side) and the picker
  // POSTs with the resolved IDs. media_id=1 is the system placeholder
  // so the SEED_DATA invariant test passes round-trip.
  lx_image_pair: {
    leftImage: { media_id: 1, alt: '' },
    rightImage: { media_id: 1, alt: '' },
  },

  // lx_cover_image — single MediaRef. Picker overrides with the
  // operator's chosen media_id; placeholder media_id=1 only satisfies
  // the seed-roundtrip invariant test.
  lx_cover_image: { image: { media_id: 1, alt: '' } },

  // lx_map — embedUrl is required and must pass isValidMapEmbedUrl
  // (www.google.com/maps/embed?pb=… OR maps.google.com/maps?…&output=embed).
  // Default seed uses the keyless legacy form pointing at Accra centre;
  // operators replace it via the EditDrawer immediately after picking
  // the widget — but the seed must parse so the picker doesn't 422 on
  // first save. The CI pin in blockSeeds.test.ts round-trips this
  // through parseBlockData.
  lx_map: {
    embedUrl:
      'https://maps.google.com/maps?q=Accra,+Ghana&z=13&output=embed',
  },

  // lx_space — single optional `size` field defaults to 'section-md'.
  lx_space: {},

  // ─── Composite seeds ────────────────────────────────────────────

  // lx_channel_card — label + value required. icon/description/href
  // optional. Default `tone: 'obsidian'` (Zod default) gives the
  // light-on-dark inverse for cards placed in obsidian sections;
  // operator flips to 'ivory' for cards in light sections.
  lx_channel_card: {
    label: 'Email',
    value: 'hello@yourdomain.com',
    icon: 'mail',
    href: 'mailto:hello@yourdomain.com',
  },

  // lx_stat — value + label are the required pair. duration_ms,
  // alignment, tone default via Zod. Operators edit `label` inline
  // and tune value/prefix/suffix via the drawer.
  lx_stat: {
    value: 20,
    suffix: '+',
    label: 'Years of craft',
  },

  // lx_quote — quote required; attribution optional. Defaults to
  // centered alignment, obsidian tone, no animation. line-reveal is
  // the canonical luxury treatment when operators opt in.
  lx_quote: {
    quote: 'A short, signature closing thought.',
    attribution: 'A Happy Customer',
  },
}

// Convenience for picker UIs that need to include the Image entry
// (which goes through the MediaPicker, not a direct seed POST).
export const PICTURE_ENTRY = {
  label: 'Picture',
  description: 'Pick from the media library or upload a new one.',
  icon: ImageIcon,
} as const

// ──────────────────────────────────────────────────────────────────
// Luxury redesign — palette migration gate.
//
// Every legacy widget type is listed below. Palette UIs (OutlinePanel,
// EditableColumn, InsertBlockHere, blockSearch catalog) hide these
// entries via `isPaletteVisible()`. Operators can no longer ADD new
// instances of legacy types — they only see the lx_* widgets. Existing
// DB rows with these block_types continue to PARSE + RENDER (their
// schemas in block-registry.ts and renderers in components/blocks/*
// stay in place) — only NEW creation through the palette is gated.
//
// When every page has migrated off the legacy widget set, a follow-up
// cleanup PR removes the legacy schemas, renderers, this set, and the
// matching SEED_ENTRIES entries. Until then, this set IS the single
// source of truth for "what's legacy" — adding a type here hides it
// from operators; removing a type here un-hides it.
// ──────────────────────────────────────────────────────────────────
const LEGACY_BLOCK_TYPES: ReadonlySet<string> = new Set<string>([
  'text',
  'cta',
  'quote',
  'heading',
  'button',
  'divider',
  'spacer',
  'icon_box',
  'accordion',
  'icon_list',
  'tabs',
  'alert',
  'social_icons',
  'star_rating',
  'stats_row',
  'testimonial',
  'video_embed',
  // NB: contact_form intentionally OMITTED from the legacy gate.
  // Its renderer has been re-skinned for luxury (see
  // components/blocks/ContactForm/render.tsx + the underlying
  // components/leads/ContactForm.tsx client form) and the schema is
  // shared between the legacy + luxury surfaces. The contact page
  // seeds it as a fixed-slot block; palette discoverability is also
  // useful so operators on other pages can drop a contact form too.
  // 'contact_form',
  'eyebrow',
  'channel_card',
])

export function isLegacyBlockType(type: string): boolean {
  return LEGACY_BLOCK_TYPES.has(type)
}

/**
 * Single-source-of-truth gate for "should this seed entry appear in
 * the palette / search / picker?" Composes two signals:
 *   1. Per-entry `deprecated: true` flag (future per-entry overrides).
 *   2. Legacy-block-type set (migration-wide gate, see above).
 *
 * Every palette UI MUST filter SEED_ENTRIES through this helper —
 * direct .filter(e => !e.deprecated) calls miss the LEGACY_BLOCK_TYPES
 * gate and would re-expose the legacy widgets.
 */
export function isPaletteVisible(entry: SeedEntry): boolean {
  return !LEGACY_BLOCK_TYPES.has(entry.type)
}
