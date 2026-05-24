import type { Role } from '@/lib/auth/requireRole'
import { ADMIN_POLICY } from '@/lib/auth/adminPolicy'

// Bar-side adapter over the canonical ADMIN_POLICY. The bar maps
// resource kinds ('project' / 'post' for Edit; 'project' / 'post' /
// 'media' / 'user' for New) to the policy keys — a thin mapping,
// not a duplicate source of truth. If the policy changes, this
// file picks up the change automatically.

export type EditTargetKind = 'project' | 'post'
export type NewItemKind = 'project' | 'post' | 'page' | 'media' | 'user'

const EDIT_POLICY: Record<EditTargetKind, readonly Role[]> = {
  project: ADMIN_POLICY.editProject,
  post: ADMIN_POLICY.editPost,
}

const CREATE_POLICY: Record<NewItemKind, readonly Role[]> = {
  project: ADMIN_POLICY.createProject,
  post: ADMIN_POLICY.createPost,
  page: ADMIN_POLICY.createPage,
  media: ADMIN_POLICY.uploadMedia,
  user: ADMIN_POLICY.inviteUser,
}

export function canEditTarget(kind: EditTargetKind, role: Role): boolean {
  return EDIT_POLICY[kind].includes(role)
}

export function canCreate(kind: NewItemKind, role: Role): boolean {
  return CREATE_POLICY[kind].includes(role)
}
