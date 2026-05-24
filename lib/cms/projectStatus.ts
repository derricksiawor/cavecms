import 'server-only'

// Project status state machine. PATCH /api/cms/projects/[id] consults
// this before persisting a status change so admins can't accidentally
// regress a project from `selling` back to `coming_soon` (which would
// shadow live inventory under a "not-yet-launched" pill on /projects).
//
// The one legal "backward" edge is sold_out → selling: a unit
// cancellation puts a project back on the market and that's a real
// merchandising event we need to support.
const TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  coming_soon: ['under_construction', 'selling'],
  under_construction: ['selling', 'sold_out'],
  selling: ['sold_out'],
  sold_out: ['selling'],
}

export function isValidStatusTransition(from: string, to: string): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}
