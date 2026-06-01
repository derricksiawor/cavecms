// Shared types used by every per-section render.tsx and the
// dispatcher. Centralised here to avoid circular imports between
// `components/project-sections/index.tsx` and the individual section
// files.

export type MediaMap = Map<
  number,
  {
    variants: Record<string, string> | null
    alt_text: string
    width: number | null
    height: number | null
  }
>

export interface MediaRef {
  media_id: number
  alt: string
}

// Context carried alongside every dispatcher call. Fields are kept
// to the minimum each dispatched section actually consumes:
//   - preCsrf:        Brochure + Inquiry forms attach as hidden input
//   - previewMode:    Brochure + Inquiry suppress the live form
//                     (admin QA mustn't see false-success states)
//   - projectId/Name: every lead form scopes to the project; Hero
//                     uses Name as the visible H2
//   - projectTagline: Hero subtitle fallback
//   - projectStatus:  Hero badge default when admin doesn't override
//                     status_label
// projectLocation + projectSlug are NOT here — they're consumed only
// by page-level chrome (FactsStrip, SimilarProjectsRail, StickyHeader,
// WhatsAppBubble) which receive them as direct props from the page.
// Keeping the ctx surface small avoids "which is canonical?" drift.
export interface ProjectPublicContext {
  preCsrf: string
  previewMode: boolean
  projectId: number
  projectName: string
  projectTagline: string | null
  projectStatus: string
}

// ---- Per-section data shapes (mirror Zod schemas in
// lib/cms/project-section-registry.ts — keep in sync; the Zod side
// is the trust boundary). Used by the dispatcher to narrow `unknown`
// before passing into the per-section render.tsx. ----

export interface HeroData {
  status_label?: string
  banner_image: MediaRef | null
  summary_richtext?: string
}

export interface GalleryData {
  categories: Array<{
    name: string
    images: Array<MediaRef & { caption?: string }>
  }>
}

export interface FloorPlansData {
  unit_types: Array<{
    name: string
    beds: number
    baths: number
    sqft: number
    image: MediaRef
    description?: string
  }>
}

export interface PricingData {
  display: 'range' | 'per_unit' | 'contact'
  value_richtext: string
  units_total?: number
  units_remaining?: number
  price_min?: number
  price_max?: number
  price_currency?: string
  handover_eta?: string
}

export interface AmenitiesData {
  items: Array<{ icon: string; label: string }>
}

export interface LocationData {
  map_embed_url?: string
  address: string
  points_of_interest: Array<{ label: string; drive_time_min: number }>
}

export interface BrochureData {
  pdf: MediaRef | null
  gate_message_richtext?: string
  // Form presentation (absent === current: no card surface, bordered
  // inputs).
  card_surface?: 'panel' | 'transparent'
  field_style?: 'bordered' | 'filled'
}

export interface TimelineData {
  entries: Array<{
    date: string
    title: string
    body_richtext?: string
    photo?: MediaRef
  }>
}

export interface TestimonialsData {
  entries: Array<{ quote: string; attribution: string; unit_type?: string }>
}

export interface InquiryData {
  heading?: string
  body_richtext?: string
  // Form presentation (absent === current: cream panel card, bordered
  // inputs).
  card_surface?: 'panel' | 'transparent'
  field_style?: 'bordered' | 'filled'
}
