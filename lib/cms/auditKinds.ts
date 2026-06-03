import 'server-only'

// Single source of truth for the `kind` discriminator on audit_log.diff
// JSON payloads. Forensic tooling (Plan 09 audit dashboard) dispatches
// on this field; adding a new kind in one route handler but not here
// surfaces as an opaque `kind: 'foo'` row in production.
//
// Naming: lower_snake. Truncated variants append `_truncated`. Stay
// under 32 chars (kind column is varchar(32) in audit_log shape — well
// over today's longest at 17 chars).
export const AUDIT_KIND = {
  patch: 'patch',
  patchTruncated: 'patch_truncated',
  create: 'create',
  createTruncated: 'create_truncated',
  delete: 'delete',
  restore: 'restore',
  reorder: 'reorder',
  // Chunk J: an operator instantiated a server-side section template
  // via POST /api/cms/templates/instantiate. Diff payload carries the
  // template id + the full list of new block ids so forensic replay
  // can reconstruct exactly which rows the gesture produced (vs the
  // generic `create` kind which would lose the template signal).
  instantiateTemplate: 'instantiate_template',
  // Chunk H: a Duplicate / Paste menu action created a fresh subtree.
  // The diff payload carries the source id (when duplicate) or null
  // (when paste-from-clipboard), the top-level kind, and the count of
  // descendant rows created in the same TX so forensic tooling can
  // tell "operator added one section with 3 columns and 7 widgets"
  // from a single audit row instead of the N create rows the prior
  // multi-POST shape would have written.
  duplicate: 'duplicate',
  // Editor PATCHed an admin-only field (published / slug / status).
  // Audit captures the offending key names only; values are never
  // stored to avoid logging credential-adjacent material on 403.
  rbacFieldReject: 'rbac_field_reject',
  // Restore endpoint refused because the soft-deleted row's stored
  // data failed parseForRead under the current registry (looser
  // schema at create time, tightened after). Forensic trail so
  // silent restore rejections don't disappear — operator-facing
  // 409 stays generic, but the audit row carries the block_type +
  // block id so an admin can identify which rows need a manual
  // rewrite before they're restorable.
  restoreRejectedInvalidData: 'restore_rejected_invalid_data',
  // Saved blocks library — per-user "Save as block" + paste-from-library
  // gestures (see lib/cms/savedBlocks.ts + app/api/cms/saved-blocks/*).
  // Three kinds so forensic tooling can distinguish library-add from
  // library-remove from paste-into-page without sniffing the diff
  // payload. Paste's diff carries { saved_block_id, new_block_id } so a
  // single audit row tells the full story without joining against the
  // saved_blocks table (which may have been pruned by the operator
  // between the gesture and the forensic query).
  savedBlockCreate: 'saved_block_create',
  savedBlockDelete: 'saved_block_delete',
  savedBlockInstantiate: 'saved_block_instantiate',
  // ── blog-system worktree: taxonomy (do not interleave) ────────────
  // CRUD on categories / tags. The generic create/patch/delete kinds
  // would lose the term-type + slug signal a taxonomy forensic query
  // needs; these carry the resource ('category'|'tag') in resourceType
  // and the term slug/name in the diff payload. taxonomyAssign records
  // a post's category/tag set being synced from the post editor (diff
  // carries the added/removed id lists) so a "who tagged this post"
  // query reads one row, not N junction-row inserts.
  taxonomyCreate: 'taxonomy_create',
  taxonomyUpdate: 'taxonomy_update',
  taxonomyDelete: 'taxonomy_delete',
  taxonomyAssign: 'taxonomy_assign',
  // ── end blog-system worktree taxonomy ─────────────────────────────
} as const

export type AuditKind = (typeof AUDIT_KIND)[keyof typeof AUDIT_KIND]
