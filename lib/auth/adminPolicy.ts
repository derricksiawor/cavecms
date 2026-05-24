import type { Role } from '@/lib/auth/requireRole'

// Canonical role policy for admin surfaces that the public-side
// admin bar mirrors. Both the admin route handlers (page-level
// requireRole / requireRoleOrRedirect call sites) AND the bar
// (which gates its "+ New X" / "Edit X" UI by the same rules)
// MUST import from here — never inline a role array at these
// specific call sites.
//
// Drift contract: if you change a value here, every admin route
// referenced in the comment below picks it up automatically AND
// the bar's UI gate updates in the same commit. Inverse-coupling
// (admin route as source, bar as mirror) was rejected because the
// bar's UX is the FIRST place an operator notices a permission —
// the policy belongs upstream of both the route and the bar.
//
// Scope: only surfaces the bar actively mirrors. Other admin
// gates (list-page filters, settings, leads, trash, activity)
// continue to inline their role arrays; add them here when the
// bar starts surfacing them.

export const ADMIN_POLICY = {
  // Edit-page gates. Bar's "Edit X" pill deep-links to these
  // pages — the policy here governs both who sees the pill AND
  // who is allowed to load the editor.
  //   editProject → app/(admin)/admin/projects/[id]/page.tsx
  //   editPost    → app/(admin)/admin/blog/[id]/page.tsx
  //   editPage    → app/(admin)/admin/pages/[id]/page.tsx
  // Note: viewer-on-editPost and viewer-on-editPage are intentional
  // (read-only access per spec §0 role matrix); the corresponding
  // PATCH APIs still gate to ['admin','editor'] since mutation is
  // a separate concern and stays inline.
  editProject: ['admin', 'editor'],
  editPost: ['admin', 'editor', 'viewer'],
  editPage: ['admin', 'editor', 'viewer'],

  // Create gates. Bar's "+ New" dropdown items map 1:1 here.
  // Each value gates BOTH the admin page (or list with the
  // inline create form) AND the corresponding POST API:
  //   createProject → app/(admin)/admin/projects (list-with-create)
  //                 + app/api/cms/projects/route.ts POST
  //   createPost    → app/(admin)/admin/blog/new
  //                 + app/api/cms/posts/route.ts POST
  //   createPage    → app/(admin)/admin/pages/new
  //                 + app/api/cms/pages/route.ts POST
  //   uploadMedia   → app/(admin)/admin/media
  //                 + app/api/cms/media/route.ts POST
  //   inviteUser    → app/(admin)/admin/users
  //                 + app/api/admin/users/route.ts POST
  createProject: ['admin'],
  createPost: ['admin', 'editor'],
  createPage: ['admin', 'editor'],
  uploadMedia: ['admin', 'editor'],
  inviteUser: ['admin'],
} as const satisfies Record<string, readonly Role[]>

export type AdminPolicyKey = keyof typeof ADMIN_POLICY

// Returns a mutable copy of the policy array — `requireRole` and
// `requireRoleOrRedirect` accept `Role[]`, not `readonly Role[]`.
// Use at call sites: `await requireRole(adminPolicy('editProject'))`.
export function adminPolicy(key: AdminPolicyKey): Role[] {
  return [...ADMIN_POLICY[key]]
}
