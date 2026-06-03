import 'server-only'
import { Suspense } from 'react'
import nextDynamic from 'next/dynamic'
import { canEdit, type AdminSession } from '@/lib/auth/getSession'
import { BlockTreeRenderer } from './BlockTreeRenderer'
import { EditModeEmptyState } from './EditModeEmptyState'
import { EditModePill } from './EditModePill'
import { OutlinePanel } from './OutlinePanel'
import { WidgetPicker } from './WidgetPicker'
import { ToastProvider } from './Toast'
import { SelectionProvider } from './SelectionContext'
import { SaveStatusIndicator } from './SaveStatusIndicator'
import type {
  HydratedBlock,
  HydratedMedia,
  HydratedProject,
  HydratedPost,
} from '@/lib/cms/hydrate'
import type { RenderContext } from '@/components/blocks'
import { getEditorAiSnapshot } from '@/lib/cms/getEditorAiSnapshot'

// Single edit-mode shell shared by every public-page render path
// (home `/`, dynamic `/{slug}`, and the legacy `/contact` template
// route via cmsPage.tsx). Centralising the shell:
//   1. Removes the triple-duplicated wiring of BlockTreeRenderer +
//      EditModeEmptyState + EditModePill + OutlinePanel + provider
//      chain that previously lived in three files in lock-step.
//   2. Closes the implicit cmsPage.tsx bug where MediaPickerProvider
//      wrapped the tree without ToastProvider — any toast call from
//      inside a click-to-edit gesture on `/contact` would crash the
//      provider context. The shell now wraps both consistently.
//   3. Lets Chunk C add section/column edit chrome in ONE place
//      rather than synchronising three diffs.
//
// Chunk B split the renderer in two:
//   - Anonymous / non-editable: BlockTreeRenderer (server-only, no
//     client bundle cost) emits pure HTML through the shared
//     `renderShell` primitives.
//   - Active editor: EditableBlockTreeRenderer (client) mirrors the
//     same shape and reads from InlineEditContext so DnD reorders,
//     drawer previews, and inline-edit saves paint optimistically.
//
// MediaPickerProvider + EditModeDndShell + EditableBlockTreeRenderer
// are dynamic-imported so signed-out visitors + admins-without-edit-
// mode-on never pay the bundle cost. Only the active edit surface
// loads them.
const MediaPickerProvider = nextDynamic(() =>
  import('./MediaPickerProvider').then((m) => m.MediaPickerProvider),
)

const EditModeDndShell = nextDynamic(() =>
  import('./EditModeDndShell').then((m) => m.EditModeDndShell),
)

const EditableBlockTreeRenderer = nextDynamic(() =>
  import('./EditableBlockTreeRenderer').then(
    (m) => m.EditableBlockTreeRenderer,
  ),
)

const InlineEditProvider = nextDynamic(() =>
  import('./InlineEditContext').then((m) => m.InlineEditProvider),
)

// Chunk H: dynamic-import the right-click context menu provider. Same
// pay-only-when-active pattern as the dnd shell + media picker — anonymous
// visitors + admins-without-edit-mode-on never load the menu code.
const ContextMenuProvider = nextDynamic(() =>
  import('./ContextMenuProvider').then((m) => m.ContextMenuProvider),
)

// Chunk I: slash-command + ⌘K palette provider. Same dynamic-import
// pattern — palette/inline picker code only ships to active editors.
const SlashCommandProvider = nextDynamic(() =>
  import('./SlashCommandProvider').then((m) => m.SlashCommandProvider),
)

// Chunk J: undo/redo stack provider + keyboard controller. Stack lives
// in-memory per editor session (wiped on reload) — long-tail history
// is the server-side audit log (Chunk B), not this stack. Same dynamic-
// import pattern; non-editor mounts pay no bundle cost.
const UndoStackProvider = nextDynamic(() =>
  import('./UndoStackProvider').then((m) => m.UndoStackProvider),
)
const UndoRedoController = nextDynamic(() =>
  import('./UndoRedoController').then((m) => m.UndoRedoController),
)

// AI sparkle session provider — orchestrates the SSE stream + apply/
// dismiss POSTs for the inline AI sparkle. Dynamic-imported so non-
// editor mounts (anonymous visitors, admins with edit mode off) don't
// ship the streaming parser + the AI tab UI in their bundle.
const AiSparkleSessionProvider = nextDynamic(() =>
  import('./AiSparkleSessionContext').then((m) => m.AiSparkleSessionProvider),
)

// PR 4 — Page Assistant chatbot. Same dynamic-import pattern as the
// sparkle session provider; the floating button + panel only ship to
// active editors with chatEnabled + key on file + a chat model picked.
const PageAssistantIfEnabled = nextDynamic(() =>
  import('./PageAssistant').then((m) => m.PageAssistantIfEnabled),
)

// Chunk J: section-template gallery. Mounted at editor root so the
// three entry points (slash palette "Templates" item, OutlinePanel
// AddBlockMenu button, EditModeEmptyState secondary CTA) open the
// same modal instance.
const SectionTemplateGalleryHost = nextDynamic(() =>
  import('./SectionTemplateGalleryHost').then(
    (m) => m.SectionTemplateGalleryHost,
  ),
)

interface Props {
  pageId: number
  pageVersion: number
  blocks: HydratedBlock[]
  media: Map<number, HydratedMedia>
  projects: Map<number, HydratedProject>
  posts: Map<number, HydratedPost>
  // Blog Loop slice — see RenderContext.postsLoop. Threaded into both
  // renderer branches so a loop-mode lx_posts block renders its paginated
  // page on the public surface and a page-1 preview in the editor canvas.
  // Undefined on pages without a loop block.
  postsLoop?: RenderContext['postsLoop']
  // Posts-widget card lists keyed by block id (self-contained sources) —
  // see RenderContext.postCardsByBlock. Threaded into both renderer branches
  // so a posts widget renders its own slice on the public surface and in the
  // editor canvas. Undefined on pages without a self-contained widget.
  postCardsByBlock?: RenderContext['postCardsByBlock']
  session: AdminSession | null
  editable: boolean
  // Optional preview-mode marker — emits `data-preview="1"` on `<main>`
  // for the dynamic-route preview branch. Defaults to false. Also
  // threaded into RenderContext.preview so the project lead-form blocks
  // suppress live submission during admin QA of an unpublished project.
  preview?: boolean
  // Singular project context — set only by the project detail route
  // (app/projects/[slug]) when it renders a migrated project's block
  // tree. Threaded into RenderContext.project so the project block
  // renderers resolve the project row (hero name/status, lead-form
  // scoping, brochure gate). Undefined for every non-project page.
  project?: RenderContext['project']
  // When false, the EditModeEmptyState CTA is suppressed for empty
  // pages. cmsPage.tsx kept the legacy "render nothing for empty"
  // behaviour; defaults to true so home + dynamic routes get the
  // bootstrap surface.
  showEmptyState?: boolean
  // Route-specific content emitted at the top of `<main>` (JSON-LD
  // <script> tags, breadcrumb microdata, etc). Each route owns its own
  // entity LD — the shell stays out of SEO concerns.
  children?: React.ReactNode
  /** Public preCsrf nonce. Minted in `renderCmsPage()` only when the
   *  block tree contains a form-bearing block (today: `contact_form`).
   *  Threaded through both renderer branches so the form can submit
   *  to /api/leads/contact without a separate client-side mint round
   *  trip. Undefined for pages with no public form. */
  csrf?: string
  /** Active theme palette mode (FIX 3) — see RenderContext.themeMode. Resolved
   *  in hydrate.ts only when the page tree has an lx_posts block. Threaded into
   *  both renderer branches so a posts widget in a no-bg section on a dark theme
   *  reads light-on-dark. Undefined on pages with no posts widget. */
  themeMode?: RenderContext['themeMode']
}

export async function EditableMain(p: Props) {
  const showEmpty = p.showEmptyState ?? true
  const isEditor = canEdit(p.session)
  // Editor-only: resolve the AI snapshot once at render so the inline
  // sparkle button can read it from context without a per-block fetch.
  // Anonymous + admin-without-edit-mode mounts skip the lookup — they
  // never render the sparkle either way.
  const aiSnapshot = p.editable ? await getEditorAiSnapshot() : null

  // Branch the renderer choice early. The non-editable path stays on
  // the server-only BlockTreeRenderer so anonymous visitors never load
  // the client tree code. The editable path uses the client mirror
  // which reads blocks from InlineEditContext for optimistic UI.
  const treeContent = p.editable ? (
    <EditableBlockTreeRenderer
      pageId={p.pageId}
      media={p.media}
      projects={p.projects}
      posts={p.posts}
      postsLoop={p.postsLoop}
      postCardsByBlock={p.postCardsByBlock}
      csrf={p.csrf}
      project={p.project}
      preview={p.preview}
      themeMode={p.themeMode}
    />
  ) : (
    <BlockTreeRenderer
      blocks={p.blocks}
      media={p.media}
      projects={p.projects}
      posts={p.posts}
      postsLoop={p.postsLoop}
      postCardsByBlock={p.postCardsByBlock}
      csrf={p.csrf}
      project={p.project}
      preview={p.preview}
      themeMode={p.themeMode}
    />
  )

  const overlays = (
    <>
      {p.editable && showEmpty && p.blocks.length === 0 && (
        <EditModeEmptyState pageId={p.pageId} />
      )}
      {isEditor && <EditModePill on={p.editable} />}
      {p.editable && <SaveStatusIndicator />}
      {p.editable && (
        <>
          <OutlinePanel
            pageId={p.pageId}
            initial={p.blocks.map((b) => ({
              id: b.id,
              blockKey: b.blockKey,
              blockType: b.blockType,
              version: b.version,
              // kind + parentId let OutlinePanel build the section →
              // column → widget tree so reorders are sibling-only.
              // Without these fields the panel falls back to flat-list
              // arrayMove, which the API rejects with
              // column_parent_must_be_section / cross_parent_reorder.
              kind: b.kind,
              parentId: b.parentId,
            }))}
          />
          {/* WidgetPicker — left-pinned, separate floating panel.
             Mounted alongside the right-pinned OutlinePanel so the
             two surfaces are independent: operators can dismiss the
             outline (X button) without losing widget creation. The
             admin-bar "Outline" pill (edit-mode-only) brings the
             outline back. */}
          <WidgetPicker pageId={p.pageId} />
          {/* PR 4 — Page Assistant chatbot. The component reads
             ai_config from InlineEditContext via useAiSnapshot() and
             returns null when chat is disabled / key missing / model
             unpicked, so this mount is safe even on tenants that
             haven't enabled AI. session?.userId is guaranteed by the
             `editable` branch — `editable` implies signed in. */}
          {p.session && (
            <PageAssistantIfEnabled pageId={p.pageId} />
          )}
        </>
      )}
    </>
  )

  const main = (
    <main
      // `data-page-id` is the admin-bar's page-context hook. Gated on
      // `isEditor` (admin/editor session) so anonymous visitors don't
      // ship the row PK in their HTML; admins-without-edit-mode-on
      // still get it for the admin-bar lookup.
      //
      // IMPORTANT: `isEditor === canEdit(p.session)` reads ONLY the
      // session role, NOT the edit-mode cookie. The attribute is
      // therefore available the moment an admin signs in — flipping
      // the edit-mode cookie via the EditModePill does NOT need to
      // wait for the data-page-id to appear (EditModePill already
      // triggers router.refresh() to swap the renderer; data-page-id
      // was on the wire before that refresh too).
      data-page-id={isEditor ? p.pageId : undefined}
      data-preview={p.preview ? '1' : undefined}
    >
      {p.editable ? (
        // Editor surface: provider holds the optimistic block tree;
        // DnD shell consumes context for reorder dispatches; the
        // EditableBlockTreeRenderer + every EditableSection / Column /
        // Block / EditDrawer / InlineEditable inside it reads from
        // the same context for previews + version cursors.
        <InlineEditProvider
          initialBlocks={p.blocks}
          initialPageVersion={p.pageVersion}
          aiSnapshot={aiSnapshot}
        >
          <AiSparkleSessionProvider>
          {/* SelectionProvider — per-page persistent "selected block"
              cursor. Sits INSIDE InlineEditProvider so it survives
              router.refresh() reconciliation and stays scoped per page;
              sits OUTSIDE the dnd / context-menu / slash providers so
              every mutation surface (toolbar verbs, drawer save, DnD)
              reads the same selection api via useSelection(). */}
          <SelectionProvider pageId={p.pageId}>
            {/* Chunk J — undo stack provider. Sits ABOVE the slash + dnd
                + context-menu providers so every mutation surface can
                record its inverse via useRecordCommand. Sits INSIDE
                InlineEditProvider so the upcoming Phase-2 "undo with
                optimistic state preview" can read from both contexts. */}
            <UndoStackProvider>
              {/* Chunk H — context menu provider sits INSIDE InlineEditProvider
                  so it can read the clipboard slot + dispatch clipboard:set.
                  Sits OUTSIDE EditModeDndShell so a right-click during an
                  active drag (vanishingly rare but possible) doesn't get
                  swallowed by the dnd-kit drag overlay. */}
              <ContextMenuProvider>
                {/* Chunk J — gallery host MUST wrap the slash + ⌘K
                    provider, NOT the other way round. The provider
                    renders <SlashCommandPalette> and <SlashCommandInline>
                    as its own children — both call useSectionTemplateGallery
                    to expose the "Templates…" entry. If the host sits
                    INSIDE the provider, the palette mounts OUTSIDE the
                    host and the hook throws → page-level error boundary
                    ("Something interrupted the page."). Audit finding E1
                    (Chunk K). The host now wraps BOTH the slash provider
                    and the dnd shell, so every consumer — palette, inline
                    popover, OutlinePanel button, EmptyState CTA — finds
                    the gallery context. */}
                <SectionTemplateGalleryHost pageId={p.pageId}>
                  {/* Chunk I — slash + ⌘K palette provider. Sits inside
                      the context-menu + gallery hosts so / and ⌘K share
                      the same focus-restore semantics + can never both be
                      open at once (global keydown listener gates each
                      other off). */}
                  <SlashCommandProvider pageId={p.pageId}>
                    <EditModeDndShell pageId={p.pageId}>
                      {p.children}
                      <Suspense fallback={null}>{treeContent}</Suspense>
                      {overlays}
                    </EditModeDndShell>
                    <UndoRedoController />
                  </SlashCommandProvider>
                </SectionTemplateGalleryHost>
              </ContextMenuProvider>
            </UndoStackProvider>
          </SelectionProvider>
          </AiSparkleSessionProvider>
        </InlineEditProvider>
      ) : (
        <>
          {p.children}
          {treeContent}
          {overlays}
        </>
      )}
    </main>
  )
  if (!isEditor) return main
  return (
    <ToastProvider>
      <MediaPickerProvider>{main}</MediaPickerProvider>
    </ToastProvider>
  )
}
