import 'server-only'
import type { Role } from '@/lib/auth/requireRole'

// Phase 8 (blog-system worktree): the bulk-action POLICY for /api/cms/posts/bulk
// — the closed set of actions, the role each requires, and the batch bound.
// Kept as a pure, DB-free module so the action set + role gating + id-bounding
// can be unit-tested in isolation (tests/unit/bulkPostAction.test.ts), exactly
// the per-action policy the spec §10 asks for (publish/unpublish/trash = admin;
// assign-category / add-tag = editor+admin, mirroring the single-post route's
// gates — PATCH publish/slug is admin-only, taxonomy assign is editor-allowed).

export const BULK_POST_ACTIONS = [
  'publish',
  'unpublish',
  'trash',
  'assignCategories',
  'addTags',
] as const
export type BulkPostAction = (typeof BULK_POST_ACTIONS)[number]

export function isBulkPostAction(v: unknown): v is BulkPostAction {
  return (
    typeof v === 'string' &&
    (BULK_POST_ACTIONS as readonly string[]).includes(v)
  )
}

// Max posts a single bulk submit may touch. Bounds the per-row loop + the audit
// fan-out (one row per post) so a hostile/accidental "select 10k" can't write
// 10k audit rows or hold a long lock cycle. 100 is generous for an operator
// curating a blog list a page at a time (page sizes top out at 100).
export const MAX_BULK_POST_IDS = 100

// Role required for each action. publish/unpublish/trash are state-changing on
// the PUBLIC site → admin only (same as the single-post PATCH publish gate +
// the DELETE admin gate). Taxonomy assignment is an editorial capability →
// editor + admin (same as the single-post PATCH categoryIds/tagIds gate, which
// lives on the base EditorSchema).
const ACTION_ROLES: Record<BulkPostAction, readonly Role[]> = {
  publish: ['admin'],
  unpublish: ['admin'],
  trash: ['admin'],
  assignCategories: ['admin', 'editor'],
  addTags: ['admin', 'editor'],
}

export function rolesForBulkAction(action: BulkPostAction): readonly Role[] {
  return ACTION_ROLES[action]
}

export function roleCanRunBulkAction(
  action: BulkPostAction,
  role: Role,
): boolean {
  return ACTION_ROLES[action].includes(role)
}

// Pure id normaliser: de-dupe, drop non-positive-ints, preserve first-seen
// order. Returns the cleaned list AND whether it exceeds the cap so the route
// can 400 a too-large batch with a precise reason. Exported for unit testing.
export function normalizeBulkIds(ids: readonly unknown[]): {
  ids: number[]
  tooMany: boolean
} {
  const seen = new Set<number>()
  const out: number[] = []
  for (const raw of ids) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return { ids: out, tooMany: out.length > MAX_BULK_POST_IDS }
}

// Whether an action carries a taxonomy payload (categoryIds for assignCategories,
// tagIds for addTags). Used by the route to require + validate the right field.
export function bulkActionNeedsTaxonomy(
  action: BulkPostAction,
): 'category' | 'tag' | null {
  if (action === 'assignCategories') return 'category'
  if (action === 'addTags') return 'tag'
  return null
}
