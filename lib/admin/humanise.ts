// Turn the internal action / resource strings stored in the activity
// log into something a non-technical operator can scan at a glance.
// New action / resource keys fall through to a generic prettify so
// the surface never shows a developer-shaped identifier unprettified.

const ACTION_LABELS: Record<string, string> = {
  'project.create': 'Created a project',
  'project.update': 'Updated a project',
  'project.publish': 'Published a project',
  'project.unpublish': 'Hid a project',
  'project.archive': 'Moved a project to Trash',
  'project.restore': 'Restored a project',
  'project.delete': 'Deleted a project',
  'project.reorder': 'Reordered projects',
  'project.section.update': 'Updated a project section',
  'post.create': 'Created a post',
  'post.update': 'Updated a post',
  'post.publish': 'Published a post',
  'post.unpublish': 'Hid a post',
  'post.delete': 'Deleted a post',
  'page.create': 'Created a page',
  'page.update': 'Updated a page',
  'page.publish': 'Published a page',
  'page.unpublish': 'Hid a page',
  'page.delete': 'Moved a page to Trash',
  'page.restore': 'Restored a page',
  'page.reorder': 'Reordered page sections',
  'block.create': 'Added a page section',
  'block.update': 'Edited a page section',
  'block.delete': 'Deleted a page section',
  'block.restore': 'Restored a page section',
  'block.reorder': 'Reordered page sections',
  'media.upload': 'Uploaded a file',
  'media.update': 'Updated a file',
  'media.delete': 'Deleted a file',
  'lead.update': 'Updated a lead',
  'lead.delete': 'Deleted a lead',
  'lead.export': 'Exported leads',
  'settings.update': 'Updated a site setting',
  'setting.update': 'Updated a site setting',
  'user.create': 'Added a user',
  'user.update': 'Updated a user',
  'user.delete': 'Removed a user',
  'user.role_change': 'Changed a user role',
  'user.password_reset': 'Reset a password',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'alert.resolve': 'Resolved an alert',
  ai_proposal_created: 'Proposed an AI change',
  ai_proposal_accepted: 'Applied an AI proposal',
  ai_proposal_dismissed: 'Dismissed an AI proposal',
  // CaveCMS self-update lifecycle. `apply` and `force_apply` are
  // written by the admin /apply route at kick-off; `completed`,
  // `failed`, `rolled_back` are written by the orchestrator script
  // at terminal transition (via /api/internal/updates/audit-terminal).
  apply: 'Started update',
  force_apply: 'Re-ran install',
  completed: 'Update succeeded',
  failed: 'Update failed',
  rolled_back: 'Update rolled back',
}

const RESOURCE_LABELS: Record<string, string> = {
  project: 'Project',
  project_section: 'Project section',
  post: 'Blog post',
  page: 'Page',
  block: 'Page section',
  content_block: 'Page section',
  media: 'File',
  lead: 'Lead',
  setting: 'Site setting',
  settings: 'Site setting',
  user: 'User',
  alert: 'Alert',
  notification_failure: 'Background alert',
  team_member: 'Team member',
  auth: 'Sign-in',
  ai_proposal: 'AI proposal',
  updates: 'CaveCMS update',
}

const ALERT_KIND_LABELS: Record<string, string> = {
  smtp: 'Email delivery',
  smtp_send: 'Email delivery',
  smtp_breaker_open: 'Email delivery paused',
  lead_email_enqueue_failed: 'Lead email queue',
  revalidate: 'Page refresh',
  recaptcha: 'Spam check',
  rbac: 'Permission denied',
  hydrate: 'Page render warning',
  runtime: 'Unexpected error',
  crm: 'CRM lead handoff',
  crm_dispatch_failed: 'CRM lead handoff',
}

// Generic prettifier: 'project.section.update' → 'Project section update'.
function prettify(raw: string): string {
  return raw
    .split('.')
    .join(' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Bare action verbs that the audit_log stores without a resource
// prefix — e.g. `update`, `create`. The dashboard + activity tables
// pair these with the resource column, so the label only needs to
// be the past-tense verb. Without this map a bare `update` would
// prettify to "Update" which reads like an imperative.
const BARE_VERB_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  restore: 'Restored',
  publish: 'Published',
  unpublish: 'Hidden',
  archive: 'Moved to Trash',
  reorder: 'Reordered',
  upload: 'Uploaded',
  resolve: 'Resolved',
  login: 'Signed in',
  logout: 'Signed out',
  role_change: 'Role changed',
  password_reset: 'Password reset',
}

export function humaniseAuditAction(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action]
  if (BARE_VERB_LABELS[action]) return BARE_VERB_LABELS[action]
  return prettify(action)
}

export function humaniseResourceType(resource: string): string {
  return RESOURCE_LABELS[resource] ?? prettify(resource)
}

export function humaniseAlertKind(kind: string): string {
  return ALERT_KIND_LABELS[kind] ?? prettify(kind)
}
