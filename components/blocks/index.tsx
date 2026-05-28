import type { ReactNode } from 'react'
// Fixed-slot widget — kept palette-visible even though it's not lx_.
import { ContactForm } from './ContactForm/render'
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
import { LxTestimonial } from './LxTestimonial/render'
import { LxVideo } from './LxVideo/render'
import { LxAccordion } from './LxAccordion/render'
import { LxTabs } from './LxTabs/render'
import { LxIconList } from './LxIconList/render'
import { LxIconBox } from './LxIconBox/render'
import { LxDivider } from './LxDivider/render'
import { LxSocialIcons } from './LxSocialIcons/render'
import { LxCtaBanner } from './LxCtaBanner/render'
import { LxGallery } from './LxGallery/render'
import type { BlockData, BlockType } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { SectionMeta } from '@/lib/cms/blockMeta'

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
  /** Parent section's meta — threaded so a renderer can derive its
   *  visual theme from the ancestor surface (dark vs light bg, cover-
   *  photo + dark-overlay heroes, etc.) instead of hardcoding tokens.
   *  Use `isSectionSurfaceDark(sectionMeta)` from `lib/cms/blockMeta`
   *  to resolve. `undefined` means the block is rendering at the page
   *  root (no ancestor section) — treat as light surface. */
  sectionMeta?: SectionMeta
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
  // contact_form is an async server component — it mints a CSRF nonce
  // via ensurePublicPreCsrf() inside its render. React/RSC unwraps the
  // returned Promise<JSX.Element> the same way it handles any async RSC.
  contact_form: ({ data, inlineEdit, outerClass, csrf, blockId, sectionMeta }: BlockRendererArgs<BlockData<'contact_form'>>) => (
    <ContactForm data={data} inlineEdit={inlineEdit} outerClass={outerClass} csrf={csrf} blockId={blockId} sectionMeta={sectionMeta} />
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
  lx_map: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_map'>>) => (
    <LxMap data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
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
  lx_testimonial: ({ data, media, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_testimonial'>>) => (
    <LxTestimonial data={data} media={media} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_video: ({ data, media, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_video'>>) => (
    <LxVideo data={data} media={media} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_accordion: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_accordion'>>) => (
    <LxAccordion data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_tabs: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_tabs'>>) => (
    <LxTabs data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_icon_list: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_icon_list'>>) => (
    <LxIconList data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_icon_box: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_icon_box'>>) => (
    <LxIconBox data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_divider: ({ data, outerClass }: BlockRendererArgs<BlockData<'lx_divider'>>) => (
    <LxDivider data={data} outerClass={outerClass} />
  ),
  lx_social_icons: ({ data, outerClass }: BlockRendererArgs<BlockData<'lx_social_icons'>>) => (
    <LxSocialIcons data={data} outerClass={outerClass} />
  ),
  lx_cta_banner: ({ data, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_cta_banner'>>) => (
    <LxCtaBanner data={data} inlineEdit={inlineEdit} outerClass={outerClass} />
  ),
  lx_gallery: ({ data, media, inlineEdit, outerClass }: BlockRendererArgs<BlockData<'lx_gallery'>>) => (
    <LxGallery data={data} media={media} inlineEdit={inlineEdit} outerClass={outerClass} />
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
  sectionMeta?: SectionMeta,
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
    sectionMeta,
  })
}
