// Canonical URL builders for the admin chrome — every admin-bar
// link, sidebar Preview-Site link, and inter-admin deep link routes
// through here. Centralising the path shape keeps the bar honest if
// admin routing ever changes (e.g., adding `/edit` to the editor
// segment, or splitting an editor into `/general`). Without this
// helper a routing change silently rots links.
//
// Plain const map — no React, no runtime deps. Importable from
// server components, route handlers, and client islands alike.

export const adminRoutes = {
  dashboard: () => '/admin',
  editProject: (id: number) => `/admin/projects/${id}`,
  editPost: (id: number) => `/admin/blog/${id}`,
  newProject: () => '/admin/projects',
  newPost: () => '/admin/blog/new',
  newPage: () => '/admin/pages/new',
  uploadMedia: () => '/admin/media',
  inviteUser: () => '/admin/users',
} as const

export type AdminRouteKey = keyof typeof adminRoutes
