import 'server-only'
import { Fragment } from 'react'
import { renderBlock } from '@/components/blocks'
import type { RenderContext } from '@/components/blocks'
import type {
  HydratedBlock,
  HydratedMedia,
  HydratedProject,
  HydratedPost,
  HydratedPostsLoop,
} from '@/lib/cms/hydrate'
import { buildBlockTree } from '@/lib/cms/blockTree'
import {
  htmlIdForBlock,
  parseSectionMeta,
  parseWidgetMeta,
  visibilityClasses,
} from '@/lib/cms/blockMeta'
import { spacingClass, spacingStyle } from '@/lib/cms/spacingClasses'
import { ColumnFrame, SectionFrame } from './renderShell'
import clsx from 'clsx'

// Server-only renderer for the section→column→widget tree on the
// anonymous / non-editable surface (signed-out visitor, admin without
// edit mode on). Pure HTML — no client hooks, no editable shells, no
// DnD. The shared `renderShell` primitives emit the EXACT same
// wrapper structure the editable client mirror uses (Chunk B's
// EditableBlockTreeRenderer), so a section flipped in the editor
// renders identically when the next anonymous visitor lands.
//
// The editor surface lives in EditableBlockTreeRenderer.tsx and reads
// from InlineEditContext for optimistic previews + version cursors.
// EditableMain dispatches: editable=true → EditableBlockTreeRenderer;
// editable=false → this file. No call-site passes editable=true here
// anymore (post-Chunk-B).
//
// Chunk E: widget meta → outerClass is derived here so the anonymous
// renderer applies the same per-side spacing overrides the editor
// operator sees. parseWidgetMeta tolerates null/malformed JSON — a
// corrupt cell renders with the widget's natural padding, never 500s.

interface Props {
  blocks: HydratedBlock[]
  media: Map<number, HydratedMedia>
  projects: Map<number, HydratedProject>
  posts: Map<number, HydratedPost>
  /** Blog Loop slice — see RenderContext.postsLoop. Threaded into every
   *  renderBlock dispatch so a loop-mode lx_posts block renders its
   *  paginated page. Undefined on pages without a loop block. */
  postsLoop?: HydratedPostsLoop
  /** Public preCsrf nonce minted in `renderCmsPage()`. Threaded through
   *  every renderBlock dispatch via RenderContext so blocks that need
   *  it (today: `contact_form`) can submit without an extra round trip.
   *  Undefined when the page tree has no form-bearing block. */
  csrf?: string
  /** Singular project context — set only when a project detail page
   *  renders its block tree (see RenderContext.project). Threaded into
   *  every renderBlock dispatch so the project block renderers resolve
   *  the project row. Undefined on every non-project page. */
  project?: RenderContext['project']
  /** Preview-mode marker — see RenderContext.preview. */
  preview?: boolean
}

/** One-shot meta-derivation. Returns the three computed values
 *  downstream renderers need without re-parsing the widget meta blob
 *  three times. The anonymous (non-editable) renderer used to call
 *  parseWidgetMeta(w.meta) THREE times per widget per render via the
 *  separate widgetOuterClass / widgetOuterStyle / widgetHtmlId helpers
 *  — pure CPU waste on public page renders. The editable mirror
 *  (EditableBlockTreeRenderer) already hoists via useMemo; the
 *  anonymous path now matches via a single derive call.
 *
 *  Numeric (px) spacing is applied via an extra wrapper div (style)
 *  rather than threaded into each widget renderer's `outerClass` API
 *  — this keeps the dozens of existing block renderers unchanged
 *  while still honouring per-side arbitrary px values the operator
 *  types into SpacingPopover. */
function deriveWidgetMeta(meta: unknown): {
  outerClass: string
  outerStyle: React.CSSProperties | undefined
  htmlId: string | undefined
} {
  const parsed = parseWidgetMeta(meta)
  return {
    outerClass: clsx(spacingClass(parsed), visibilityClasses(parsed)),
    outerStyle: spacingStyle(parsed),
    htmlId: htmlIdForBlock(parsed),
  }
}

function WidgetStyleWrap({
  style,
  htmlId,
  children,
}: {
  style: React.CSSProperties | undefined
  htmlId: string | undefined
  children: React.ReactNode
}) {
  if (!style && !htmlId) return <>{children}</>
  return (
    <div style={style} id={htmlId}>
      {children}
    </div>
  )
}

export function BlockTreeRenderer({
  blocks,
  media,
  projects,
  posts,
  postsLoop,
  csrf,
  project,
  preview,
}: Props) {
  const tree = buildBlockTree(blocks)
  if (tree.length === 0) return null
  return (
    <>
      {tree.map((entry) => {
        if (entry.kind === 'section') {
          const sec = entry.node.section
          return (
            <Fragment key={sec.id}>
              <SectionFrame
                meta={sec.meta}
                columnCount={entry.node.columns.length}
                sectionId={sec.id}
                exposeId={false}
                media={media}
              >
                {entry.node.columns.map((col) => (
                  <ColumnFrame
                    key={col.column.id}
                    columnId={col.column.id}
                    exposeId={false}
                    meta={col.column.meta}
                    media={media}
                  >
                    {col.widgets.map((w) => {
                      const m = deriveWidgetMeta(w.meta)
                      return (
                        <Fragment key={w.id}>
                          <WidgetStyleWrap
                            style={m.outerStyle}
                            htmlId={m.htmlId}
                          >
                            {renderBlock(
                              w.blockType,
                              w.data,
                              { media, projects, posts, postsLoop, csrf, project, preview },
                              undefined,
                              m.outerClass,
                              w.id,
                              'public',
                              parseSectionMeta(sec.meta),
                            )}
                          </WidgetStyleWrap>
                        </Fragment>
                      )
                    })}
                  </ColumnFrame>
                ))}
              </SectionFrame>
            </Fragment>
          )
        }
        // Loose top-level widget (legacy + back-compat). Renders
        // directly without a section wrapper.
        {
          const m = deriveWidgetMeta(entry.node.meta)
          return (
            <Fragment key={entry.node.id}>
              <WidgetStyleWrap style={m.outerStyle} htmlId={m.htmlId}>
                {renderBlock(
                  entry.node.blockType,
                  entry.node.data,
                  { media, projects, posts, postsLoop, csrf, project, preview },
                  undefined,
                  m.outerClass,
                  entry.node.id,
                )}
              </WidgetStyleWrap>
            </Fragment>
          )
        }
      })}
    </>
  )
}
