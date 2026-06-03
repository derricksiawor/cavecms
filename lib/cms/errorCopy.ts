// Single source of truth: a server error CODE → calm, jargon-free copy for a
// DESIGNER. CaveCMS is a premium design tool, not a developer console — a raw
// enum (stale_version, drift, lock_conflict, …) or an HTTP status must NEVER
// reach the operator.
//
// mapServerError() returns specific copy for known codes and a gentle generic
// line for everything else; it NEVER echoes the code. Adding a new server error
// code? Give it an entry here — but an un-entried code still degrades safely to
// the generic line (or a caller-supplied, context-specific fallback).

import { MAX_SECTION_COLUMNS } from './blockMeta'

const GENERIC = "We couldn't finish that just now. Try again in a moment."

const ERROR_COPY: Record<string, string> = {
  // ── staleness / concurrency ──
  stale_version: 'Someone else changed this. Refresh to see the latest version.',
  stale_block_version:
    'Someone else changed this. Refresh to see the latest version.',
  stale_page_version:
    'Someone else changed this page. Refresh to see the latest version.',
  version_conflict:
    'Someone else changed this. Refresh to see the latest version.',
  drift: 'The page changed since you started — refresh to catch up.',
  lock_conflict:
    'The page is busy saving another change. Give it a second and try again.',

  // ── not found ──
  not_found:
    "We can't find that anymore — it may have been removed. Refreshing to sync.",
  page_not_found: 'This page no longer exists. Refreshing to sync.',
  parent_not_found:
    'That spot is no longer available. Refresh the page and try again.',
  block_purged: "This block's saved snapshot has expired, so it can't be restored.",

  // ── structure / grammar ──
  column_count_exceeded: `A section can hold up to ${MAX_SECTION_COLUMNS} columns.`,
  column_parent_must_be_section: 'A column can only sit inside a section.',
  column_parent_required: 'A column needs to sit inside a section.',
  widget_parent_must_be_column: 'A block can only sit inside a column.',
  section_cannot_have_parent: 'Sections live at the top level of the page.',
  cross_parent_reorder_not_allowed:
    'You can only reorder items within the same area. Drag it back to its group and try again.',
  parent_id_conflicts_with_new_parent_id:
    'That move got tangled — refresh the page and try again.',
  position_gap_exhausted:
    "We couldn't slot this in here — refresh and try again.",
  subtree_too_large:
    'That structure is too large to duplicate in one go — try duplicating its parts.',
  cycle_detected: 'We hit a data hiccup. The team has been notified.',
  still_referenced: "This is still in use elsewhere, so it can't be removed yet.",

  // ── naming ──
  html_id_collision:
    'Another block on this page already uses that name. Give this one a different name.',

  // ── fixed-slot / template ──
  cannot_delete_fixed_block:
    "This block is part of the page template and can't be removed.",
  block_type_reserved_for_fixed_slot:
    "This block is part of the page template, so you can't add another one here.",
  source_invalid:
    "This block's settings need updating before you can do that.",
  block_data_invalid:
    "This block's settings need updating before you can do that.",

  // ── settings / validation ──
  invalid_meta_json: 'That section or column has settings that need fixing.',
  invalid_request: "Something about that didn't look right. Refresh and try again.",
  invalid_body: "Something about that didn't look right. Refresh and try again.",
  unknown_block_type: "This kind of block isn't supported here.",
  duplicate_block_id: 'That move got tangled — refresh the page and try again.',

  // ── capacity / rate ──
  rate_limited: "You're going a little fast — pause a second and try again.",
  busy: "You're going a little fast — pause a second and try again.",

  // ── server ──
  server_error: 'Something went wrong on our end. Give it a moment and try again.',
}

/**
 * Map a server error code to designer-friendly copy. NEVER returns the raw
 * code: a known code → its specific line; anything else → `fallback` (or a
 * gentle generic). Pass a context-specific fallback for the best UX
 * (e.g. "We couldn't save the new order. Refresh and try again.").
 */
export function mapServerError(
  code?: string | null,
  fallback?: string,
): string {
  if (code && ERROR_COPY[code]) return ERROR_COPY[code]!
  return fallback ?? GENERIC
}

/** Read a non-ok Response's `{ error }` body and map it to friendly copy. */
export async function readServerError(
  res: Response,
  fallback?: string,
): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  return mapServerError(j.error, fallback)
}
