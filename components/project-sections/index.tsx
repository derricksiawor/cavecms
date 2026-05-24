import type { ReactNode } from 'react'
import type { SectionKey } from '@/lib/cms/project-section-registry'
import { HeroSection } from './Hero/render'
import { GallerySection } from './Gallery/render'
import { FloorPlansSection } from './FloorPlans/render'
import { PricingSection } from './Pricing/render'
import { AmenitiesSection } from './Amenities/render'
import { LocationSection } from './Location/render'
import { BrochureSection } from './Brochure/render'
import { TimelineSection } from './Timeline/render'
import { TestimonialsSection } from './Testimonials/render'
import { InquirySection } from './InquiryForm/render'
import type {
  AmenitiesData,
  BrochureData,
  FloorPlansData,
  GalleryData,
  HeroData,
  InquiryData,
  LocationData,
  MediaMap,
  PricingData,
  ProjectPublicContext,
  TestimonialsData,
  TimelineData,
} from './_shared/types'

// Renderer-map dispatcher. Each section_key maps to a single per-
// section component under `components/project-sections/<Name>/render.tsx`.
// Cross-section chrome (FactsStrip, Summary, SimilarProjectsRail,
// StickyHeader, WhatsAppBubble) is rendered at the PAGE level
// because it needs cross-cutting data (project row + multiple
// section payloads) — see app/projects/[slug]/page.tsx.
//
// Adding a new section type:
//   1) Extend the Zod schema in lib/cms/project-section-registry.ts
//   2) Extend the SectionData type union in _shared/types.ts
//   3) Add a render.tsx under components/project-sections/<Name>/
//   4) Add an entry to the SECTION_RENDERERS map below
//
// Exhaustiveness contract: the `defineRenderers` helper constrains
// the input literal to `Record<SectionKey, SectionRenderer<unknown>>`
// AND returns `T` so the per-key data types in the literal are
// preserved. Adding a new SectionKey to the registry without a
// matching entry fails `tsc` AT the map declaration — one symbol,
// one source of truth, no separate exhaustiveness pin that could
// drift away from the dispatcher.

type RendererArgs<D> = {
  data: D
  media: MediaMap
  ctx: ProjectPublicContext
}

type SectionRenderer<D> = (args: RendererArgs<D>) => ReactNode

function defineRenderers<
  T extends Record<SectionKey, SectionRenderer<never>>,
>(map: T): T {
  return map
}

// Per-key renderer table. The generic helper above enforces the
// SectionKey set; each entry's narrower `data` parameter type (e.g.
// HeroData for hero) is preserved through the generic so the
// renderer body stays strongly typed.
const SECTION_RENDERERS = defineRenderers({
  hero: ({ data, media, ctx }: RendererArgs<HeroData>) => (
    <HeroSection data={data} media={media} ctx={ctx} />
  ),
  gallery: ({ data, media }: RendererArgs<GalleryData>) => (
    <GallerySection data={data} media={media} />
  ),
  floor_plans: ({ data, media }: RendererArgs<FloorPlansData>) => (
    <FloorPlansSection data={data} media={media} />
  ),
  pricing: ({ data }: RendererArgs<PricingData>) => (
    <PricingSection data={data} />
  ),
  amenities: ({ data }: RendererArgs<AmenitiesData>) => (
    <AmenitiesSection data={data} />
  ),
  location: ({ data }: RendererArgs<LocationData>) => (
    <LocationSection data={data} />
  ),
  brochure: ({ data, ctx }: RendererArgs<BrochureData>) => (
    <BrochureSection data={data} ctx={ctx} />
  ),
  timeline: ({ data, media }: RendererArgs<TimelineData>) => (
    <TimelineSection data={data} media={media} />
  ),
  testimonials: ({ data }: RendererArgs<TestimonialsData>) => (
    <TestimonialsSection data={data} />
  ),
  inquiry: ({ data, ctx }: RendererArgs<InquiryData>) => (
    <InquirySection data={data} ctx={ctx} />
  ),
})

export type { ProjectPublicContext } from './_shared/types'

export function renderSection(
  key: string,
  data: unknown,
  media: MediaMap,
  ctx: ProjectPublicContext,
): ReactNode {
  // Look up the renderer. Unknown key (tampered DB cell, forward-
  // compat row that lands before the dispatcher catches up) → null.
  // The notification_failures pipeline surfaces these to operators.
  const renderer = (
    SECTION_RENDERERS as Record<string, SectionRenderer<unknown>>
  )[key]
  if (!renderer) return null
  return renderer({ data, media, ctx })
}
