import 'server-only'
import type { BlockType } from './block-registry'
import { isValidMapEmbedUrl } from './block-registry'

// Pure mapper: a project's section rows → a list of CMS SECTIONS, each
// holding the ordered PRIMITIVE block widgets that compose it. Every
// element an operator should be able to edit is its own primitive block
// (lx_heading, lx_text, lx_eyebrow, lx_action, lx_figure, lx_gallery,
// lx_map, lx_stat, lx_icon_list, lx_testimonial, …) — no monolithic
// "project" wrapper blocks. The only project-specific blocks that
// survive are the two lead forms (lx_inquiry_form / lx_brochure_form),
// because a form is one irreducible widget.
//
// Shared by the projects→blocks backfill AND new-project creation so
// both produce identical trees. No DB access — the caller validates
// each widget through parseAndSanitize and inserts the section→column→
// widget rows.
//
// Every widget's data is built to PASS the real block schema (verified
// against block-registry.ts): required text is never empty, lx_action
// hrefs are /absolute#anchor paths (a bare #anchor fails CTA_HREF_RE),
// lx_stat.value is a number, lx_map is emitted only when the URL passes
// isValidMapEmbedUrl, amenity icons are normalised to a safe Lucide
// kebab name (or 'check'), and empty/optional content is SKIPPED rather
// than emitted as an invalid primitive.

export interface ProjectSectionInput {
  sectionKey: string
  data: unknown
}

export interface ProjectWidget {
  blockType: BlockType
  data: Record<string, unknown>
}

export interface ProjectColumn {
  /** Ordered primitive widgets in this column. */
  widgets: ProjectWidget[]
  /** Optional column-level meta — validated via ColumnMetaSchema by the
   *  caller when present. Most project sections are single-column and
   *  omit it; only the location band uses two columns (neighbourhood
   *  rail + map). */
  meta?: Record<string, unknown>
}

export interface ProjectSectionBuild {
  /** Host-section meta — a valid SectionMetaSchema input (columns /
   *  background / padding, plus optional backgroundImage + overlay for
   *  the hero photo). */
  meta: Record<string, unknown>
  /** One or more columns. A single-column section is `oneCol([...])`;
   *  the location band splits into two (content rail + map) when the
   *  project carries a valid map embed. */
  columns: ProjectColumn[]
}

// Single-column shorthand — the shape of every project section except
// the two-column location band.
function oneCol(widgets: ProjectWidget[]): ProjectColumn[] {
  return [{ widgets }]
}

export interface ProjectContextForTree {
  slug: string
  name: string
  status: string
  location: string | null
  brochurePdfId: number | null
}

interface MediaRefLike {
  media_id: number
  alt?: string
}

// ─── small helpers ──────────────────────────────────────────────────
const ICON_KEBAB_RE = /^[a-z][a-z0-9-]{0,59}$/

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}
function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function mediaRef(v: unknown): MediaRefLike | null {
  const o = asObject(v)
  const id = o.media_id
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
    return { media_id: id, alt: typeof o.alt === 'string' ? o.alt : '' }
  }
  return null
}
function clampPlain(s: string, max: number): string {
  // Strip any HTML tags, collapse whitespace, clamp — for lx_heading.text
  // (NOT a richtext field, rendered verbatim).
  const plain = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > max ? plain.slice(0, max).trim() : plain
}

// Format a price as currency with thousands separators — NEVER as a
// bare lx_stat count-up (a 6-digit price rendered as a giant count-up
// number reads as broken). Falls back to a comma-grouped number when
// the currency code isn't a valid ISO 4217 Intl input.
function formatCurrency(value: number, currency: string): string {
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(value)
    } catch {
      /* invalid currency for Intl → fall through to plain grouping */
    }
  }
  return value.toLocaleString('en-US')
}

function statusLabel(status: string): string {
  switch (status) {
    case 'coming_soon':
      return 'Coming soon'
    case 'under_construction':
      return 'Under construction'
    case 'selling':
      return 'Selling now'
    case 'sold_out':
      return 'Sold out'
    default:
      return ''
  }
}

// Friendly amenity icon text → a real Lucide kebab name lx_icon_list
// accepts. lx_icon_list's icon field is the STRICT kebab regex, and the
// renderer resolves to a real Lucide glyph — so an unknown free-text
// icon must fall back to a known-good name ('check') rather than 422 or
// render a blank. Covers the common residential/hospitality amenities;
// everything else → 'check'.
const AMENITY_ICON: Readonly<Record<string, string>> = {
  pool: 'waves',
  'swimming-pool': 'waves',
  water: 'waves',
  lake: 'waves',
  gym: 'dumbbell',
  fitness: 'dumbbell',
  'fitness-center': 'dumbbell',
  'fitness-centre': 'dumbbell',
  concierge: 'bell',
  reception: 'bell',
  security: 'shield-check',
  gated: 'shield-check',
  parking: 'car',
  garage: 'car',
  garden: 'trees',
  park: 'trees',
  landscaping: 'leaf',
  wifi: 'wifi',
  internet: 'wifi',
  restaurant: 'utensils-crossed',
  dining: 'utensils-crossed',
  cafe: 'coffee',
  bar: 'wine',
  cinema: 'film',
  theatre: 'film',
  pet: 'paw-print',
  'pet-friendly': 'paw-print',
  pets: 'paw-print',
  solar: 'sun',
  sun: 'sun',
  beach: 'palmtree',
  spa: 'sparkles',
  wellness: 'heart',
  'smart-home': 'cpu',
  smart: 'cpu',
  tech: 'cpu',
  power: 'zap',
  backup: 'zap',
  generator: 'zap',
  storage: 'warehouse',
  clubhouse: 'building-2',
  family: 'baby',
  kids: 'baby',
  laundry: 'droplets',
  star: 'star',
  premium: 'star',
  key: 'key',
  access: 'key',
  clock: 'clock',
  '24-7': 'clock',
}
function amenityIconName(raw: string): string {
  const kebab = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
  if (AMENITY_ICON[kebab]) return AMENITY_ICON[kebab]
  // A bare already-kebab token that matches the regex is allowed through
  // (it may resolve to a real Lucide icon); otherwise fall back.
  return ICON_KEBAB_RE.test(kebab) ? kebab : 'check'
}

// ─── per-section composition ────────────────────────────────────────
//
// Editorial design system applied across the project page. Three things
// give the page its premium rhythm; every section below follows them:
//
//  1. BACKGROUND CADENCE. Sections alternate light surfaces (ivory →
//     bone → cream) so consecutive bands never read as one flat slab,
//     with TWO dark feature bands that anchor the page: pricing lands on
//     obsidian (the commercial moment deserves gravity) and testimonials
//     on charcoal (a distinct dark so it doesn't twin the pricing band).
//     The hero is its own dark moment (photo + gradient, or solid
//     obsidian). Padding is generous throughout — `xl` (160px) for
//     content sections, `2xl` (192px) for the cinematic hero + the two
//     dark feature bands.
//
//  2. TONE CONTRAST IS LAW. A widget's `tone` is chosen against its
//     section background, never independently. On the dark bands
//     (obsidian/charcoal hero, pricing, testimonials) headings go
//     `ivory`, body `ivory`, eyebrows `champagne`; lx_stat uses `ivory`
//     (NOT champagne — champagne stats render an obsidian/70 LABEL that
//     vanishes on a dark surface, while the champagne glow halo behind
//     the ivory numeral still supplies the gold warmth). On light bands
//     headings/body go `obsidian`, eyebrows `champagne`, stats `obsidian`.
//
//  3. COMPOSED HEADERS + INTENTIONAL ALIGNMENT. Every section opens with
//     an eyebrow→heading pair carrying a tasteful entrance animation
//     (eyebrow fade-in, heading slide-up; line-reveal is reserved for
//     the hero h1 only, per house motion rules). Amenities, gallery,
//     floor plans, pricing, timeline and testimonials use CENTERED
//     editorial headers — the premium magazine register. Location is
//     deliberately LEFT-aligned so the address, POI list and map stack
//     against one consistent edge (fixing the old orphaned centered
//     address). No borders/hairlines separate anything — spacing, tone
//     and the champagne glow carry the structure.
//
// Helpers below (`header`, light/dark tone constants) keep each section
// terse while the rules above stay applied uniformly.

export function buildProjectSections(
  project: ProjectContextForTree,
  sections: ProjectSectionInput[],
): ProjectSectionBuild[] {
  const byKey = new Map<string, Record<string, unknown>>()
  for (const s of sections) byKey.set(s.sectionKey, asObject(s.data))
  const out: ProjectSectionBuild[] = []
  const slug = project.slug

  // Centered editorial eyebrow→heading pair — the premium section
  // opener used on every content band. Eyebrow fades in; the heading
  // slides up underneath it. `tone` is the section-contrasted heading
  // tone ('obsidian' on light bands, 'ivory' on the dark feature bands);
  // the eyebrow stays champagne (neutral gold, reads on both surfaces).
  function header(
    eyebrow: string,
    heading: string,
    tone: 'obsidian' | 'ivory',
    alignment: 'left' | 'center' = 'center',
  ): ProjectWidget[] {
    return [
      { blockType: 'lx_eyebrow', data: { text: eyebrow, tone: 'champagne', alignment, animation: 'fade-in' } },
      { blockType: 'lx_heading', data: { text: heading, level: 'h2', size: 'display-lg', alignment, tone, animation: 'slide-up' } },
    ]
  }

  // ── Hero ──────────────────────────────────────────────────────────
  // The page's opening moment. A banner photo becomes the section
  // background with a gradient-bottom overlay (heading sits in the
  // darkened lower third, legible); absent a photo it's a solid obsidian
  // band so the hero is ALWAYS a confident dark moment, never a pale
  // slab. Left-aligned editorial stack: champagne status badge → big
  // line-revealing h1 (the one place that signature motion belongs) →
  // ivory lead summary → gold CTA (+ outline brochure CTA).
  {
    const hero = byKey.get('hero') ?? {}
    const banner = mediaRef(hero.banner_image)
    const widgets: ProjectWidget[] = []
    const badge =
      (nonEmpty(hero.status_label) ? str(hero.status_label).trim() : '') ||
      statusLabel(project.status)
    if (nonEmpty(badge)) {
      widgets.push({
        blockType: 'lx_eyebrow',
        data: { text: clampPlain(badge, 120), tone: 'champagne', alignment: 'left', animation: 'fade-in' },
      })
    }
    widgets.push({
      blockType: 'lx_heading',
      data: {
        text: clampPlain(project.name, 220) || project.name.slice(0, 220),
        level: 'h1',
        size: 'display-2xl',
        alignment: 'left',
        tone: 'ivory',
        animation: 'line-reveal',
      },
    })
    if (nonEmpty(hero.summary_richtext)) {
      widgets.push({
        blockType: 'lx_text',
        data: {
          body_richtext: str(hero.summary_richtext),
          tone: 'ivory',
          alignment: 'left',
          size: 'body-lg',
          maxWidth: 'wide',
          animation: 'slide-up',
        },
      })
    }
    widgets.push({
      blockType: 'lx_action',
      data: {
        label: 'Schedule a tour',
        href: `/projects/${slug}#inquiry-form`,
        variant: 'primary-gold',
        size: 'lg',
        alignment: 'left',
        animation: 'slide-up',
      },
    })
    if (project.brochurePdfId !== null) {
      widgets.push({
        blockType: 'lx_action',
        data: {
          label: 'Download brochure',
          href: `/projects/${slug}#brochure`,
          variant: 'secondary-outline',
          size: 'lg',
          alignment: 'left',
          animation: 'slide-up',
        },
      })
    }
    const meta: Record<string, unknown> = banner
      ? {
          columns: 1,
          background: 'obsidian',
          padding: '2xl',
          minHeight: 'xl',
          backgroundImage: { media_id: banner.media_id, alt: banner.alt ?? '' },
          backgroundOverlay: 'gradient-bottom',
        }
      : { columns: 1, background: 'obsidian', padding: '2xl', minHeight: 'lg' }
    out.push({ meta, columns: oneCol(widgets) })
  }

  // ── Gallery ────────────────────────────────────────────────────────
  // Light IVORY band. Centered editorial header; each category becomes a
  // left-aligned display-sm sub-heading above a 3-up 4:5 portrait grid
  // (the architectural editorial ratio). fade-in so the photos settle in
  // as the band scrolls into view.
  {
    const gallery = byKey.get('gallery') ?? {}
    const categories = Array.isArray(gallery.categories)
      ? (gallery.categories as Array<Record<string, unknown>>)
      : []
    const galleryWidgets: ProjectWidget[] = []
    for (const cat of categories) {
      const images = Array.isArray(cat.images)
        ? (cat.images as unknown[]).filter((im) => mediaRef(im))
        : []
      if (images.length === 0) continue
      if (nonEmpty(cat.name)) {
        galleryWidgets.push({
          blockType: 'lx_heading',
          data: { text: clampPlain(str(cat.name), 220), level: 'h3', size: 'display-sm', alignment: 'left', tone: 'obsidian' },
        })
      }
      galleryWidgets.push({
        blockType: 'lx_gallery',
        data: { images, columns: 3, ratio: '4:5', tone: 'obsidian', animation: 'fade-in' },
      })
    }
    if (galleryWidgets.length > 0) {
      out.push({
        meta: { columns: 1, background: 'ivory', padding: 'xl' },
        columns: oneCol([
          ...header('Gallery', 'The residence in detail', 'obsidian'),
          ...galleryWidgets,
        ]),
      })
    }
  }

  // ── Floor plans ─────────────────────────────────────────────────────
  // BONE band (one warm step off the gallery's ivory). Centered header.
  // Each unit reads as a composed entry: left display-md name → 16:9
  // figure → a left-aligned bed/bath/sqft stat trio (obsidian tone on
  // the light band, champagne glow halo intact) → optional description.
  // A section-sm spacer separates consecutive units so the stat trios of
  // one layout don't crowd the heading of the next (no hairline rule —
  // breathing room does the dividing).
  {
    const fp = byKey.get('floor_plans') ?? {}
    const units = Array.isArray(fp.unit_types)
      ? (fp.unit_types as Array<Record<string, unknown>>)
      : []
    const widgets: ProjectWidget[] = []
    const renderableUnits = units.filter((u) => nonEmpty(u.name) || mediaRef(u.image))
    renderableUnits.forEach((u, i) => {
      const img = mediaRef(u.image)
      if (nonEmpty(u.name)) {
        widgets.push({ blockType: 'lx_heading', data: { text: clampPlain(str(u.name), 220), level: 'h3', size: 'display-md', alignment: 'left', tone: 'obsidian' } })
      }
      if (img) {
        widgets.push({ blockType: 'lx_figure', data: { image: { media_id: img.media_id, alt: img.alt ?? '' }, ratio: '16:9', fit: 'cover' } })
      }
      if (isFiniteNum(u.beds)) widgets.push({ blockType: 'lx_stat', data: { value: u.beds, label: 'Bedrooms', alignment: 'left', decimals: 0, tone: 'obsidian' } })
      if (isFiniteNum(u.baths)) widgets.push({ blockType: 'lx_stat', data: { value: u.baths, label: 'Bathrooms', alignment: 'left', decimals: 1, tone: 'obsidian' } })
      if (isFiniteNum(u.sqft)) widgets.push({ blockType: 'lx_stat', data: { value: u.sqft, label: 'Sq ft', alignment: 'left', decimals: 0, tone: 'obsidian' } })
      if (nonEmpty(u.description)) widgets.push({ blockType: 'lx_text', data: { body_richtext: str(u.description), size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide' } })
      if (i < renderableUnits.length - 1) widgets.push({ blockType: 'lx_space', data: { size: 'section-sm' } })
    })
    if (widgets.length > 0) {
      out.push({
        meta: { columns: 1, background: 'bone', padding: 'xl' },
        columns: oneCol([
          ...header('Floor plans', 'Layouts', 'obsidian'),
          ...widgets,
        ]),
      })
    }
  }

  // ── Pricing ─────────────────────────────────────────────────────────
  // DARK FEATURE BAND — obsidian, 2xl padding. The investment moment
  // earns gravity: a centered ivory header on near-black, the value
  // narrative as ivory body, and prices as PROMINENT champagne display
  // headings (formatted currency, never a count-up — a 6-digit count-up
  // reads as broken). Availability counts ARE the count-up case →
  // lx_stat with `ivory` tone (champagne-toned stats would render an
  // obsidian/70 label that disappears on the dark band; ivory keeps both
  // numeral and label legible, and the champagne glow halo still warms
  // the numeral). Handover ETA as a quiet ivory line.
  {
    const p = byKey.get('pricing') ?? {}
    const currency = /^[A-Z]{3}$/.test(str(p.price_currency)) ? str(p.price_currency) : ''
    const widgets: ProjectWidget[] = []
    if (nonEmpty(p.value_richtext)) widgets.push({ blockType: 'lx_text', data: { body_richtext: str(p.value_richtext), size: 'body-lg', alignment: 'center', tone: 'ivory', maxWidth: 'wide', animation: 'fade-in' } })
    // Prices: FORMATTED-currency headings (commas, currency symbol),
    // champagne to read as the gold "this is the number" moment.
    if (isFiniteNum(p.price_min)) widgets.push({ blockType: 'lx_heading', data: { text: `From ${formatCurrency(p.price_min, currency)}`, level: 'h3', size: 'display-md', alignment: 'center', tone: 'champagne', animation: 'slide-up' } })
    if (isFiniteNum(p.price_max)) widgets.push({ blockType: 'lx_heading', data: { text: `Up to ${formatCurrency(p.price_max, currency)}`, level: 'h3', size: 'display-md', alignment: 'center', tone: 'champagne', animation: 'slide-up' } })
    // Units: small whole numbers — count-up lx_stat. ivory tone so the
    // label survives on the dark band.
    if (isFiniteNum(p.units_total)) widgets.push({ blockType: 'lx_stat', data: { value: p.units_total, label: 'Total units', alignment: 'center', decimals: 0, tone: 'ivory' } })
    if (isFiniteNum(p.units_remaining)) widgets.push({ blockType: 'lx_stat', data: { value: p.units_remaining, label: 'Units remaining', alignment: 'center', decimals: 0, tone: 'ivory' } })
    if (nonEmpty(p.handover_eta)) widgets.push({ blockType: 'lx_text', data: { body_richtext: `<p><strong>Handover</strong> ${clampPlain(str(p.handover_eta), 60)}</p>`, size: 'body-md', alignment: 'center', tone: 'ivory' } })
    if (widgets.length > 0) {
      out.push({
        meta: { columns: 1, background: 'obsidian', padding: '2xl' },
        columns: oneCol([
          ...header('Investment', 'Pricing & availability', 'ivory'),
          ...widgets,
        ]),
      })
    }
  }

  // ── Amenities ───────────────────────────────────────────────────────
  // CREAM band (back to light after the obsidian pricing band). Centered
  // editorial header. The amenity set renders as a 3-up lx_icon_list
  // grid — each item is a champagne-glow lucide icon over an obsidian
  // headline, centered within its cell so the icons read as a balanced
  // matrix rather than a left-ragged list. slide-up entrance.
  {
    const a = byKey.get('amenities') ?? {}
    const items = (Array.isArray(a.items) ? (a.items as Array<Record<string, unknown>>) : [])
      .filter((it) => nonEmpty(it.label))
      .slice(0, 12) // lx_icon_list cap
      .map((it) => ({ icon: amenityIconName(str(it.icon)), headline: clampPlain(str(it.label), 220) }))
    if (items.length > 0) {
      out.push({
        meta: { columns: 1, background: 'cream', padding: 'xl' },
        columns: oneCol([
          ...header('Amenities', 'What you get', 'obsidian'),
          { blockType: 'lx_icon_list', data: { items, variant: 'grid', columns: 3, alignment: 'center', tone: 'obsidian', animation: 'slide-up' } },
        ]),
      })
    }
  }

  // ── Location ────────────────────────────────────────────────────────
  // IVORY band, TWO columns — the luxury-listing split: location DETAIL
  // on the LEFT, the MAP on the RIGHT (50/50 grid, stacks on mobile with
  // the map beneath the detail).
  //
  //  • LEFT rail: left eyebrow → left heading → address standfirst
  //    (body-lg warm-stone) → the points-of-interest as a `row`-variant
  //    icon list (columns:1) — the map-pin glyph sits BESIDE each place
  //    name, drive time as the sub-line. The whole rail is vertically
  //    CENTRED (column verticalAlign) against the taller map.
  //
  //  • RIGHT: the map with ratio:'fill' — it stretches to the full column
  //    height (min 440px) so it reads as a substantial map panel, not the
  //    squat fixed-ratio strip a 50% column makes of a 16:9 embed.
  //
  // No map → a single CENTRED column (header + address + a 2-up POI row
  // grid) so the band still fills its width.
  {
    const l = byKey.get('location') ?? {}
    const pois = (Array.isArray(l.points_of_interest) ? (l.points_of_interest as Array<Record<string, unknown>>) : [])
      .filter((p) => nonEmpty(p.label))
      .slice(0, 12)
      .map((p) => ({
        icon: 'map-pin',
        headline: clampPlain(str(p.label), 220),
        ...(isFiniteNum(p.drive_time_min) ? { body: `${p.drive_time_min} min drive` } : {}),
      }))
    const mapUrl = str(l.map_embed_url)
    const hasMap = !!mapUrl && isValidMapEmbedUrl(mapUrl)

    if (hasMap) {
      const detail: ProjectWidget[] = [
        { blockType: 'lx_eyebrow', data: { text: 'The neighbourhood', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
        { blockType: 'lx_heading', data: { text: 'Location', level: 'h2', size: 'display-lg', alignment: 'left', tone: 'obsidian', animation: 'slide-up' } },
      ]
      if (nonEmpty(l.address)) detail.push({ blockType: 'lx_text', data: { body_richtext: clampPlain(str(l.address), 280), alignment: 'left', tone: 'warm-stone', size: 'body-lg', maxWidth: 'wide' } })
      if (pois.length > 0) detail.push({ blockType: 'lx_icon_list', data: { items: pois, variant: 'row', columns: 1, alignment: 'left', tone: 'obsidian', animation: 'fade-in' } })
      out.push({
        meta: { columns: 2, background: 'ivory', padding: 'xl' },
        columns: [
          { widgets: detail, meta: { verticalAlign: 'center' } },
          { widgets: [{ blockType: 'lx_map', data: { embedUrl: mapUrl, ratio: 'fill' } }] },
        ],
      })
    } else {
      const widgets: ProjectWidget[] = [...header('The neighbourhood', 'Location', 'obsidian')]
      if (nonEmpty(l.address)) widgets.push({ blockType: 'lx_text', data: { body_richtext: clampPlain(str(l.address), 280), alignment: 'center', tone: 'warm-stone', size: 'body-lg', maxWidth: 'wide' } })
      if (pois.length > 0) widgets.push({ blockType: 'lx_icon_list', data: { items: pois, variant: 'row', columns: 2, alignment: 'left', tone: 'obsidian', animation: 'fade-in' } })
      if (widgets.length > 2) out.push({ meta: { columns: 1, background: 'ivory', padding: 'xl' }, columns: oneCol(widgets) })
    }
  }

  // ── Timeline ────────────────────────────────────────────────────────
  // BONE band. Centered header. Each milestone reads as a champagne date
  // eyebrow → left display-md title → optional body → optional 16:9
  // photo, with a section-sm spacer between milestones (NOT a hairline
  // rule — the no-borders aesthetic means rhythm comes from space, and
  // the old quarter-width champagne divider read as chrome).
  {
    const t = byKey.get('timeline') ?? {}
    const entries = Array.isArray(t.entries) ? (t.entries as Array<Record<string, unknown>>) : []
    const widgets: ProjectWidget[] = []
    const renderable = entries.filter((e) => nonEmpty(e.title))
    renderable.forEach((e, i) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(str(e.date))) widgets.push({ blockType: 'lx_eyebrow', data: { text: str(e.date), tone: 'champagne', alignment: 'left' } })
      widgets.push({ blockType: 'lx_heading', data: { text: clampPlain(str(e.title), 220), level: 'h3', size: 'display-md', alignment: 'left', tone: 'obsidian' } })
      if (nonEmpty(e.body_richtext)) widgets.push({ blockType: 'lx_text', data: { body_richtext: str(e.body_richtext), size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide' } })
      const photo = mediaRef(e.photo)
      if (photo) widgets.push({ blockType: 'lx_figure', data: { image: { media_id: photo.media_id, alt: photo.alt ?? '' }, ratio: '16:9', fit: 'cover' } })
      if (i < renderable.length - 1) widgets.push({ blockType: 'lx_space', data: { size: 'section-sm' } })
    })
    if (widgets.length > 0) {
      out.push({
        meta: { columns: 1, background: 'bone', padding: 'xl' },
        columns: oneCol([
          ...header('Timeline', 'Construction progress', 'obsidian'),
          ...widgets,
        ]),
      })
    }
  }

  // ── Testimonials ────────────────────────────────────────────────────
  // SECOND DARK FEATURE BAND — charcoal (#151719), distinct from the
  // obsidian pricing band so the two dark moments don't twin. 2xl
  // padding, quote-forward and centered: an ivory header, then each
  // testimonial centered with the champagne quote-mark glow and an ivory
  // pull-quote. The first quote uses line-reveal (the signature motion,
  // here earned because the testimonial band is a deliberate pause);
  // subsequent quotes fade-in. section-md spacers give each voice room.
  {
    const ts = byKey.get('testimonials') ?? {}
    const entries = (Array.isArray(ts.entries) ? (ts.entries as Array<Record<string, unknown>>) : [])
      .filter((e) => nonEmpty(e.quote) && nonEmpty(e.attribution))
    const widgets: ProjectWidget[] = []
    entries.forEach((e, i) => {
      widgets.push({
        blockType: 'lx_testimonial',
        data: {
          quote: str(e.quote),
          attribution: clampPlain(str(e.attribution), 120),
          ...(nonEmpty(e.unit_type) ? { attribution_title: clampPlain(str(e.unit_type), 120) } : {}),
          alignment: 'center',
          tone: 'ivory',
          animation: i === 0 ? 'line-reveal' : 'fade-in',
        },
      })
      if (i < entries.length - 1) widgets.push({ blockType: 'lx_space', data: { size: 'section-md' } })
    })
    if (widgets.length > 0) {
      out.push({
        meta: { columns: 1, background: 'charcoal', padding: '2xl' },
        columns: oneCol([
          ...header('Testimonials', 'What residents say', 'ivory'),
          ...widgets,
        ]),
      })
    }
  }

  // ── Inquiry — the one irreducible widget: a lead form. It renders
  //    its own eyebrow + heading + body from its block data, so we pass
  //    the copy INTO the form (not as separate primitives — that would
  //    double-render). The heading/body are editable via the form
  //    block's drawer. padding 'none' because the form brings its own
  //    band padding.
  {
    const q = byKey.get('inquiry') ?? {}
    out.push({
      meta: { columns: 1, background: 'cream', padding: 'none' },
      columns: oneCol([
        {
          blockType: 'lx_inquiry_form',
          data: {
            ...(nonEmpty(q.heading) ? { heading: clampPlain(str(q.heading), 220) } : {}),
            ...(nonEmpty(q.body_richtext) ? { body_richtext: str(q.body_richtext) } : {}),
          },
        },
      ]),
    })
  }

  // ── Brochure — same: the lead-gated form renders its own copy. Only
  //    when a PDF exists on the project row (the form gates on it).
  if (project.brochurePdfId !== null) {
    const b = byKey.get('brochure') ?? {}
    out.push({
      meta: { columns: 1, background: 'cream', padding: 'none' },
      columns: oneCol([
        {
          blockType: 'lx_brochure_form',
          data: nonEmpty(b.gate_message_richtext)
            ? { gate_message_richtext: str(b.gate_message_richtext) }
            : {},
        },
      ]),
    })
  }

  return out
}
