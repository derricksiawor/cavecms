'use client'

// Chunk H — Declarative action registry for the editor's right-click
// context menu. ONE source of truth for "what does right-clicking a
// section / column / widget show + do". The ContextMenu component
// renders from this registry; the ContextMenuProvider builds the
// MenuContext at right-click time and routes activations through here.
//
// Each MenuItem is a self-contained handler — the handler calls
// csrfFetch to the existing API endpoints (POST /api/cms/blocks for
// add/widget paste, POST /api/cms/blocks/[id]/duplicate for duplicate,
// DELETE /api/cms/blocks/[id] for remove, POST /api/cms/blocks/reorder
// for move) OR delegates to a ctx-provided callback for UI-only actions
// (Edit drawer open, Spacing toolbar open, Add widget popover open).
//
// Adding a new action is one entry in MENU_ITEMS_BY_KIND[<kind>]. Adding
// a new kind is one Record key. Adding a new disabled() predicate is
// one closure. No per-kind components, no parallel switch statements.
//
// ─────────────────────────────────────────────────────────────────────
// REFERENCE: source mental models, captured from a 5-builder audit
// (Elementor, Webflow, Wix Studio, Framer, Figma) so future maintainers
// see WHY each verb is here without re-running the research.
//
// Elementor (WordPress)
//   Groups: general → addNew → clipboard → save → tools → delete.
//   Section: Edit | Duplicate | Copy | Paste | Paste Style | Reset Style
//            | Save as Template | Navigator | Delete.
//   Hijacks richtext right-click; Ctrl/Cmd+Right-Click for OS menu.
//   Clipboard: in-memory + window.localStorage. Cross-site paste via
//   manual JSON copy.
//
// Webflow
//   Single element menu (no kind discrimination). Copy | Cut | Paste |
//   Paste Before/After | Duplicate | Pick Parent | Wrap | Hide | Delete.
//   Cedes right-click inside Rich Text Block edit mode to the browser.
//   Clipboard: system clipboard with custom MIME type — cross-tab,
//   cross-site (between Webflow Designers) works.
//
// Wix Studio (and legacy Editor X)
//   Cut | Copy | Paste | Duplicate | Copy Design | Paste Design |
//   Arrange ▸ | Pin to Screen ▸ | Attach to Container | Overlapping
//   Items ▸ | Show on All Pages | Delete.
//   Cedes richtext right-click to OS.
//   Clipboard: in-memory + cloud-scoped per Wix account (cross-tab,
//   not cross-account).
//
// Framer
//   Edit | Cut | Copy | Copy as Code | Paste | Paste & Match Style |
//   Duplicate | Create Component | Detach Instance | Frame/Group/Ungroup
//   | Arrange | Lock | Hide | Rename | Delete.
//   Cedes Text-layer edit-mode right-click to the browser.
//   Clipboard: system clipboard with custom MIME + text/plain fallback.
//
// Figma (reference, not a builder)
//   Copy | Cut | Paste over Selection | Paste to Replace | Duplicate |
//   Copy/Paste as ▸ | Copy Properties | Select Layer ▸ | Select All
//   With Same… ▸ | Frame/Group/Ungroup | Arrange | Flip/Rotate |
//   Create Component | Detach | Show/Hide | Lock | Rename | Delete.
//   Cedes Text-layer edit-mode right-click to the browser.
//   Clipboard: dual-write system clipboard (text/plain + text/html
//   with base64 .fig metadata) — cross-tab + cross-app.
//
// Common patterns CaveCMS adopts:
//   - Edit-first verb (operator's most-common gesture sits at the top)
//   - Group separators: structural / clipboard / destructive
//   - Right-aligned dim keyboard hints (⌘D, ⌘C, ⌫)
//   - Cede right-click to OS when caret is inside an InlineEditable
//     richtext — each Editable*'s onContextMenu skips when
//     `e.target.closest('[data-inline-editing="true"]')` matches.
//     The provider has NO document-level listener; the boundary check
//     lives in each surface's handler (see EditableBlock.tsx etc.).
//   - In-memory clipboard scoped per session (Wix-style, NOT
//     Elementor-style + localStorage which would survive across
//     sessions and risk pasting stale-schema data after a deploy)
// ─────────────────────────────────────────────────────────────────────

import {
  Settings,
  Copy,
  ArrowUpToLine,
  ArrowDownToLine,
  Columns3,
  Move,
  Clipboard as ClipboardIcon,
  ClipboardPaste,
  BookmarkPlus,
  Trash2,
  Pencil,
  ArrowUp,
  ArrowDown,
  Plus,
  Maximize2,
  type LucideIcon,
} from 'lucide-react'

import { csrfFetch } from '@/lib/client/csrf'
import { sanitizeSavedBlockName } from './savedBlocks'
import {
  CLIPBOARD_SCHEMA_VERSION,
  canPaste,
  type ClipboardColumn,
  type ClipboardSlot,
} from './clipboard'
import {
  MAX_SECTION_COLUMNS,
  type BlockKind,
} from './blockMeta'
import type { EditDrawerTab } from './editDrawerTabs'

// ─── Types ──────────────────────────────────────────────────────────

// EditDrawerTab is re-exported below so existing imports of this module
// don't need to update their import path. The canonical definition
// lives in lib/cms/editDrawerTabs.ts — adding a tab updates that file
// AND the tabForShape routing in EditDrawer.tsx.
export type { EditDrawerTab }

export interface MenuToastApi {
  /** Chunk J — optional action slot mirrors the underlying Toast.tsx
   *  signature so right-click action success toasts can carry an
   *  inline Undo button. Earlier draft typed it as message-only and
   *  the action was lost through structural narrowing. */
  success: (
    message: string,
    action?: { label: string; onClick: () => void },
  ) => void
  error: (message: string) => void
  info: (message: string) => void
}

/**
 * Context passed to every MenuItem handler at activation time. The
 * ContextMenuProvider builds this when right-click lands on an Editable*
 * surface — the Editable component contributes its identity + the
 * UI callbacks (openEditDrawer, openSpacingToolbar, openAddWidget) so
 * the registry stays stateless and re-usable for any future container.
 */
export interface MenuContext {
  // ── Identity of the right-clicked block ──
  kind: BlockKind
  blockId: number
  /** Literal block_type — 'section' / 'column' for containers, widget's
   *  registered block_type for widgets ('heading', 'image', etc.). */
  blockType: string
  parentId: number | null
  pageId: number
  blockVersion: number
  pageVersion: number
  /** Persisted data payload (widget only — sections/columns have data='{}'). */
  data: unknown
  /** Persisted meta payload (section/column carry settings; widget carries
   *  spacing-only in Chunk E). */
  meta: unknown

  // ── Container-only info ──
  /** Section: number of living columns under this section. Drives the
   *  Add column / Duplicate column cap predicate. Undefined for column
   *  + widget kinds. */
  columnCount?: number

  // ── Clipboard ──
  clipboard: ClipboardSlot | null
  setClipboard: (slot: ClipboardSlot) => void
  /** Section-only — return the live subtree (columns + widgets) for
   *  the right-clicked block. Read at copy time so the slot carries
   *  the actual persisted shape, not a stale snapshot. The provider
   *  injects this from useInlineEditState().blocks; when undefined
   *  (consumer wired without the callback / regression guard), the
   *  copy still succeeds but the section pastes as an empty shell. */
  getSectionSubtree?: (
    sectionId: number,
  ) => { columns: ClipboardColumn[]; widgetCount: number }

  // ── Chunk J — undo stack recorder ──
  // Provided by ContextMenuProvider via useRecordCommand. The
  // duplicate / paste / delete handlers below record their inverse on
  // success so the operator can ⌘Z them. Same shape used by the
  // toolbar / drawer call sites — see lib/cms/undoStack.ts.
  recordCommand: (cmd: import('@/lib/cms/undoStack').Command) => void
  /** Inline-Undo runner — same path as ⌘Z. Used by toast action onClick
   *  handlers in the menu actions so cursor management stays
   *  consistent. */
  runUndo: () => void

  // ── Provider helpers ──
  closeMenu: () => void
  refresh: () => void
  toast: MenuToastApi
  confirmDelete: (opts: {
    title: string
    description: string
    confirmLabel?: string
  }) => Promise<boolean>

  // ── UI callbacks provided by the Editable* component at right-click time ──
  /** Opens this block's EditDrawer. The optional initialTab routes to
   *  the Style / Advanced tab for "Spacing" / "Set column width" verbs;
   *  defaults to Content. */
  openEditDrawer: (initialTab?: EditDrawerTab) => void
  /** Widget-only: opens the floating SpacingToolbar popover anchored at
   *  this block. Undefined for section/column kinds (those route to
   *  EditDrawer Style tab instead). */
  openSpacingToolbar?: () => void
  /** Column-only: opens the InsertBlockHere popover at the bottom of
   *  this column. Undefined for section/widget kinds. */
  openAddWidget?: () => void
}

export interface MenuItem {
  /** Stable, unique id used as the React key + the audit fingerprint. */
  id: string
  label: string
  icon?: LucideIcon
  /** Right-aligned keyboard hint, e.g. "⌘D". Rendered in a dimmed mono
   *  font. Global keyboard handler for these shortcuts is NOT in chunk
   *  H — the hints communicate the gesture for the chunk that adds it. */
  kbdHint?: string
  /** Render a 1px hairline above this item. Used to group structural /
   *  clipboard / destructive verbs. The FIRST item's separatorAbove is
   *  ignored by the renderer. */
  separatorAbove?: boolean
  /** Destructive items render in red + skip the copper icon accent. */
  destructive?: boolean
  /** Predicate against the runtime ctx — returns true to disable.
   *  Called once when the menu opens; downstream re-evaluation requires
   *  a fresh menu show. */
  disabled?: (ctx: MenuContext) => boolean
  /** Async-safe handler. The menu closes IMMEDIATELY when the handler
   *  fires (ctx.closeMenu inside the handler); the handler then runs
   *  its network call + reports via ctx.toast / ctx.refresh. */
  handler: (ctx: MenuContext) => void | Promise<void>
}

// ─── Shared network helpers ─────────────────────────────────────────

interface JsonError {
  error?: string
}

// Server error code → operator-friendly toast string. Anything not in
// this map falls through to the generic "we couldn't complete" message
// — keeps raw codes (`stale_version`, `position_gap_exhausted`, etc.)
// from surfacing in user-facing toasts. New 4xx/5xx codes added to
// server routes should land here too.
const SERVER_ERROR_COPY: Record<string, string> = {
  not_found:
    "We can't find that anymore — it may have been removed. Refreshing to sync.",
  page_not_found: 'This page no longer exists. Refreshing to sync.',
  stale_block_version:
    'Someone else changed this. Refresh to see the latest version.',
  stale_page_version:
    'Someone else changed this page. Refresh to see the latest version.',
  stale_version:
    'Someone else changed this. Refresh to see the latest version.',
  column_count_exceeded: `This section is at the ${MAX_SECTION_COLUMNS}-column maximum.`,
  position_gap_exhausted:
    "We couldn't slot this in here — refresh and try again to re-space the row.",
  subtree_too_large:
    "That structure is too large to duplicate in one go — try duplicating its parts.",
  block_type_reserved_for_fixed_slot:
    "This block is part of the page template and can't be duplicated.",
  source_invalid:
    "This block's settings need updating before it can be duplicated.",
  cycle_detected:
    "We hit a data-integrity issue. The team has been notified.",
  cannot_delete_fixed_block:
    "This block is part of the page template and can't be removed.",
  drift:
    'Someone else changed this page. Refresh to see the latest order.',
  invalid_meta_json: 'That section/column has malformed settings.',
}

async function readJsonErr(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as JsonError
  const code = j.error
  if (code && code in SERVER_ERROR_COPY) {
    return SERVER_ERROR_COPY[code]!
  }
  return code ?? "We couldn't complete that action. Try again."
}

function toastNetworkError(toast: MenuToastApi, e: unknown): void {
  toast.error(
    e instanceof Error && e.name === 'AbortError'
      ? 'That took too long. Try again.'
      : "We can't reach the server right now. Try again in a moment.",
  )
}

async function duplicateBlockApi(ctx: MenuContext): Promise<void> {
  try {
    const res = await csrfFetch(
      `/api/cms/blocks/${ctx.blockId}/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageId: ctx.pageId }),
      },
    )
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      // 404 = source vanished mid-flight (peer deleted between menu
      // open and click). The operator's canvas still shows the source —
      // refresh to sync. Without this, they'd see a ghost block until
      // the next page-level action.
      if (res.status === 404) ctx.refresh()
      return
    }
    // ── Chunk J — record DUPLICATE on the undo stack ──
    // Forward: re-POST /duplicate (server returns new id on redo,
    // deriveRebind updates inverse path). Inverse: DELETE the newly-
    // duplicated id (children cascade via the soft-delete recursive
    // CTE for section / column duplicates).
    const body = (await res.json().catch(() => ({}))) as { id?: number }
    const newId = typeof body.id === 'number' ? body.id : null
    if (newId !== null) {
      ctx.recordCommand({
        kind: 'duplicate',
        label: 'Duplicated block',
        timestamp: Date.now(),
        forward: {
          method: 'POST',
          path: `/api/cms/blocks/${ctx.blockId}/duplicate`,
          body: { pageId: ctx.pageId },
          expects: 201,
        },
        inverse: {
          method: 'DELETE',
          path: `/api/cms/blocks/${newId}`,
          expects: 200,
        },
        captures: { newBlockId: newId, sourceBlockId: ctx.blockId },
      })
    }
    ctx.toast.success('Duplicated.', {
      label: 'Undo',
      onClick: () => ctx.runUndo(),
    })
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

// Prompt the operator for a saved-block name, sanitise, then POST to
// the saved-blocks library. Widget-only — sections/columns are a
// future tier (saved_blocks.kind ENUM has one entry today).
//
// window.prompt is the lightest path for an in-menu name capture (no
// portal, no focus-trap, no provider plumbing required). It's the same
// pattern MarkdownEditor uses for its link-paste affordance. A richer
// inline modal can land later without touching the API surface — the
// network shape stays identical.
//
// Toast surfaces success with a pointer at where to find the library
// ("Saved tab in the picker"). Errors map known server codes to user-
// friendly copy; unknown codes fall through to a generic retry message.
async function saveWidgetAsBlock(ctx: MenuContext): Promise<void> {
  if (typeof window === 'undefined') return
  // Default name suggestion — the widget's block_type with underscores
  // replaced + title-cased. Operator can overwrite. Keeps the prompt
  // immediately useful (one-Enter save) without sacrificing precision.
  const defaultName = ctx.blockType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 64)
  const raw = window.prompt(
    'Name this saved block (you can find it in the Saved tab of the widget picker):',
    defaultName,
  )
  if (raw === null) return // operator hit Cancel
  const cleaned = sanitizeSavedBlockName(raw)
  if (cleaned === '') {
    ctx.toast.error('Add a name so you can find it later.')
    return
  }
  try {
    const res = await csrfFetch('/api/cms/saved-blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: cleaned,
        blockType: ctx.blockType,
        data: ctx.data,
        meta:
          ctx.meta && typeof ctx.meta === 'object'
            ? ctx.meta
            : undefined,
      }),
    })
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (j.error === 'invalid_name') {
        ctx.toast.error("That name didn't work — try a shorter label.")
      } else if (j.error === 'unknown_block_type') {
        ctx.toast.error("This kind of block can't be saved yet.")
      } else if (j.error === 'invalid_request') {
        ctx.toast.error("This block's settings need updating before it can be saved.")
      } else {
        ctx.toast.error("We couldn't save that. Try again in a moment.")
      }
      return
    }
    ctx.toast.success('Saved to your library. Find it in the Saved tab.')
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

async function deleteBlockApi(ctx: MenuContext, noun: string): Promise<void> {
  try {
    const res = await csrfFetch(`/api/cms/blocks/${ctx.blockId}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      if (res.status === 404) ctx.refresh()
      return
    }
    // ── Chunk J — record DELETE on the undo stack ──
    // Right-click delete must offer parity with EditableBlock /
    // EditableSection / EditableColumn toolbar deletes — same undo
    // shape, same restore-cascade behavior for containers.
    // (Delta-review MEDIUM finding — right-click DELETE was the
    // only mutation gesture without undo coverage.)
    const isContainer = ctx.kind === 'section' || ctx.kind === 'column'
    const inverseBody = isContainer ? { cascade: true } : undefined
    ctx.recordCommand({
      kind: isContainer ? 'delete-container' : 'delete-widget',
      label: `Removed ${noun.toLowerCase()}`,
      timestamp: Date.now(),
      forward: {
        method: 'DELETE',
        path: `/api/cms/blocks/${ctx.blockId}`,
        expects: 200,
      },
      inverse: {
        method: 'POST',
        path: `/api/cms/blocks/${ctx.blockId}/restore`,
        body: inverseBody,
        expects: 200,
      },
      captures: { blockId: ctx.blockId, containerKind: ctx.kind },
    })
    ctx.toast.success(`${noun} removed.`, {
      label: 'Undo',
      onClick: () => ctx.runUndo(),
    })
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

async function addSiblingSection(
  ctx: MenuContext,
  placement: 'above' | 'below',
): Promise<void> {
  // The right-clicked section's id is used as the bisect anchor. Both
  // before/after lands the new section at the SAME parent level (top-
  // level — sections always have parentId=null).
  const body: Record<string, unknown> = {
    pageId: ctx.pageId,
    kind: 'section',
    withColumns: 1,
  }
  if (placement === 'above') body['beforeBlockId'] = ctx.blockId
  else body['afterBlockId'] = ctx.blockId
  try {
    const res = await csrfFetch('/api/cms/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      return
    }
    // ── Chunk J — record ADD on the undo stack ──
    // Right-click add must offer parity with the slash palette /
    // OutlinePanel / EmptyState add paths (all go through
    // useInsertBlock which records). Without this, operator's
    // right-click "Add section above" was undetectable to ⌘Z.
    const j = (await res.json().catch(() => ({}))) as { id?: number }
    const newId = typeof j.id === 'number' ? j.id : null
    if (newId !== null) {
      ctx.recordCommand({
        kind: 'add',
        label: `Added section ${placement} sibling`,
        timestamp: Date.now(),
        forward: {
          method: 'POST',
          path: '/api/cms/blocks',
          body,
          expects: 201,
        },
        inverse: {
          method: 'DELETE',
          path: `/api/cms/blocks/${newId}`,
          expects: 200,
        },
        captures: { newBlockId: newId, blockType: 'section' },
      })
    }
    ctx.toast.success(`Section added ${placement} this one.`, {
      label: 'Undo',
      onClick: () => ctx.runUndo(),
    })
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

async function addColumnApi(ctx: MenuContext): Promise<void> {
  if ((ctx.columnCount ?? 0) >= MAX_SECTION_COLUMNS) {
    ctx.toast.error(
      `This section is at the ${MAX_SECTION_COLUMNS}-column maximum.`,
    )
    return
  }
  const body = {
    pageId: ctx.pageId,
    kind: 'column',
    parentId: ctx.blockId,
    meta: {},
  }
  try {
    const res = await csrfFetch('/api/cms/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      return
    }
    // Chunk J — record ADD on the undo stack so the right-click
    // "Add column" gesture supports ⌘Z, in parity with the toolbar
    // add paths (delta-review MEDIUM finding).
    const j = (await res.json().catch(() => ({}))) as { id?: number }
    const newId = typeof j.id === 'number' ? j.id : null
    if (newId !== null) {
      ctx.recordCommand({
        kind: 'add',
        label: 'Added column',
        timestamp: Date.now(),
        forward: {
          method: 'POST',
          path: '/api/cms/blocks',
          body,
          expects: 201,
        },
        inverse: {
          method: 'DELETE',
          path: `/api/cms/blocks/${newId}`,
          expects: 200,
        },
        captures: { newBlockId: newId, blockType: 'column' },
      })
    }
    ctx.toast.success('Column added.', {
      label: 'Undo',
      onClick: () => ctx.runUndo(),
    })
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

/**
 * Read the current widget's siblings from the DOM, scoped to the same
 * parent_id. WIDGET-ONLY — sections + columns have their own DnD/reorder
 * paths and the right-click menu does NOT expose Move up/down for them.
 *
 * Top-level edge case: a "loose widget" with parentId=null shares the
 * parent_id IS NULL bucket with sections (also parentId=null). The
 * server's drift-detection at /api/cms/blocks/reorder validates every
 * living child of every parent — submitting only widget ids when
 * sections also occupy the bucket → 409 drift. So when parentId=null
 * we ALSO include the sibling section ids in the submission. Sections
 * carry data-edit-section-id (different from data-edit-block-id), so
 * we walk both attribute sets and merge.
 */
function readWidgetSiblings(ctx: MenuContext): Array<{
  id: number
  version: number
}> {
  if (typeof document === 'undefined') return []
  const myParent = ctx.parentId === null ? '' : String(ctx.parentId)
  const widgetRows = Array.from(
    document.querySelectorAll<HTMLElement>('[data-edit-block-id]'),
  )
    .map((el) => ({
      id: Number(el.dataset['editBlockId']),
      version: Number(el.dataset['editBlockVersion']),
      pageId: Number(el.dataset['editPageId']),
      parent: el.dataset['editParentId'] ?? '',
      position: Number(el.offsetTop) || 0,
    }))
    .filter((b) => b.pageId === ctx.pageId && b.parent === myParent)
  // Top-level loose widgets share the parent_id IS NULL bucket with
  // top-level sections. The reorder server-side drift check expects
  // every living child of the parent — so include section rows that
  // share the same parent context (always parent=null) and ensure the
  // reorder payload carries them too.
  let allRows = widgetRows
  if (ctx.parentId === null) {
    const sectionRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-edit-section-id]'),
    )
      .map((el) => ({
        id: Number(el.dataset['editSectionId']),
        version: Number(el.dataset['editSectionVersion']),
        pageId: Number(el.dataset['editSectionPageId']),
        // Sections always sit at parent_id=null.
        parent: '',
        position: Number(el.offsetTop) || 0,
      }))
      .filter((b) => b.pageId === ctx.pageId)
    allRows = [...widgetRows, ...sectionRows]
  }
  // Sort by DOM offsetTop so the array reflects the visual order
  // independent of the order the two queries returned.
  allRows.sort((a, b) => a.position - b.position)
  return allRows.map((r) => ({ id: r.id, version: r.version }))
}

async function moveByApi(
  ctx: MenuContext,
  dir: -1 | 1,
): Promise<void> {
  // Widget-only verb. Section reorder is DnD-driven (top-bar sortable
  // shell). This function assumes ctx.kind === 'widget' — see
  // readWidgetSiblings for the top-level merge logic that keeps the
  // server's drift-detection satisfied.
  const siblings = readWidgetSiblings(ctx)
  const idx = siblings.findIndex((b) => b.id === ctx.blockId)
  const target = idx + dir
  if (idx < 0 || target < 0 || target >= siblings.length) {
    ctx.toast.info(dir === -1 ? 'Already at the top.' : 'Already at the bottom.')
    return
  }
  const reordered = [...siblings]
  const a = reordered[idx]!
  const b = reordered[target]!
  reordered[idx] = b
  reordered[target] = a
  try {
    const res = await csrfFetch('/api/cms/blocks/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageId: ctx.pageId,
        parentId: ctx.parentId,
        blocks: reordered.map((b) => ({ id: b.id, version: b.version })),
      }),
    })
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      if (res.status === 409) ctx.refresh()
      return
    }
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

function isFirstWidgetSibling(ctx: MenuContext): boolean {
  const siblings = readWidgetSiblings(ctx)
  return siblings.length > 0 && siblings[0]!.id === ctx.blockId
}

function isLastWidgetSibling(ctx: MenuContext): boolean {
  const siblings = readWidgetSiblings(ctx)
  return siblings.length > 0 && siblings[siblings.length - 1]!.id === ctx.blockId
}

// ─── Clipboard helpers ─────────────────────────────────────────────

function copyWidgetToClipboard(ctx: MenuContext): void {
  // Carries data + meta so paste preserves Chunk E per-side spacing
  // and any future widget meta. The server re-validates via
  // parseAndSanitize when the paste POST hits /api/cms/blocks, so a
  // tampered slot fails closed at the server boundary regardless of
  // what landed in memory client-side.
  const slot: ClipboardSlot = {
    version: CLIPBOARD_SCHEMA_VERSION,
    kind: 'widget',
    blockType: ctx.blockType,
    data: ctx.data,
    meta: ctx.meta,
    copiedAt: Date.now(),
  }
  ctx.setClipboard(slot)
  ctx.toast.info('Copied. Right-click another column to paste.')
}

function copySectionToClipboard(ctx: MenuContext): void {
  // V2: the copy carries the section's meta AND the full subtree
  // (columns + widgets). The provider injects getSectionSubtree from
  // useInlineEditState() so the captured subtree is the LIVE
  // optimistic tree — operator-typed edits that haven't been
  // reconciled from the server are still part of the copy.
  //
  // When the callback is missing (regression guard / consumer wired
  // without state plumbing), the copy still proceeds with an empty
  // subtree — paste creates a structurally-correct empty section
  // and the operator can re-fill, rather than failing the gesture
  // outright. The toast copy reflects which path was taken.
  const subtree = ctx.getSectionSubtree?.(ctx.blockId)
  const columns: ClipboardColumn[] = subtree?.columns ?? []
  const widgetCount: number = subtree?.widgetCount ?? 0
  const slot: ClipboardSlot = {
    version: CLIPBOARD_SCHEMA_VERSION,
    kind: 'section',
    meta: ctx.meta,
    columns,
    widgetCount,
    copiedAt: Date.now(),
  }
  ctx.setClipboard(slot)
  if (widgetCount > 0) {
    ctx.toast.info(
      `Section with ${widgetCount} item${widgetCount === 1 ? '' : 's'} copied. Paste creates a duplicate including all widgets.`,
    )
  } else {
    ctx.toast.info(
      'Section shape copied. Right-click another section to paste a duplicate.',
    )
  }
}

function copyColumnToClipboard(ctx: MenuContext): void {
  // V1: column copy captures the meta blob only AND has no V1 paste
  // target — clipboard.canPaste's matrix has no 'column' source that
  // accepts anywhere. The Copy menu item exists for parity / future-
  // proofing; the toast discloses the V1 limitation so the operator
  // isn't left searching for a non-existent paste affordance.
  //
  // Forward-compat: ClipboardColumn.widgets is the typed slot for
  // the Phase 2 full-subtree copy + a section-level "Paste column
  // here" verb that would extend the canPaste matrix.
  const slot: ClipboardSlot = {
    version: CLIPBOARD_SCHEMA_VERSION,
    kind: 'column',
    meta: ctx.meta,
    widgets: [],
    copiedAt: Date.now(),
  }
  ctx.setClipboard(slot)
  ctx.toast.info(
    'Column shape copied. (Paste support for columns lands in a future update.)',
  )
}

/** Extract a valid SectionColumnsCount value (1|2|3|4) from a slot's
 *  meta payload. Returns 1 as a safe fallback for malformed input —
 *  the server's SectionMetaSchema will reject anything else at the
 *  POST boundary, but this client-side derivation keeps the paste
 *  request well-formed. */
function deriveSectionColumns(meta: unknown): 1 | 2 | 3 | 4 {
  if (meta && typeof meta === 'object') {
    const c = (meta as Record<string, unknown>)['columns']
    if (c === 1 || c === 2 || c === 3 || c === 4) return c
  }
  return 1
}

async function pasteSectionAfter(ctx: MenuContext): Promise<void> {
  if (!canPaste(ctx.clipboard, 'section')) return
  const slot = ctx.clipboard
  if (!slot || slot.kind !== 'section') return
  // V2 — full-subtree paste. Chain POSTs sequentially because each
  // child insert needs the parent id from the prior insert's response:
  //   1. POST new section (no withColumns — we create columns
  //      explicitly so we can carry their meta + child widgets).
  //   2. For each captured column: POST a column under the new
  //      section id with the captured meta.
  //   3. For each widget in that column: POST a widget under the
  //      new column id with the captured blockType, data, meta.
  // All POSTs go through the same parseAndSanitize / WidgetMetaSchema
  // /  SectionMetaSchema / ColumnMetaSchema gates the server enforces
  // on a fresh add — a tampered slot fails closed at the wire.
  //
  // V1 fall-through: when the slot was captured WITHOUT a subtree
  // (provider regression / sub-tree callback missing at copy time),
  // slot.columns is empty and slot.widgetCount === 0. In that case
  // we still create N empty columns via withColumns so the pasted
  // shell isn't column-less — matches V1 paste UX.
  const hasSubtree = slot.columns.length > 0
  const fallbackColumns = deriveSectionColumns(slot.meta)
  const sectionBody: Record<string, unknown> = {
    pageId: ctx.pageId,
    kind: 'section',
    afterBlockId: ctx.blockId,
    meta: slot.meta ?? {},
  }
  if (!hasSubtree) sectionBody['withColumns'] = fallbackColumns
  let newSectionId: number | null = null
  try {
    const res = await csrfFetch('/api/cms/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sectionBody),
    })
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      return
    }
    const j = (await res.json().catch(() => ({}))) as { id?: number }
    if (typeof j.id !== 'number') {
      // Body parse failed but section committed server-side. Refresh
      // to pick it up; the subtree will be missing widgets but the
      // shell will be present. Don't attempt the child POSTs (we
      // don't know the parent id).
      ctx.toast.success('Section pasted. Reloading to sync.')
      ctx.refresh()
      return
    }
    newSectionId = j.id
    // Chain the subtree — sequential because the column id from each
    // POST feeds the widget POSTs underneath it. Errors during the
    // chain do NOT roll back the section + already-created children:
    // a partial-tree paste is recoverable (operator sees what landed +
    // the toast surfaces the failure point), whereas a rollback would
    // need a server-side transaction we don't have at the paste API.
    // The operator can ⌘Z to remove the partial result and try again.
    let chainOk = true
    if (hasSubtree) {
      for (const col of slot.columns) {
        const colRes = await csrfFetch('/api/cms/blocks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pageId: ctx.pageId,
            kind: 'column',
            parentId: newSectionId,
            meta: col.meta ?? {},
          }),
        })
        if (!colRes.ok) {
          chainOk = false
          ctx.toast.error(await readJsonErr(colRes))
          break
        }
        const colJ = (await colRes.json().catch(() => ({}))) as { id?: number }
        if (typeof colJ.id !== 'number') {
          chainOk = false
          break
        }
        const newColumnId = colJ.id
        for (const w of col.widgets) {
          const widgetBody: Record<string, unknown> = {
            pageId: ctx.pageId,
            kind: 'widget',
            parentId: newColumnId,
            blockType: w.blockType,
            data: w.data,
          }
          if (w.meta && typeof w.meta === 'object') widgetBody['meta'] = w.meta
          const wRes = await csrfFetch('/api/cms/blocks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(widgetBody),
          })
          if (!wRes.ok) {
            chainOk = false
            ctx.toast.error(await readJsonErr(wRes))
            break
          }
        }
        if (!chainOk) break
      }
    }
    // ── Chunk J undo wiring (V2 subtree-aware) ──
    // Inverse: DELETE the new section id. The server's soft-delete
    // cascade (recursive CTE) sweeps every column + widget that was
    // created under it in one shot — operator's ⌘Z removes the
    // pasted tree atomically.
    //
    // Forward replay (redo): the original section POST. NOTE: redo
    // recreates only the section shell, NOT the full subtree — the
    // captured children are soft-deleted in the database AND no
    // longer linked to a living parent (the original new section
    // was deleted by the inverse). Redoing the children would
    // require a separate "tree-restore" verb we don't have today.
    // The trade-off is acceptable: undo of a paste is the dominant
    // gesture (operator pasted, didn't like the placement, ⌘Z'd);
    // redo-after-undo of a paste is vanishingly rare. The operator
    // can re-paste from clipboard if they want the full tree back.
    recordPaste(ctx, sectionBody, newSectionId, 'Pasted section')
    if (chainOk && slot.widgetCount > 0) {
      ctx.toast.success(
        `Section with ${slot.widgetCount} item${slot.widgetCount === 1 ? '' : 's'} pasted.`,
        {
          label: 'Undo',
          onClick: () => ctx.runUndo(),
        },
      )
    } else if (chainOk) {
      ctx.toast.success('Section pasted.', {
        label: 'Undo',
        onClick: () => ctx.runUndo(),
      })
    }
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

async function pasteWidgetIntoColumn(ctx: MenuContext): Promise<void> {
  if (!canPaste(ctx.clipboard, 'column')) return
  const slot = ctx.clipboard
  if (!slot || slot.kind !== 'widget') return
  // Include meta in the POST so per-side spacing (Chunk E) is
  // preserved across the paste. The POST handler routes widget meta
  // through WidgetMetaSchema (a Zod .strict() gate) so a tampered
  // slot can't smuggle non-spacing keys past the wire.
  const body: Record<string, unknown> = {
    pageId: ctx.pageId,
    kind: 'widget',
    parentId: ctx.blockId,
    blockType: slot.blockType,
    data: slot.data,
  }
  if (slot.meta && typeof slot.meta === 'object') body['meta'] = slot.meta
  try {
    const res = await csrfFetch('/api/cms/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      return
    }
    const j = (await res.json().catch(() => ({}))) as { id?: number }
    if (typeof j.id === 'number') recordPaste(ctx, body, j.id, 'Pasted into column')
    ctx.toast.success('Pasted into column.', {
      label: 'Undo',
      onClick: () => ctx.runUndo(),
    })
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

async function pasteWidgetAfter(ctx: MenuContext): Promise<void> {
  if (!canPaste(ctx.clipboard, 'widget')) return
  const slot = ctx.clipboard
  if (!slot || slot.kind !== 'widget') return
  const body: Record<string, unknown> = {
    pageId: ctx.pageId,
    kind: 'widget',
    parentId: ctx.parentId,
    blockType: slot.blockType,
    data: slot.data,
    afterBlockId: ctx.blockId,
  }
  if (slot.meta && typeof slot.meta === 'object') body['meta'] = slot.meta
  try {
    const res = await csrfFetch('/api/cms/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      ctx.toast.error(await readJsonErr(res))
      return
    }
    const j = (await res.json().catch(() => ({}))) as { id?: number }
    if (typeof j.id === 'number') recordPaste(ctx, body, j.id, 'Pasted block')
    ctx.toast.success('Pasted.', {
      label: 'Undo',
      onClick: () => ctx.runUndo(),
    })
    ctx.refresh()
  } catch (e) {
    toastNetworkError(ctx.toast, e)
  }
}

// ── Chunk J — shared paste-record helper ──
// Builds the PASTE undo command. Forward replays the same POST body
// (server returns a fresh id; deriveRebind in UndoStackProvider swaps
// it into the inverse). Inverse DELETEs the newly-pasted id; for
// section pastes the existing recursive CTE soft-delete cascades the
// child columns.
function recordPaste(
  ctx: MenuContext,
  body: Record<string, unknown>,
  newId: number,
  label: string,
): void {
  ctx.recordCommand({
    kind: 'paste',
    label,
    timestamp: Date.now(),
    forward: {
      method: 'POST',
      path: '/api/cms/blocks',
      body,
      expects: 201,
    },
    inverse: {
      method: 'DELETE',
      path: `/api/cms/blocks/${newId}`,
      expects: 200,
    },
    captures: { newBlockId: newId },
  })
}

// ─── Registry ──────────────────────────────────────────────────────

export const MENU_ITEMS_BY_KIND: Record<BlockKind, MenuItem[]> = {
  section: [
    {
      id: 'section.edit',
      label: 'Edit section',
      icon: Settings,
      handler: (ctx) => {
        ctx.closeMenu()
        ctx.openEditDrawer()
      },
    },
    {
      id: 'section.duplicate',
      label: 'Duplicate section',
      icon: Copy,
      // No kbdHint — useKeyboardShortcuts wires ⌘D for SELECTED WIDGETS
      // only. Showing "⌘D" here would falsely advertise a shortcut that
      // does nothing when a section is selected (delta-review finding).
      handler: async (ctx) => {
        ctx.closeMenu()
        await duplicateBlockApi(ctx)
      },
    },
    {
      id: 'section.addAbove',
      label: 'Add section above',
      icon: ArrowUpToLine,
      handler: async (ctx) => {
        ctx.closeMenu()
        await addSiblingSection(ctx, 'above')
      },
    },
    {
      id: 'section.addBelow',
      label: 'Add section below',
      icon: ArrowDownToLine,
      handler: async (ctx) => {
        ctx.closeMenu()
        await addSiblingSection(ctx, 'below')
      },
    },
    {
      id: 'section.addColumn',
      label: 'Add column',
      icon: Columns3,
      disabled: (ctx) => (ctx.columnCount ?? 0) >= MAX_SECTION_COLUMNS,
      handler: async (ctx) => {
        ctx.closeMenu()
        await addColumnApi(ctx)
      },
    },
    {
      id: 'section.spacing',
      label: 'Spacing',
      icon: Move,
      handler: (ctx) => {
        ctx.closeMenu()
        ctx.openEditDrawer('style')
      },
    },
    {
      id: 'section.copy',
      label: 'Copy',
      icon: ClipboardIcon,
      // No kbdHint — useKeyboardShortcuts does NOT wire ⌘C for selected
      // sections (only selected widgets). Advertising ⌘C here would
      // mislead operators into pressing a no-op shortcut.
      separatorAbove: true,
      handler: (ctx) => {
        ctx.closeMenu()
        copySectionToClipboard(ctx)
      },
    },
    {
      id: 'section.paste',
      label: 'Paste here',
      icon: ClipboardPaste,
      // No kbdHint — ⌘V is not wired for selected sections.
      disabled: (ctx) => !canPaste(ctx.clipboard, 'section'),
      handler: async (ctx) => {
        ctx.closeMenu()
        await pasteSectionAfter(ctx)
      },
    },
    {
      id: 'section.delete',
      label: 'Delete section',
      icon: Trash2,
      kbdHint: '⌫',
      separatorAbove: true,
      destructive: true,
      handler: async (ctx) => {
        ctx.closeMenu()
        const ok = await ctx.confirmDelete({
          title: 'Remove this section?',
          description:
            'The section, every column, and every widget inside will be hidden from the public site right away. You can restore from the admin trash within 30 days.',
          confirmLabel: 'Remove',
        })
        if (!ok) return
        await deleteBlockApi(ctx, 'Section')
      },
    },
  ],

  column: [
    {
      id: 'column.edit',
      label: 'Edit column',
      icon: Settings,
      handler: (ctx) => {
        ctx.closeMenu()
        ctx.openEditDrawer()
      },
    },
    {
      id: 'column.duplicate',
      label: 'Duplicate column',
      icon: Copy,
      // No kbdHint — ⌘D is widget-only (delta-review finding).
      handler: async (ctx) => {
        ctx.closeMenu()
        await duplicateBlockApi(ctx)
      },
    },
    {
      id: 'column.setWidth',
      label: 'Set column width',
      icon: Maximize2,
      handler: (ctx) => {
        ctx.closeMenu()
        ctx.openEditDrawer('style')
      },
    },
    {
      id: 'column.addWidget',
      label: 'Add widget',
      icon: Plus,
      // openAddWidget is optional in the type; gate the disable on it
      // so a column wired without the callback (regression guard) shows
      // a quiet disabled state rather than throwing on click.
      disabled: (ctx) => ctx.openAddWidget === undefined,
      handler: (ctx) => {
        ctx.closeMenu()
        ctx.openAddWidget?.()
      },
    },
    {
      id: 'column.copy',
      label: 'Copy',
      icon: ClipboardIcon,
      // No kbdHint — ⌘C is widget-only (delta-review finding).
      separatorAbove: true,
      handler: (ctx) => {
        ctx.closeMenu()
        copyColumnToClipboard(ctx)
      },
    },
    {
      id: 'column.paste',
      label: 'Paste here',
      icon: ClipboardPaste,
      // No kbdHint — ⌘V is widget-only.
      disabled: (ctx) => !canPaste(ctx.clipboard, 'column'),
      handler: async (ctx) => {
        ctx.closeMenu()
        await pasteWidgetIntoColumn(ctx)
      },
    },
    {
      id: 'column.delete',
      label: 'Delete column',
      icon: Trash2,
      kbdHint: '⌫',
      separatorAbove: true,
      destructive: true,
      handler: async (ctx) => {
        ctx.closeMenu()
        const ok = await ctx.confirmDelete({
          title: 'Remove this column?',
          description:
            "The column and every widget inside will be hidden from the public site right away. The section's grid will re-flow to fit the remaining columns.",
          confirmLabel: 'Remove',
        })
        if (!ok) return
        await deleteBlockApi(ctx, 'Column')
      },
    },
  ],

  widget: [
    {
      id: 'widget.edit',
      label: 'Edit',
      icon: Pencil,
      handler: (ctx) => {
        ctx.closeMenu()
        ctx.openEditDrawer()
      },
    },
    {
      id: 'widget.duplicate',
      label: 'Duplicate',
      icon: Copy,
      kbdHint: '⌘D',
      handler: async (ctx) => {
        ctx.closeMenu()
        await duplicateBlockApi(ctx)
      },
    },
    {
      id: 'widget.saveAsBlock',
      label: 'Save as block…',
      icon: BookmarkPlus,
      // No kbdHint — the gesture has no global shortcut today. The
      // ellipsis signals "this opens a prompt" (matches the OS-level
      // convention used by Save As… / Find… across native menus).
      handler: async (ctx) => {
        ctx.closeMenu()
        await saveWidgetAsBlock(ctx)
      },
    },
    {
      id: 'widget.moveUp',
      label: 'Move up',
      icon: ArrowUp,
      kbdHint: '⌥↑',
      disabled: (ctx) => isFirstWidgetSibling(ctx),
      handler: async (ctx) => {
        ctx.closeMenu()
        await moveByApi(ctx, -1)
      },
    },
    {
      id: 'widget.moveDown',
      label: 'Move down',
      icon: ArrowDown,
      kbdHint: '⌥↓',
      disabled: (ctx) => isLastWidgetSibling(ctx),
      handler: async (ctx) => {
        ctx.closeMenu()
        await moveByApi(ctx, 1)
      },
    },
    {
      id: 'widget.spacing',
      label: 'Spacing',
      icon: Move,
      // The widget's SpacingToolbar (Chunk E) opens its own popover —
      // ctx.openSpacingToolbar is the callback the EditableBlock wires
      // up. Defensive disable when the callback isn't provided (cross-
      // surface regression guard).
      disabled: (ctx) => ctx.openSpacingToolbar === undefined,
      handler: (ctx) => {
        ctx.closeMenu()
        ctx.openSpacingToolbar?.()
      },
    },
    {
      id: 'widget.copy',
      label: 'Copy',
      icon: ClipboardIcon,
      kbdHint: '⌘C',
      separatorAbove: true,
      handler: (ctx) => {
        ctx.closeMenu()
        copyWidgetToClipboard(ctx)
      },
    },
    {
      id: 'widget.paste',
      label: 'Paste below',
      icon: ClipboardPaste,
      kbdHint: '⌘V',
      disabled: (ctx) => !canPaste(ctx.clipboard, 'widget'),
      handler: async (ctx) => {
        ctx.closeMenu()
        await pasteWidgetAfter(ctx)
      },
    },
    {
      id: 'widget.delete',
      label: 'Delete',
      icon: Trash2,
      kbdHint: '⌫',
      separatorAbove: true,
      destructive: true,
      handler: async (ctx) => {
        ctx.closeMenu()
        const ok = await ctx.confirmDelete({
          title: 'Remove this block?',
          description:
            "It'll be hidden from the public site right away. You can restore from the admin trash within 30 days.",
          confirmLabel: 'Remove',
        })
        if (!ok) return
        await deleteBlockApi(ctx, 'Block')
      },
    },
  ],
}
