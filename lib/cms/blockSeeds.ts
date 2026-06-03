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
  Image as ImageIcon,
  Heading as HeadingIcon,
  Minus,
  Box,
  ChevronsUpDown,
  ListChecks,
  LayoutPanelTop,
  Share2,
  MessageSquareQuote,
  PlayCircle,
  Mail,
  CaseSensitive,
  // ─── Luxury redesign icons ──────────────────────────────────────
  ArrowUpRight,
  ImagePlus,
  Image as CoverIcon,
  Images,
  LayoutGrid,
  MapPin,
  StretchVertical,
  // Composite-widget icons.
  PhoneCall,
  TrendingUp,
  Quote as QuoteIcon2,
  // ─── Elementor-parity block icons ───────────────────────────────
  GalleryHorizontal,
  MessagesSquare,
  Star,
  BadgeDollarSign,
  ListOrdered,
  ThumbsUp,
  Footprints,
  Sparkles,
  Timer,
  SquareStack,
  Target,
  Gauge,
  ListTree,
  Anchor,
  Share,
  Newspaper,
  Pilcrow,
  Code as CodeIcon,
  MonitorPlay,
  Megaphone,
  Columns2,
  Table as TableIcon,
  GitCommitVertical,
  ToggleRight,
} from 'lucide-react'

// Types that are seed-creatable from a picker WITHOUT a MediaPicker
// round-trip. Image is a special case — it's listed in the PICTURE
// entry below because every picker surfaces it as an option, but the
// picker calls MediaPicker first then POSTs with the chosen media_id
// (the image-block Zod schema requires a positive media_id, so a
// seed payload can't include it).
export type SeedBlockType =
  // Fixed-slot widget — kept palette-visible for non-contact pages.
  | 'contact_form'
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
  // ─── Luxury 2.0 — legacy-overhaul release ───────────────────────
  | 'lx_testimonial'
  | 'lx_video'
  | 'lx_accordion'
  | 'lx_tabs'
  | 'lx_icon_list'
  | 'lx_icon_box'
  | 'lx_divider'
  | 'lx_social_icons'
  | 'lx_cta_banner'
  | 'lx_gallery'
  | 'lx_featured_projects'
  // ─── Elementor-parity blocks ────────────────────────────────────
  | 'lx_carousel'
  | 'lx_testimonial_carousel'
  | 'lx_star_rating'
  | 'lx_pricing_table'
  | 'lx_pricing_list'
  | 'lx_reviews'
  | 'lx_progress_tracker'
  | 'lx_animated_headline'
  | 'lx_countdown'
  | 'lx_flip_box'
  | 'lx_hotspot'
  | 'lx_progress'
  | 'lx_menu_anchor'
  | 'lx_toc'
  | 'lx_share'
  | 'lx_posts'
  | 'lx_richtext'
  | 'lx_embed'
  | 'lx_code'
  | 'lx_marquee'
  | 'lx_before_after'
  | 'lx_comparison_table'
  | 'lx_timeline'

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

// ─── Widget-picker categories ───────────────────────────────────────
// The palette groups widgets into a small set of operator-facing
// categories (Elementor/Webflow-parity) so ~45 widgets don't read as
// one undifferentiated wall. The picker renders these groups in the
// order below when the search box is empty; a non-empty query collapses
// to the flat ranked list (a filtered search shouldn't re-impose
// category headers). Every SeedBlockType maps to exactly one category
// via CATEGORY_BY_TYPE — a missing key would fail typecheck (the map is
// Record<SeedBlockType, BlockCategory>), so adding a block forces a
// category choice.
export type BlockCategory =
  | 'text'
  | 'media'
  | 'layout'
  | 'content'
  | 'social'
  | 'marketing'
  | 'embed'
  | 'dynamic'

export const BLOCK_CATEGORIES: ReadonlyArray<{ key: BlockCategory; label: string }> = [
  { key: 'text', label: 'Text' },
  { key: 'media', label: 'Media' },
  { key: 'layout', label: 'Layout' },
  { key: 'content', label: 'Content' },
  { key: 'social', label: 'Social proof' },
  { key: 'marketing', label: 'Marketing & pricing' },
  { key: 'embed', label: 'Embed & forms' },
  { key: 'dynamic', label: 'Dynamic' },
]

export const CATEGORY_BY_TYPE: Record<SeedBlockType, BlockCategory> = {
  // Text
  lx_heading: 'text',
  lx_text: 'text',
  lx_richtext: 'text',
  lx_eyebrow: 'text',
  lx_quote: 'text',
  lx_animated_headline: 'text',
  // Media
  lx_figure: 'media',
  lx_cover_image: 'media',
  lx_image_pair: 'media',
  lx_gallery: 'media',
  lx_carousel: 'media',
  lx_video: 'media',
  lx_before_after: 'media',
  lx_hotspot: 'media',
  lx_marquee: 'media',
  // Layout
  lx_divider: 'layout',
  lx_space: 'layout',
  lx_menu_anchor: 'layout',
  lx_toc: 'layout',
  // Content
  lx_accordion: 'content',
  lx_tabs: 'content',
  lx_icon_list: 'content',
  lx_icon_box: 'content',
  lx_stat: 'content',
  lx_progress: 'content',
  lx_progress_tracker: 'content',
  lx_timeline: 'content',
  lx_comparison_table: 'content',
  lx_flip_box: 'content',
  lx_countdown: 'content',
  // Social proof
  lx_testimonial: 'social',
  lx_testimonial_carousel: 'social',
  lx_reviews: 'social',
  lx_star_rating: 'social',
  // Marketing & pricing
  lx_action: 'marketing',
  lx_cta_banner: 'marketing',
  lx_channel_card: 'marketing',
  lx_share: 'marketing',
  lx_social_icons: 'marketing',
  lx_pricing_table: 'marketing',
  lx_pricing_list: 'marketing',
  // Embed & forms
  lx_map: 'embed',
  lx_embed: 'embed',
  lx_code: 'embed',
  contact_form: 'embed',
  // Dynamic
  lx_featured_projects: 'dynamic',
  lx_posts: 'dynamic',
}

/** The category for a palette entry. Falls back by block type; the
 *  `lx_toggle` alias (type lx_accordion) lands in Content alongside it. */
export function categoryForEntry(entry: SeedEntry): BlockCategory {
  return CATEGORY_BY_TYPE[entry.type]
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
  // Every entry is an lx_* block (plus contact_form); the legacy widget
  // family was purged, so the palette is 100% luxury primitives.
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
    type: 'lx_richtext',
    label: 'Rich text',
    description:
      'Long-form markdown — headings, lists, quotes, code, images. The post-body block.',
    icon: Pilcrow,
    aliases: ['markdown', 'md', 'article', 'post body', 'long form'],
    keywords: ['blog', 'body', 'prose', 'editorial', 'writeup'],
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

  // ─── Luxury 2.0 ─────────────────────────────────────────────────
  // The 6 new composites added in the legacy-overhaul release. Each
  // replaces a pre-luxury widget that's now hidden from the palette.
  {
    type: 'lx_testimonial',
    label: 'Testimonial',
    description: 'Portrait + pull-quote + attribution — the editorial cousin of Quote.',
    icon: MessageSquareQuote,
    aliases: ['review', 'kudos', 'praise'],
    keywords: ['customer story', 'social proof', 'endorsement', 'press'],
  },
  {
    type: 'lx_video',
    label: 'Video',
    description: 'YouTube / Vimeo embed in a cinematic aspect-ratio frame.',
    icon: PlayCircle,
    aliases: ['youtube', 'vimeo', 'embed'],
    keywords: ['film', 'reel', 'walkthrough', 'demo'],
  },
  {
    type: 'lx_accordion',
    label: 'Accordion',
    description: 'FAQ with smooth open/close motion — or a permanent list.',
    icon: ChevronsUpDown,
    aliases: ['faq', 'expander', 'collapsible'],
    keywords: ['questions', 'answers', 'how it works', 'help'],
  },
  {
    type: 'lx_tabs',
    label: 'Tabs',
    description: 'Tabbed sections for product or feature comparisons.',
    icon: LayoutPanelTop,
    aliases: ['tabbed', 'tab group'],
    keywords: ['compare', 'switch', 'select', 'product'],
  },
  {
    type: 'lx_icon_list',
    label: 'Icon list',
    description: 'Vertical or grid feature list — icon + headline + body.',
    icon: ListChecks,
    aliases: ['feature list', 'benefits', 'checklist'],
    keywords: ['features', 'value props', 'what you get'],
  },
  {
    type: 'lx_icon_box',
    label: 'Icon box',
    description: 'Icon + headline + body card with optional link.',
    icon: Box,
    aliases: ['feature card', 'value card', 'tile'],
    keywords: ['feature', 'card', 'highlight'],
  },
  {
    type: 'lx_divider',
    label: 'Divider',
    description: 'Hairline rule — solid, dashed, dotted, or fleuron break.',
    icon: Minus,
    aliases: ['hr', 'rule', 'separator', 'line'],
    keywords: ['break', 'section', 'fleuron'],
  },
  {
    type: 'lx_social_icons',
    label: 'Social icons',
    description: 'Row of brand icons — Instagram, LinkedIn, GitHub, etc.',
    icon: Share2,
    aliases: ['social', 'brands', 'follow'],
    keywords: ['instagram', 'linkedin', 'twitter', 'github', 'footer'],
  },
  {
    type: 'lx_cta_banner',
    label: 'CTA banner',
    description: 'Title + body + primary CTA + optional secondary action.',
    icon: MousePointerClick,
    aliases: ['call to action', 'cta', 'banner'],
    keywords: ['conversion', 'lead', 'sign up', 'closing'],
  },
  {
    type: 'lx_gallery',
    label: 'Gallery',
    description: 'Grid of editorial photos with optional hover captions.',
    icon: Images,
    aliases: ['photo grid', 'images', 'portfolio'],
    keywords: ['photos', 'showcase', 'work'],
  },
  {
    type: 'lx_featured_projects',
    label: 'Featured projects',
    description: 'Card grid of your Featured projects, pulled live (set Featured order in Projects).',
    icon: LayoutGrid,
    aliases: ['projects', 'portfolio', 'work grid', 'case studies'],
    keywords: ['projects', 'showcase', 'case studies', 'grid', 'featured'],
  },

  // ─── Elementor-parity blocks ────────────────────────────────────
  {
    type: 'lx_carousel',
    label: 'Carousel',
    description: 'Swipeable image slider — autoplay, loop, captions, links.',
    icon: GalleryHorizontal,
    aliases: ['slider', 'carousel', 'slideshow', 'slides'],
    keywords: ['swipe', 'gallery', 'rotator', 'embla'],
  },
  {
    type: 'lx_testimonial_carousel',
    label: 'Testimonial carousel',
    description: 'Rotating pull-quotes — one centered testimonial per slide.',
    icon: MessagesSquare,
    aliases: ['testimonials', 'reviews slider', 'quotes carousel'],
    keywords: ['social proof', 'rotating quotes', 'endorsements'],
  },
  {
    type: 'lx_star_rating',
    label: 'Star rating',
    description: 'Champagne star meter — supports half stars + a numeric value.',
    icon: Star,
    aliases: ['rating', 'stars', 'score'],
    keywords: ['review score', 'out of five', 'rate'],
  },
  {
    type: 'lx_pricing_table',
    label: 'Pricing table',
    description: 'A plan card — price, features, CTA, optional featured highlight.',
    icon: BadgeDollarSign,
    aliases: ['price table', 'plan', 'pricing card', 'tier'],
    keywords: ['pricing', 'plans', 'subscribe', 'cost'],
  },
  {
    type: 'lx_pricing_list',
    label: 'Price list',
    description: 'Menu-style rows — title, description, price with a dotted leader.',
    icon: ListOrdered,
    aliases: ['menu', 'price list', 'rate card'],
    keywords: ['menu', 'services', 'rates', 'pricing'],
  },
  {
    type: 'lx_reviews',
    label: 'Reviews',
    description: 'Card grid of customer reviews — stars, quote, author, avatar.',
    icon: ThumbsUp,
    aliases: ['reviews', 'ratings', 'feedback'],
    keywords: ['testimonials', 'social proof', 'stars'],
  },
  {
    type: 'lx_progress_tracker',
    label: 'Progress tracker',
    description: 'Stepper / timeline of steps — done, current, upcoming.',
    icon: Footprints,
    aliases: ['stepper', 'steps', 'process', 'tracker'],
    keywords: ['how it works', 'milestones', 'progress', 'wizard'],
  },
  {
    type: 'lx_animated_headline',
    label: 'Animated headline',
    description: 'Static text with rotating or typewriter words.',
    icon: Sparkles,
    aliases: ['rotating headline', 'typed text', 'typewriter'],
    keywords: ['animated text', 'rotating words', 'hero headline'],
  },
  {
    type: 'lx_countdown',
    label: 'Countdown',
    description: 'Ticking countdown to a target date and time.',
    icon: Timer,
    aliases: ['timer', 'countdown clock', 'deadline'],
    keywords: ['launch', 'sale ends', 'urgency', 'clock'],
  },
  {
    type: 'lx_flip_box',
    label: 'Flip box',
    description: 'A card that flips on hover or tap to reveal more.',
    icon: SquareStack,
    aliases: ['flip card', 'flipper', 'reveal card'],
    keywords: ['interactive card', 'hover flip', 'feature'],
  },
  {
    type: 'lx_hotspot',
    label: 'Hotspot',
    description: 'An image with clickable marker tooltips.',
    icon: Target,
    aliases: ['hotspots', 'image markers', 'pins'],
    keywords: ['interactive image', 'tour', 'annotations'],
  },
  {
    type: 'lx_progress',
    label: 'Progress bars',
    description: 'Labeled skill / progress meters that fill on scroll.',
    icon: Gauge,
    aliases: ['progress bar', 'skill bars', 'meters'],
    keywords: ['skills', 'stats', 'percentage', 'bars'],
  },
  {
    type: 'lx_toc',
    label: 'Table of contents',
    description: 'Jump links to anchored sections on the page.',
    icon: ListTree,
    aliases: ['toc', 'contents', 'on this page', 'jump links'],
    keywords: ['navigation', 'index', 'outline', 'anchors'],
  },
  {
    type: 'lx_menu_anchor',
    label: 'Menu anchor',
    description: 'Invisible jump target for in-page links.',
    icon: Anchor,
    aliases: ['anchor', 'jump target', 'bookmark'],
    keywords: ['scroll to', 'in-page link', 'section id'],
  },
  {
    type: 'lx_share',
    label: 'Share buttons',
    description: 'Share this page to X, LinkedIn, Facebook, email, or copy link.',
    icon: Share,
    aliases: ['share', 'social share', 'share this'],
    keywords: ['share', 'tweet', 'copy link', 'social'],
  },
  {
    type: 'lx_posts',
    label: 'Posts',
    description: 'Auto-grid of your latest published blog posts.',
    icon: Newspaper,
    aliases: ['blog posts', 'recent posts', 'latest articles', 'loop grid'],
    keywords: ['blog', 'news', 'articles', 'journal', 'feed'],
  },
  {
    type: 'lx_embed',
    label: 'Embed',
    description: 'Embed YouTube, Vimeo, Spotify, CodePen, SoundCloud, or CodeSandbox.',
    icon: MonitorPlay,
    aliases: ['embed', 'iframe', 'oembed', 'youtube', 'spotify'],
    keywords: ['video', 'audio', 'codepen', 'embed code', 'external'],
  },
  {
    type: 'lx_code',
    label: 'Code',
    description: 'Syntax-highlighted code block with optional line numbers.',
    icon: CodeIcon,
    aliases: ['code', 'snippet', 'syntax', 'highlight'],
    keywords: ['code block', 'pre', 'monospace', 'developer'],
  },
  {
    type: 'lx_marquee',
    label: 'Marquee',
    description: 'Scrolling text or logo strip — a seamless ticker.',
    icon: Megaphone,
    aliases: ['ticker', 'marquee', 'logo strip', 'scroller'],
    keywords: ['scrolling', 'logos', 'trusted by', 'banner'],
  },
  {
    type: 'lx_before_after',
    label: 'Before / after',
    description: 'Drag-to-compare image slider.',
    icon: Columns2,
    aliases: ['comparison slider', 'before after', 'image compare'],
    keywords: ['slider', 'reveal', 'compare images', 'renovation'],
  },
  {
    type: 'lx_comparison_table',
    label: 'Comparison table',
    description: 'Feature matrix comparing up to four plans.',
    icon: TableIcon,
    aliases: ['feature matrix', 'compare plans', 'comparison'],
    keywords: ['pricing comparison', 'feature table', 'plans'],
  },
  {
    type: 'lx_timeline',
    label: 'Timeline',
    description: 'Dated vertical sequence of milestones.',
    icon: GitCommitVertical,
    aliases: ['timeline', 'history', 'milestones', 'roadmap'],
    keywords: ['history', 'journey', 'process', 'events'],
  },
  // lx_toggle — NOT a distinct block type. A single-item accordion is
  // exactly a toggle, so this palette entry seeds lx_accordion with one
  // item via the `data` override (the seed test allows shared types;
  // the label must be unique).
  {
    type: 'lx_accordion',
    label: 'Toggle',
    description: 'A single show/hide panel — a one-item accordion.',
    icon: ToggleRight,
    data: {
      items: [
        {
          title: 'Toggle title',
          body_richtext: '<p>Hidden content the visitor expands on click.</p>',
        },
      ],
      variant: 'accordion',
    },
    aliases: ['toggle', 'show hide', 'collapsible', 'expander'],
    keywords: ['reveal', 'expand', 'spoiler', 'details'],
  },

  // ─── Fixed-slot widget — not strictly in the lx_ family but kept in
  // the palette because it's the only operator-pickable form widget
  // and the contact-page renderer expects exactly one instance.
  {
    type: 'contact_form',
    label: 'Contact form',
    description: 'Name + email + phone + message — POSTs to /api/leads/contact.',
    icon: Mail,
    aliases: ['form', 'lead', 'message'],
    keywords: ['enquiry', 'inquiry', 'reach', 'get in touch'],
  },
]

export const SEED_DATA: Record<SeedBlockType, Record<string, unknown>> = {
  // contact_form — fixed-slot widget on the contact page; surfaces in
  // the palette so operators can drop a form on other pages too.
  // Minimum required is heading + submit_label; intro/success_* stay
  // optional so a freshly-picked form renders with the renderer's
  // default success panel.
  contact_form: {
    heading: 'Send us a message',
    submit_label: 'Send message',
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
  // Default seed uses a generic Google Maps embed (Greenwich/Royal
  // Observatory, zoom 4 — neutral, recognisable, not associated with
  // any specific operator's market); operators replace it via the
  // EditDrawer immediately after picking the widget. The seed must
  // parse so the picker doesn't 422 on first save. The CI pin in
  // blockSeeds.test.ts round-trips this through parseBlockData.
  lx_map: {
    embedUrl:
      'https://maps.google.com/maps?q=Greenwich+Royal+Observatory&z=4&output=embed',
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

  // ─── Luxury 2.0 ─────────────────────────────────────────────────

  // lx_testimonial — quote + attribution required. attribution_title
  // and portrait optional. Operator-named person + title pair so the
  // first render reads as a real, complete testimonial (the portrait
  // slot stays empty so operators see the no-portrait composition as
  // the baseline; they can attach a portrait via the EditDrawer).
  lx_testimonial: {
    quote: 'They listened, then they delivered — exactly what we asked for.',
    attribution: 'Esther Loomis',
    attribution_title: 'Co-founder, Studio Verde',
  },

  // lx_video — url required by isValidVideoUrl. Default seed uses
  // YouTube's "Big Buck Bunny" public-domain short — the same neutral
  // reference video lx_map uses Greenwich for. Operator pastes their
  // own share URL via the EditDrawer; the seed must parse so the
  // picker doesn't 422 on first insert. The CI seed-roundtrip test
  // round-trips this through parseBlockData.
  lx_video: {
    url: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
  },

  // lx_accordion — items array .min(1). Default ships 3 sample FAQ
  // pairs so the widget reads as a complete FAQ on first insert.
  // body_richtext is plain prose; operator edits via the EditDrawer.
  lx_accordion: {
    items: [
      {
        title: 'How does it work?',
        body_richtext:
          '<p>Tell us about your project. We respond within one business day with a quote and a timeline.</p>',
      },
      {
        title: 'What does it cost?',
        body_richtext:
          '<p>Project-based pricing. Most engagements land between $4,000 and $14,000 depending on scope.</p>',
      },
      {
        title: 'How long does it take?',
        body_richtext:
          '<p>Six to ten weeks from kickoff to handover. Larger scopes are split into clearly-named phases.</p>',
      },
    ],
  },

  // lx_tabs — tabs array .min(2). Default ships 3 tabs labeled as a
  // generic feature comparison. Operator replaces via the EditDrawer.
  lx_tabs: {
    tabs: [
      { label: 'Overview', body_richtext: '<p>A short, plain description of the product.</p>' },
      { label: 'Pricing', body_richtext: '<p>Three plans — Free, Team, Enterprise.</p>' },
      { label: 'FAQ', body_richtext: '<p>Common questions and the straight answers.</p>' },
    ],
  },

  // lx_icon_list — items array .min(1). Default ships 3 generic
  // feature items so the widget reads as a complete list on insert.
  // Icon names are lucide kebab-case (validated by ICON_NAME_RE).
  lx_icon_list: {
    items: [
      { icon: 'sparkles', headline: 'Polished by hand', body: 'Every page is reviewed before it ships.' },
      { icon: 'gauge', headline: 'Built for speed', body: 'Sub-second loads on every viewport.' },
      { icon: 'shield-check', headline: 'Secure by default', body: 'Standards-grade defenses, out of the box.' },
    ],
  },

  // lx_icon_box — icon + headline required. Body and link optional.
  // Default seed reads as a feature card on a marketing page; the
  // operator replaces icon + headline + body inline.
  lx_icon_box: {
    icon: 'sparkles',
    headline: 'A feature worth highlighting',
    body: 'A short, considered sentence describing why this matters.',
  },

  // lx_divider — every field has a Zod default; empty object is the
  // happy-path. Default visual = champagne hairline solid, centered.
  lx_divider: {},

  // lx_social_icons — items array .min(1). Default seeds Instagram +
  // LinkedIn pointing at example.com so the widget renders complete on
  // first insert; operators replace the URLs via the EditDrawer.
  lx_social_icons: {
    items: [
      { platform: 'instagram', href: 'https://www.instagram.com/example' },
      { platform: 'linkedin', href: 'https://www.linkedin.com/in/example' },
    ],
  },

  // lx_cta_banner — title + primaryCta required. Default seed reads as
  // a closing landing-page banner. Operator replaces copy + hrefs.
  lx_cta_banner: {
    title: 'Ready to start?',
    body: 'Tell us about your project and we will get back to you within one business day.',
    primaryCta: { label: 'Get in touch', href: '/contact' },
  },

  // lx_gallery — images array .min(1). Default ships a single
  // placeholder media_id=1 entry (the system "missing image" seed
  // image). Operators replace via the MediaPicker. The CI seed-
  // roundtrip test round-trips this through parseBlockData.
  lx_gallery: {
    images: [{ media_id: 1, alt: '' }],
  },
  // lx_featured_projects — no per-block fields are required. The grid
  // auto-renders the projects marked Featured (Projects → Featured
  // order); columns/tone/animation fall to schema defaults. An empty
  // grid renders a hint until at least one project is Featured.
  lx_featured_projects: {},

  // ─── Elementor-parity seeds ─────────────────────────────────────
  // lx_carousel — one placeholder slide (media_id=1 system image); the
  // picker overrides with the operator's MediaPicker pick. All other
  // knobs (ratio/autoplay/loop/arrows/dots/tone) fall to Zod defaults.
  lx_carousel: { slides: [{ image: { media_id: 1, alt: '' } }] },
  // lx_testimonial_carousel — one sample testimonial so the first
  // render reads complete; operator edits via the drawer repeater.
  lx_testimonial_carousel: {
    items: [
      {
        quote: 'They listened, then they delivered — exactly what we asked for.',
        attribution: 'Esther Loomis',
        attribution_title: 'Co-founder, Studio Verde',
      },
    ],
  },
  // lx_star_rating — value is the only required field.
  lx_star_rating: { value: 4.5, showValue: true },
  // lx_pricing_table — planName + price + at least one feature required.
  lx_pricing_table: {
    planName: 'Professional',
    price: '$49',
    period: '/month',
    description: 'Everything a growing team needs.',
    features: ['Unlimited projects', 'Priority support', 'Advanced analytics'],
    ctaLabel: 'Get started',
    ctaHref: '/contact',
    featured: true,
  },
  // lx_pricing_list — at least one item (title + price).
  lx_pricing_list: {
    items: [
      { title: 'Brand strategy session', description: 'A focused 90-minute working session.', price: '$450' },
      { title: 'Identity system', description: 'Logo, palette, type, and usage guidelines.', price: '$3,200' },
      { title: 'Launch website', description: 'Design + build, ready to ship.', price: 'from $8,000' },
    ],
  },
  // lx_reviews — at least one review (author + rating + text).
  lx_reviews: {
    items: [
      { author: 'Marcus Reed', rating: 5, text: 'Best decision we made all year. The team is exceptional.', role: 'CEO, Northwind' },
      { author: 'Priya Nair', rating: 4.5, text: 'Thoughtful, fast, and genuinely a pleasure to work with.', role: 'Founder, Bloom' },
    ],
  },
  // lx_progress_tracker — at least one step.
  lx_progress_tracker: {
    steps: [
      { title: 'Discovery', description: 'We learn your goals and constraints.', state: 'done' },
      { title: 'Design', description: 'We craft and refine the direction.', state: 'current' },
      { title: 'Launch', description: 'We ship and hand over.', state: 'upcoming' },
    ],
  },
  // lx_animated_headline — prefix + at least one word.
  lx_animated_headline: {
    prefix: 'We design things that are',
    words: ['beautiful', 'fast', 'unforgettable'],
  },
  // lx_countdown — target ISO string is required. A neutral future date;
  // operator sets their own via the drawer.
  lx_countdown: { target: '2027-01-01T00:00' },
  // lx_flip_box — front + back headline required.
  lx_flip_box: {
    frontIcon: 'sparkles',
    frontHeadline: 'Hover to learn more',
    frontBody: 'A short teaser on the front face.',
    backHeadline: 'Here is the detail',
    backBody: 'The fuller story revealed on the flip.',
    backCtaLabel: 'Learn more',
    backCtaHref: '/contact',
  },
  // lx_hotspot — image + at least one marker. Placeholder media_id=1;
  // picker overrides with the operator's pick.
  lx_hotspot: {
    image: { media_id: 1, alt: '' },
    markers: [{ x: 50, y: 50, label: 'A point of interest', body: 'Describe what is here.' }],
  },
  // lx_progress — at least one bar.
  lx_progress: {
    items: [
      { label: 'Design', value: 92 },
      { label: 'Development', value: 85 },
      { label: 'Strategy', value: 78 },
    ],
  },
  // lx_menu_anchor — anchorId required.
  lx_menu_anchor: { anchorId: 'section-anchor' },
  // lx_toc — title optional, at least one link.
  lx_toc: {
    title: 'On this page',
    items: [
      { label: 'Overview', anchor: 'overview' },
      { label: 'Pricing', anchor: 'pricing' },
      { label: 'Contact', anchor: 'contact' },
    ],
  },
  // lx_share — all booleans default true; nothing required.
  lx_share: { label: 'Share' },
  // lx_posts — no required fields; the grid auto-renders the latest
  // published posts (limit/layout/columns fall to defaults).
  lx_posts: {},
  // lx_richtext — markdown can be empty (operator fills it via the
  // EditDrawer markdown field, or the migration seeds it from body_md).
  // tone/maxWidth/animation fall to schema defaults.
  lx_richtext: { markdown: '' },
  // lx_embed — embedUrl must pass isAllowedEmbedUrl; title required.
  // Neutral public-domain YouTube short (same reference lx_video uses).
  lx_embed: {
    embedUrl: 'https://www.youtube.com/watch?v=YE7VzlLtp-4',
    title: 'Embedded video',
  },
  // lx_code — code required.
  lx_code: {
    code: 'export function greet(name: string) {\n  return `Hello, ${name}!`\n}',
    language: 'ts',
    filename: 'greet.ts',
  },
  // lx_marquee — text mode; nothing strictly required (logos default []).
  lx_marquee: { mode: 'text', text: 'Trusted by teams everywhere' },
  // lx_before_after — both images required (placeholder media_id=1; the
  // picker overrides with the operator's two picks).
  lx_before_after: {
    before: { media_id: 1, alt: '' },
    after: { media_id: 1, alt: '' },
    beforeLabel: 'Before',
    afterLabel: 'After',
  },
  // lx_comparison_table — at least 2 columns + 1 row.
  lx_comparison_table: {
    columns: ['Starter', 'Pro', 'Enterprise'],
    rows: [
      { feature: 'Projects', c1: '3', c2: 'Unlimited', c3: 'Unlimited' },
      { feature: 'Priority support', c1: 'no', c2: 'yes', c3: 'yes' },
      { feature: 'Dedicated manager', c1: 'no', c2: 'no', c3: 'yes' },
    ],
    highlightColumn: 1,
  },
  // lx_timeline — at least one event (title required).
  lx_timeline: {
    events: [
      { date: '2021', title: 'Founded', body: 'The studio opens its doors.' },
      { date: '2023', title: 'First award', body: 'Recognised for design excellence.' },
      { date: '2025', title: 'Global', body: 'Serving clients on four continents.' },
    ],
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
// Luxury 2.0 — the legacy block family is gone. The palette gate
// stays as an export surface (callers still `.filter(isPaletteVisible)`)
// but the empty deny-list means every registered entry is visible.
// Future per-entry deprecation can flip individual `deprecated` flags
// on SeedEntry without re-introducing a type-string deny-list.
// ──────────────────────────────────────────────────────────────────

/** True if the given block type is a deprecated legacy type. Always
 *  false after the legacy purge — kept as an API surface so existing
 *  callers continue to compile. */
export function isLegacyBlockType(_type: string): boolean {
  return false
}

/** Every registered SeedEntry is palette-visible after the legacy
 *  purge. Kept as an API surface so call-sites can continue to
 *  `.filter(isPaletteVisible)` without churn. */
export function isPaletteVisible(_entry: SeedEntry): boolean {
  return true
}
