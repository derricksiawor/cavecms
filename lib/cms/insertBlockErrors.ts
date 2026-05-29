// Chunk I — shared copy table for useInsertBlock error mapping.
//
// Before consolidation, every caller of useInsertBlock owned its own
// error → operator-copy table. Drift was already visible:
//   - SlashCommandInline used "Refresh and try again"
//   - InsertBlockHere used "Refresh the page and try again"
//   - 3 of the 6 callers omitted the position_gap_exhausted branch
//     entirely, so server-returned "position_gap_exhausted" landed as
//     a generic "Add failed" toast (operator retries forever instead
//     of refreshing).
//
// This utility owns the single copy table. The 6 callers (the four
// existing pickers + the palette + the inline popover) pick the
// surface (toast vs inline error banner) but the strings are owned
// here. Adding a new server error code is a one-line addition;
// adding a new caller is a one-line `mapInsertBlockError(res.error)`
// call.

/** Result of mapping a useInsertBlock error code to operator copy.
 *  Returned even when error is undefined — callers use this for
 *  the timeout / network-error / generic fallback paths uniformly.
 *
 *  No `severity` field today: all 6 current callers route every
 *  failure through their own surface choice (toast OR inline banner)
 *  regardless of the error code. Adding a severity field that no
 *  consumer reads would be inert API surface that invites
 *  misinterpretation. Add it back when a caller needs to branch on
 *  it (e.g., "fatal → inline banner, transient → toast"). */
export interface MappedInsertError {
  /** Operator-facing copy. Always a complete sentence. Suitable for
   *  toast OR inline error banner. */
  copy: string
}

/**
 * Map a useInsertBlock error string to operator copy.
 *
 * The error parameter shape matches `InsertBlockResult.error`:
 *   - 'position_gap_exhausted' — server-returned (saveBlock.ts)
 *   - 'timeout'                — useInsertBlock-mapped AbortError
 *   - 'network_error'          — useInsertBlock-mapped fetch reject
 *   - undefined OR any other  — generic fallback
 *
 * Future server error codes added to the POST /api/cms/blocks route's
 * error enum should be added here in lockstep — the copy table is the
 * single source of operator-facing language for insert failures.
 */
export function mapInsertBlockError(
  error: string | undefined,
): MappedInsertError {
  switch (error) {
    case 'position_gap_exhausted':
      return {
        copy: "Couldn't insert here — the position gap is full. Refresh the page and try again.",
      }
    case 'block_type_reserved_for_fixed_slot':
      return {
        copy: "This block lives in the page template — edit the existing one instead of adding a new one.",
      }
    case 'section_wrap_failed':
      // The empty-page / no-column path couldn't create the host
      // section + column to nest the widget inside, so the insert was
      // aborted rather than dropping a loose top-level widget. (See
      // useInsertBlock's auto-wrap branch.) Generic, retryable copy —
      // the operator's next click re-runs the whole section→column→
      // widget create.
      return {
        copy: "We couldn't set up a section for that block. Try again in a moment.",
      }
    case 'timeout':
      return { copy: 'That took too long. Try again.' }
    case 'network_error':
      return {
        copy: "We can't reach the server right now. Try again in a moment.",
      }
    default:
      return { copy: "We couldn't add that. Try again in a moment." }
  }
}
