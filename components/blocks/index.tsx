import type { ReactNode } from 'react'
import { Hero } from './Hero/render'
import { Cta } from './Cta/render'
import { Text } from './Text/render'
import { ImageBlock } from './Image/render'
import { Gallery } from './Gallery/render'
import { Quote } from './Quote/render'
import { ServicesIntro } from './ServicesIntro/render'
import { FeaturedProjects } from './FeaturedProjects/render'
import { AboutHistory } from './AboutHistory/render'
import { Heading } from './Heading/render'
import { Button } from './Button/render'
import { Divider } from './Divider/render'
import { Spacer } from './Spacer/render'
import { IconBox } from './IconBox/render'
import { Accordion } from './Accordion/render'
import { IconList } from './IconList/render'
import { Tabs } from './Tabs/render'
// Chunk G - Elementor-parity rich widgets.
import { Alert } from './Alert/render'
import { SocialIcons } from './SocialIcons/render'
import { StarRating } from './StarRating/render'
import { StatsRow } from './StatsRow/render'
import { Testimonial } from './Testimonial/render'
import { VideoEmbed } from './VideoEmbed/render'
import { ContactForm } from './ContactForm/render'
import { Eyebrow } from './Eyebrow/render'
import { ChannelCard } from './ChannelCard/render'
// ─── Luxury redesign — lx_* widget primitives ───────────────────────
import { LxHeading } from './LxHeading/render'
import { LxText } from './LxText/render'
import { LxEyebrow } from './LxEyebrow/render'
import { LxAction } from './LxAction/render'
import { LxCoverImage } from './LxCoverImage/render'
import { LxFigure } from './LxFigure/render'
import { LxImagePair } from './LxImagePair/render'
import { LxMap } from './LxMap/render'
import { LxSpace } from './LxSpace/render'
import { LxChannelCard } from './LxChannelCard/render'
import { LxStat } from './LxStat/render'
import { LxQuote } from './LxQuote/render'
import type { BlockData, BlockType } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

export interface RenderContext {
  media: Map<number, { variants: Record<string, string> | null; alt_text: string; width: number | null; height: number | null }>
  projects: Map<number, { slug: string; name: string; tagline: string | null; hero_image_id: number | null }>
  /** Public preCsrf nonce minted once per page render. Only set when
   *  the page tree contains a block that submits a public form (today:
   *  `contact_form`). Blocks that don't need it ignore the field; an
   *  absent value surfaces as a graceful degradation in those blocks
   *  (form replaced by "use email / phone" hint) rather than a 500.
   *  See `renderCmsPage()` for the mint site + the contact_form
   *  block renderer for the consumer. */
  csrf?: string
}

// Per-block renderer call shape. `data` is the parsed Zod payload for the
// specific BlockType key. `media` / `projects` come from RenderContext
// (page-wide). `inlineEdit` is per-block (only the inline-editable widget
// types consume it). `outerClass` is Chunk E's per-side spacing-override
// derived from WidgetMeta — every renderer threads it into its outer
// wrapper so the operator's spacing toolbar wins regardless of widget.
// `blockId` is the persisted row id — Chunk G's dismissible Alert uses
// it to scope its localStorage key per block (so two distinct Alert
// blocks with the same content don't share a dismissal). Optional
// because not every renderer needs it.
type BlockRendererArgs<D> = {
  data: D
  media: RenderContext['media']
  projects: RenderContext['projects']
  csrf?: RenderContext['csrf']
  inlineEdit?: InlineEditContext
  outerClass?: string
  blockId?: number
}

type BlockRenderer<D> = (args: BlockRendererArgs<D>) => ReactNode

// Exhaustiveness contract — mirrors components/project-sections/index.tsx
// (Chunk C of the project-detail rebuild). The helper constrains the
// literal to Record<BlockType, BlockRenderer<never>> while preserving
// each entry's narrower data type. Adding a new BlockType to the registry
// without a matching renderer here fails `tsc` AT the map declaration —
// one symbol, one source of truth, no separate exhaustiveness pin that
// could drift away from the dispatcher.
//
// The `& Record<Exclude<keyof T, BlockType>, never>` intersection
// forces excess keys (a typo'd renderer for a non-existent BlockType)
// to compile-error too. Without this, only MISSING renderers were
// caught — a stray `'headign'` entry alongside `'heading'` would have
// silently lived as dead code.
function defineRenderers<
  T extends Record<BlockType, BlockRenderer<never>>,
>(map: T & Record<Exclude<keyof T, BlockType>, never>): T {
  return map
}

const BLOCK_RENDERERS = defineRenderers({
  hero: ({ data, media, outerClass }: BlockRendererArgs<BlockData<'hero'>>) => (
    <Hero data={data} media={media} outerClass={outerClass} />
  ),
  cta: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'cta'>>) => (
    <Cta data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  text: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'text'>>) => (
    <Text data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  image: ({ data, media, outerClass }: BlockRendererArgs<BlockData<'image'>>) => (
    <ImageBlock data={data} media={media} outerClass={outerClass} />
  ),
  gallery: ({ data, media, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'gallery'>>) => (
    <Gallery data={data} media={media} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  quote: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'quote'>>) => (
    <Quote data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  services_intro: ({ data, outerClass }: BlockRendererArgs<BlockData<'services_intro'>>) => (
    <ServicesIntro data={data} outerClass={outerClass} />
  ),
  featured_projects: ({ data, projects, media, outerClass }: BlockRendererArgs<BlockData<'featured_projects'>>) => (
    <FeaturedProjects data={data} projects={projects} media={media} outerClass={outerClass} />
  ),
  about_history: ({ data, media, outerClass }: BlockRendererArgs<BlockData<'about_history'>>) => (
    <AboutHistory data={data} media={media} outerClass={outerClass} />
  ),
  heading: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'heading'>>) => (
    <Heading data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  button: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'button'>>) => (
    <Button data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  divider: ({ data, outerClass }: BlockRendererArgs<BlockData<'divider'>>) => (
    <Divider data={data} outerClass={outerClass} />
  ),
  spacer: ({ data, outerClass }: BlockRendererArgs<BlockData<'spacer'>>) => (
    <Spacer data={data} outerClass={outerClass} />
  ),
  icon_box: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'icon_box'>>) => (
    <IconBox data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  accordion: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'accordion'>>) => (
    <Accordion data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  icon_list: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'icon_list'>>) => (
    <IconList data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  tabs: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'tabs'>>) => (
    <Tabs data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  // ─── Chunk G — Elementor-parity rich widgets ─────────────────────
  // Alphabetical within G. The renderers are in components/blocks/<Name>/
  // and threaded with outerClass via Chunk E's pattern.
  alert: ({ data, inlineEdit, outerClass, blockId }: BlockRendererArgs<BlockData<'alert'>>) => (
    <Alert data={data} inlineEdit={inlineEdit} outerClass={outerClass} blockId={blockId} />
  ),
  social_icons: ({ data, outerClass }: BlockRendererArgs<BlockData<'social_icons'>>) => (
    <SocialIcons data={data} outerClass={outerClass} />
  ),
  star_rating: ({ data, outerClass }: BlockRendererArgs<BlockData<'star_rating'>>) => (
    <StarRating data={data} outerClass={outerClass} />
  ),
  stats_row: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'stats_row'>>) => (
    <StatsRow data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  testimonial: ({ data, media, projects, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'testimonial'>>) => (
    <Testimonial data={data} media={media} projects={projects} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  video_embed: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'video_embed'>>) => (
    <VideoEmbed data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  // contact_form is an async server component — it mints a CSRF nonce
  // via ensurePublicPreCsrf() inside its render. React/RSC unwraps the
  // returned Promise<JSX.Element> the same way it handles any async RSC.
  contact_form: ({ data, inlineEdit, outerClass, csrf, blockId }: BlockRendererArgs<BlockData<'contact_form'>>) => (
    <ContactForm data={data} inlineEdit={inlineEdit} outerClass={outerClass} csrf={csrf} blockId={blockId} />
  ),
  eyebrow: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'eyebrow'>>) => (
    <Eyebrow data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  channel_card: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'channel_card'>>) => (
    <ChannelCard data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  // ─── Luxury redesign dispatchers ────────────────────────────────
  // Each lx_* renderer accepts the standard BlockRendererArgs shape:
  // data (typed via the block-registry BlockData), inlineEdit (when
  // the editor surface is active), outerClass (Chunk E spacing-
  // toolbar override). Animation choice lives inside data and is
  // routed through MotionTarget by the renderer itself.
  lx_heading: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_heading'>>) => (
    <LxHeading data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_text: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_text'>>) => (
    <LxText data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_eyebrow: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_eyebrow'>>) => (
    <LxEyebrow data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_action: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_action'>>) => (
    <LxAction data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_figure: ({ data, media, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_figure'>>) => (
    <LxFigure data={data} media={media} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_cover_image: ({ data, media, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_cover_image'>>) => (
    <LxCoverImage data={data} media={media} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_image_pair: ({ data, media, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_image_pair'>>) => (
    <LxImagePair data={data} media={media} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_map: ({ data, outerClass }: BlockRendererArgs<BlockData<'lx_map'>>) => (
    <LxMap data={data} outerClass={outerClass} />
  ),
  lx_space: ({ data, outerClass }: BlockRendererArgs<BlockData<'lx_space'>>) => (
    <LxSpace data={data} outerClass={outerClass} />
  ),
  // Composite luxury widgets.
  lx_channel_card: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_channel_card'>>) => (
    <LxChannelCard data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_stat: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_stat'>>) => (
    <LxStat data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_quote: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_quote'>>) => (
    <LxQuote data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
})

/**
 * Render mode. `'public'` (default) is the public-page render —
 * unknown block types collapse silently to null so a tampered DB
 * cell or a forward-compat row doesn't leak debug chrome to
 * visitors. `'edit'` is the canvas render mode — unknown blocks
 * render a copper-outlined placeholder card with a Delete button
 * so operators can see + recover from the bad row in-place.
 *
 * The two render-shell consumers
 * (`components/inline-edit/BlockTreeRenderer.tsx` and
 * `components/inline-edit/EditableBlockTreeRenderer.tsx`) pass
 * `'public'` and `'edit'` respectively. The default stays `'public'`
 * so any future caller that forgets to thread the parameter gets the
 * safe behaviour.
 *
 * `renderBlock` is a server-safe module (no React hooks, no
 * 'use client' marker) — so reading the mode from React context is
 * not an option. Explicit param is mandatory.
 */
export type BlockRenderMode = 'public' | 'edit'

export function renderBlock(
  type: string,
  data: unknown,
  ctx: RenderContext,
  inlineEdit?: InlineEditContext,
  outerClass?: string,
  blockId?: number,
  mode: BlockRenderMode = 'public',
): ReactNode {
  const renderer = (BLOCK_RENDERERS as Record<string, BlockRenderer<unknown>>)[type]
  if (!renderer) {
    // Unknown type (tampered DB cell, forward-compat row that lands
    // before the dispatcher catches up). Emit a structured warn so
    // log aggregation can surface tampering or forward-compat drift
    // (server-side only — guarded so the warn doesn't fire when this
    // module is loaded in a client bundle).
    if (typeof window === 'undefined') {
      console.warn('[cms.renderBlock] unknown block type', { type })
    }
    if (mode !== 'edit') {
      // Public render: collapse silently so the page still loads
      // and visitors don't see debug chrome. The wider audit /
      // republish flow surfaces the bad row.
      return null
    }
    // Editor canvas: a visible placeholder card so the operator
    // sees the orphan block at the position where it lives and can
    // remove it in-place. Copper-outlined chrome reads as "this is
    // a problem you can fix", not as a published widget.
    //
    // The Delete button POSTs DELETE /api/cms/blocks/[id] via the
    // form's method override. We use a form rather than a button +
    // fetch wrapper because this module is server-safe — no React
    // hooks, no client-side handlers. The form's action carries the
    // blockId; the server route is responsible for refusing the
    // delete if the block_key is a fixed slot (existing 409 guard
    // in DELETE /api/cms/blocks/[id]).
    return (
      <div
        role="alert"
        aria-label="Unknown block type"
        className={[
          'my-4 mx-auto max-w-3xl rounded-2xl bg-ivory/90 px-6 py-5 text-obsidian ring-2 ring-copper-500/60 shadow-[0_8px_30px_-12px_rgba(159,108,46,0.35)]',
          outerClass ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-copper-600">
              Unknown block type
            </p>
            <p className="mt-1 text-sm font-medium text-obsidian">
              <code className="rounded bg-copper-100/60 px-1.5 py-0.5 font-mono text-[11px] text-copper-700">
                {type}
              </code>{' '}
              is not recognised. This block can be removed or skipped — the
              renderer cannot display it.
            </p>
          </div>
          {typeof blockId === 'number' && (
            <form
              method="POST"
              action={`/api/cms/blocks/${blockId}?_method=DELETE`}
              className="shrink-0"
            >
              <button
                type="submit"
                className="rounded-full bg-copper-600 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50 transition-colors hover:bg-copper-700"
              >
                Delete
              </button>
            </form>
          )}
        </div>
      </div>
    )
  }
  return renderer({
    data: data as never,
    media: ctx.media,
    projects: ctx.projects,
    csrf: ctx.csrf,
    inlineEdit,
    outerClass,
    blockId,
  })
}
