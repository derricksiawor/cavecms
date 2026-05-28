'use client'

import { Fragment, useMemo } from 'react'
import { renderBlock } from '@/components/blocks'
import type {
  HydratedBlock,
  HydratedMedia,
  HydratedProject,
} from '@/lib/cms/hydrate'
import { buildBlockTree } from '@/lib/cms/blockTree'
import {
  htmlIdForBlock,
  parseSectionMeta,
  parseWidgetMeta,
  visibilityClasses,
  type SectionMeta,
} from '@/lib/cms/blockMeta'
import { spacingClass, spacingStyle } from '@/lib/cms/spacingClasses'
import clsx from 'clsx'
import {
  isInlineEditableBlock,
  type InlineEditContext as WidgetInlineEditContext,
} from '@/lib/cms/inlineEditableFields'
import { EditableBlock } from './EditableBlock'
import { EditableColumn } from './EditableColumn'
import { EditableSection } from './EditableSection'
import { InsertBlockHere } from './InsertBlockHere'
import { InsertSectionHere } from './InsertSectionHere'
import { TopLevelSortable } from './SortableContainers'
import { ColumnFrame, SectionFrame, readSectionBackground } from './renderShell'
import {
  useEffectiveBlockMeta,
  useEffectivePreview,
  useEffectiveVersions,
  useInlineEditState,
} from './InlineEditContext'

// Client mirror of BlockTreeRenderer (Chunk B). Reads the live block
// tree from InlineEditContext instead of taking it via props, so the
// edit surface paints from optimistic state — DnD reorders, drawer
// previews, and inline-edit saves all reflect immediately without
// waiting for a router.refresh round-trip.
//
// Layout shape (the <section> + grid + column stacks) is delegated
// to the shared `renderShell` primitives so anonymous and editable
// renders emit the SAME wrapper HTML. The only difference is the
// editable shells (EditableSection / EditableColumn / EditableBlock)
// + the InsertSectionHere / InsertBlockHere affordances + the
// TopLevelSortable wrapper for DnD.
//
// `data-section-id` / `data-column-id` are exposed on the editable
// surface so admin tooling (the OutlinePanel, future scroll-into-view
// gestures) can target specific rows. Anonymous renders elide them
// for info-disclosure hardening (see BlockTreeRenderer).
//
// Chunk E: section + column meta reads through useEffectiveBlockMeta
// so the SpacingToolbar's set-preview overlay merges on top of the
// persisted blob — the operator sees the per-side change the instant
// they click a stepper. Widget meta uses the same hook (widgets carry
// only spacing meta in Chunk E, so the overlay is spacing-only) and
// the resulting blob feeds spacingClass(parseWidgetMeta(...)) into
// renderBlock's outerClass arg.

interface Props {
  pageId: number
  media: Map<number, HydratedMedia>
  projects: Map<number, HydratedProject>
  /** Public preCsrf nonce minted in `renderCmsPage()`. Threaded through
   *  RenderContext to blocks that need it (today: `contact_form`).
   *  Undefined when no such block is on the page. */
  csrf?: string
}

export function EditableBlockTreeRenderer({
  pageId,
  media,
  projects,
  csrf,
}: Props) {
  const state = useInlineEditState()
  // Memoise tree + topIds against state.blocks identity. The reducer
  // preserves state.blocks reference when only previews/versionOverrides/
  // clipboard change (see the no-op guards in InlineEditContext reducer),
  // so on every keystroke that dispatches set-preview the tree doesn't
  // need to be rebuilt — only on actual block mutations. Pre-memo this
  // ran O(blocks) per keystroke; now it runs only on real change.
  const tree = useMemo(() => buildBlockTree(state.blocks), [state.blocks])
  const topIds = useMemo(
    () =>
      tree.map((n) =>
        n.kind === 'section' ? n.node.section.id : n.node.id,
      ),
    [tree],
  )

  if (tree.length === 0) {
    // Empty page still gets the "+ Add section" affordance so the
    // operator can bootstrap a section without going through the
    // EditModeEmptyState card. The card stays for the legacy
    // widget-first path (mounted by EditableMain when blocks.length
    // is zero).
    return <InsertSectionHere pageId={pageId} afterBlockId={null} />
  }

  return (
    <TopLevelSortable items={topIds}>
      <>
        {/* Affordance BEFORE the first top-level entry. beforeBlockId
            so the new section/widget lands at the HEAD; afterBlockId
            null would append-at-bottom (a regression flagged after
            Chunk A). */}
        <InsertSectionHere pageId={pageId} beforeBlockId={topIds[0]} />
        <InsertBlockHere pageId={pageId} beforeBlockId={topIds[0]} />
        {tree.map((entry) => {
          // entryId IS the trailing id for the after-pills — same source,
          // no need to re-index into topIds (which has identical length).
          const entryId =
            entry.kind === 'section' ? entry.node.section.id : entry.node.id
          return (
            <Fragment key={entryId}>
              {entry.kind === 'section' ? (
                <EditableSectionSlot
                  section={entry.node.section}
                  columns={entry.node.columns}
                  pageId={pageId}
                  pageVersion={state.pageVersion}
                  media={media}
                  projects={projects}
                  csrf={csrf}
                />
              ) : (
                <EditableWidgetSlot
                  block={entry.node}
                  parentBlockId={null}
                  pageId={pageId}
                  pageVersion={state.pageVersion}
                  media={media}
                  projects={projects}
                  csrf={csrf}
                />
              )}
              <InsertSectionHere pageId={pageId} afterBlockId={entryId} />
              <InsertBlockHere pageId={pageId} afterBlockId={entryId} />
            </Fragment>
          )
        })}
      </>
    </TopLevelSortable>
  )
}

interface SectionSlotProps {
  section: HydratedBlock
  columns: { column: HydratedBlock; widgets: HydratedBlock[] }[]
  pageId: number
  pageVersion: number
  media: Map<number, HydratedMedia>
  projects: Map<number, HydratedProject>
  csrf?: string
}

function EditableSectionSlot({
  section,
  columns,
  pageId,
  pageVersion,
  media,
  projects,
  csrf,
}: SectionSlotProps) {
  // Live-preview overlay for the section's meta. The drawer pushes
  // background / padding tweaks here so the operator sees the CSS
  // flip the instant they pick a swatch. Chunk E: the SpacingToolbar
  // dispatches into the SAME overlay map with a SpacingMeta payload,
  // and SectionFrame's spacingClass() picks up the tier classes.
  const effectiveMeta = useEffectiveBlockMeta(section.id, section.meta)
  const sectionBackground = readSectionBackground(effectiveMeta)
  // Memoise columnIds — same rationale as widgetIds in EditableColumnSlot:
  // SortableContext identity-diffs `items` and benefits from a stable ref.
  const columnIds = useMemo(
    () => columns.map((c) => c.column.id),
    [columns],
  )
  return (
    <EditableSection
      blockId={section.id}
      initialMeta={section.meta}
      initialVersion={section.version}
      pageId={pageId}
      pageVersion={pageVersion}
      columnCount={columns.length}
      columnIds={columnIds}
    >
      <SectionFrame
        meta={effectiveMeta}
        columnCount={columns.length}
        sectionId={section.id}
        exposeId
        media={media}
      >
        {columns.map((col) => (
          <EditableColumnSlot
            key={col.column.id}
            column={col.column}
            widgets={col.widgets}
            pageId={pageId}
            pageVersion={pageVersion}
            sectionBackground={sectionBackground}
            parentSectionId={section.id}
            parentSectionMeta={parseSectionMeta(section.meta)}
            media={media}
            projects={projects}
            csrf={csrf}
          />
        ))}
      </SectionFrame>
    </EditableSection>
  )
}

interface ColumnSlotProps {
  column: HydratedBlock
  widgets: HydratedBlock[]
  pageId: number
  pageVersion: number
  sectionBackground: ReturnType<typeof readSectionBackground>
  parentSectionId: number
  /** Full section meta — threaded to widget renderers so they can
   *  derive their visual theme from the ancestor surface. Carrying the
   *  whole meta (not just background) lets `isSectionSurfaceDark` see
   *  the cover-photo + dark-overlay heroes too, where the bg colour
   *  alone underreports darkness. */
  parentSectionMeta: SectionMeta
  media: Map<number, HydratedMedia>
  projects: Map<number, HydratedProject>
  csrf?: string
}

function EditableColumnSlot({
  column,
  widgets,
  pageId,
  pageVersion,
  sectionBackground,
  parentSectionId,
  parentSectionMeta,
  media,
  projects,
  csrf,
}: ColumnSlotProps) {
  // Memoise widgetIds against the widgets array identity. EditableColumn
  // passes this into the per-column SortableContext as the `items` prop —
  // dnd-kit identity-diffs `items` and on a churning array (fresh per
  // render) re-syncs the per-column sortable indices, which manifests as
  // jittery drop indicators + sometimes-missed activation distances. The
  // widgets array itself is rebuilt by buildBlockTree, which is now
  // memoised — so widgets identity is stable when content doesn't change.
  const widgetIds = useMemo(() => widgets.map((w) => w.id), [widgets])
  // Chunk E: column meta now carries per-side spacing on top of the
  // existing width. Drawer-preview parity with sections — the column's
  // EditDrawer + the SpacingToolbar both dispatch set-preview, and
  // ColumnFrame derives the spacing class from the merged blob.
  const effectiveColumnMeta = useEffectiveBlockMeta(column.id, column.meta)
  return (
    <EditableColumn
      blockId={column.id}
      initialMeta={column.meta}
      initialVersion={column.version}
      pageId={pageId}
      pageVersion={pageVersion}
      hasWidgets={widgets.length > 0}
      sectionBackground={sectionBackground}
      parentSectionId={parentSectionId}
      widgetIds={widgetIds}
    >
      <ColumnFrame
        columnId={column.id}
        exposeId
        meta={effectiveColumnMeta}
        media={media}
      >
        {widgets.length > 0 && (
          <InsertBlockHere
            pageId={pageId}
            parentId={column.id}
            beforeBlockId={widgetIds[0]}
          />
        )}
        {widgets.map((w, i) => (
          <Fragment key={w.id}>
            <EditableWidgetSlot
              block={w}
              parentBlockId={column.id}
              pageId={pageId}
              pageVersion={pageVersion}
              parentSectionMeta={parentSectionMeta}
              media={media}
              projects={projects}
              csrf={csrf}
            />
            <InsertBlockHere
              pageId={pageId}
              parentId={column.id}
              afterBlockId={widgetIds[i] ?? null}
            />
          </Fragment>
        ))}
      </ColumnFrame>
    </EditableColumn>
  )
}

interface WidgetSlotProps {
  block: HydratedBlock
  parentBlockId: number | null
  pageId: number
  pageVersion: number
  parentSectionMeta?: SectionMeta
  media: Map<number, HydratedMedia>
  projects: Map<number, HydratedProject>
  csrf?: string
}

function EditableWidgetSlot({
  block,
  parentBlockId,
  pageId,
  pageVersion,
  parentSectionMeta,
  media,
  projects,
  csrf,
}: WidgetSlotProps) {
  // Effective data: shallow-merge any pending drawer preview overlay
  // on top of the persisted block.data. When no preview is pending
  // this returns the persisted shape verbatim (no churn).
  //
  // `block.data` is typed `BlockData<T>` (Zod-parsed widget data), but
  // useEffectivePreview's signature expects `Record<string, unknown>` —
  // a runtime-equivalent shape. The defensive narrow at the boundary
  // (matches InlineEditable's unknown-input narrow) keeps the cast
  // honest without TypeScript bypass via `as unknown as`.
  const effectiveData = useEffectivePreview(
    block.id,
    (block.data &&
    typeof block.data === 'object' &&
    !Array.isArray(block.data)
      ? (block.data as unknown)
      : {}) as Record<string, unknown>,
  )
  // Chunk E: widget meta is spacing-only. The SpacingToolbar mounted by
  // EditableBlock dispatches set-preview with a SpacingMeta payload;
  // useEffectiveBlockMeta returns the merged blob. parseWidgetMeta
  // narrows to known spacing keys, so a stray data field that landed
  // in the preview map (defence in depth) is silently dropped.
  const effectiveMeta = useEffectiveBlockMeta(block.id, block.meta)
  // Memoise — every keystroke on ANY block re-renders this slot via
  // context churn; without the memo, parseWidgetMeta + spacingClass run
  // 8 if-checks each per widget per keystroke. Cheap individually,
  // O(N) under heavy editing.
  const parsedWidgetMeta = useMemo(
    () => parseWidgetMeta(effectiveMeta),
    [effectiveMeta],
  )
  const widgetSpacingClass = useMemo(
    () =>
      clsx(spacingClass(parsedWidgetMeta), visibilityClasses(parsedWidgetMeta)),
    [parsedWidgetMeta],
  )
  // Numeric (px) per-side spacing is applied via an inline-style wrap
  // around the widget render — keeps the dozens of per-block renderers
  // unchanged while still honouring arbitrary px values the operator
  // types in SpacingPopover.
  const widgetSpacingStyle = useMemo(
    () => spacingStyle(parsedWidgetMeta),
    [parsedWidgetMeta],
  )
  const widgetHtmlId = htmlIdForBlock(parsedWidgetMeta)
  // Effective version cursor — picks up any post-save override so a
  // sibling InlineEditable on this block sees the freshest token
  // without waiting for the server's tree refresh.
  const versions = useEffectiveVersions(block.id, {
    blockVersion: block.version,
    pageVersion,
  })
  // Memoise the inlineEdit object — without this it's freshly allocated
  // every render and threaded into renderBlock(), where every nested
  // InlineEditable receives a new prop identity on every parent re-
  // render (every InlineEditContext dispatch — set-preview per keystroke).
  // That defeats InlineEditable's own arrayIndicesKey + version-cursor
  // memos which all depend on the identity of this object.
  const inlineEdit: WidgetInlineEditContext | undefined = useMemo(() => {
    if (!isInlineEditableBlock(block.blockType)) return undefined
    return {
      blockId: block.id,
      blockVersion: versions.blockVersion,
      pageId,
      pageVersion: versions.pageVersion,
    }
  }, [
    block.blockType,
    block.id,
    versions.blockVersion,
    pageId,
    versions.pageVersion,
  ])
  const node = renderBlock(
    block.blockType,
    effectiveData,
    { media, projects, csrf },
    inlineEdit,
    widgetSpacingClass,
    block.id,
    'edit',
    parentSectionMeta,
  )
  // initialData passes the PERSISTED shape (block.data, not the
  // preview-merged effectiveData) downstream to EditableBlock →
  // EditDrawer's initialSerialized + dirty baseline. The drawer's
  // own preview overlay carries the in-flight typing; conflating
  // the dirty baseline with the live overlay would (a) churn
  // initialSerialized's JSON.stringify on every keystroke, and (b)
  // semantically mislabel "persisted-at-mount" as "the latest
  // preview." Canvas rendering still uses effectiveData via the
  // renderBlock above.
  return (
    <EditableBlock
      blockId={block.id}
      blockType={block.blockType}
      blockKey={block.blockKey}
      initialData={block.data}
      initialMeta={block.meta}
      initialVersion={versions.blockVersion}
      pageId={pageId}
      pageVersion={versions.pageVersion}
      parentBlockId={parentBlockId}
    >
      {widgetSpacingStyle || widgetHtmlId ? (
        <div style={widgetSpacingStyle} id={widgetHtmlId}>
          {node}
        </div>
      ) : (
        node
      )}
    </EditableBlock>
  )
}
