import 'server-only'
import {
  tokenAllowsScope,
  type ScopeResource,
  type ScopeAction,
} from '@/lib/auth/apiTokenScope'
import type { Role } from '@/lib/auth/types'

// ─── The MCP tool catalog ───────────────────────────────────────────
// Every tool the MCP server can expose, each tagged with the scope it needs
// (resource + minimum action), a minimum ROLE floor (for progressive
// disclosure), and a TIER. The tier drives UX, not authority:
//   read        — non-mutating; always safe.
//   write       — creates/edits content; reversible-ish.
//   destructive — deletes/trashes; the tool requires an explicit confirm
//                 (and offers an MCP elicitation prompt when the client
//                 supports it) before executing.
//
// Authority is decided by TWO gates that both also run inside the underlying
// route/service: the role clamp (authenticateBearer) and the scope predicate
// (tokenAllowsScope) — the SAME edge-safe function the HTTP routes use, so MCP
// and HTTP can never diverge. Progressive disclosure (server.ts) registers a
// tool iff role + scope permit it; assertToolScope re-checks at call time as
// defence in depth. For passthrough tools the route ITSELF re-runs requireRole +
// requireScope, so the catalog floors here are for clean disclosure, never the
// sole gate.

export type ToolTier = 'read' | 'write' | 'destructive'

export interface McpToolSpec {
  name: string
  /** null = no scope gate (meta/reference tools: whoami, describe_block_types). */
  resource: ScopeResource | null
  /** Minimum action the token must hold on `resource`. Ignored when resource is null. */
  action: ScopeAction
  /** Minimum role for disclosure — matches the underlying route's requireRole. */
  minRole: Role
  tier: ToolTier
  /** One-line summary surfaced to the operator + used in the tool description. */
  summary: string
}

function spec<T extends Record<string, McpToolSpec>>(t: T): T {
  return t
}

// The full surface. Handlers are registered in server.ts.
export const MCP_TOOLS = spec({
  // ── meta / reference (no scope) ──
  whoami: {
    name: 'whoami',
    resource: null,
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary: 'Identify the connected token: user, role, and granted scopes.',
  },
  describe_block_types: {
    name: 'describe_block_types',
    resource: null,
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary:
      'List every CMS block type with label, category, and an example data payload.',
  },
  design_guide: {
    name: 'design_guide',
    resource: null,
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary:
      'MANDATORY ultra-premium design standard. Call this FIRST — every content-mutating tool is locked until you do.',
  },
  get_theme: {
    name: 'get_theme',
    resource: null,
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary:
      'Read the live site theme (palette, header/footer branding, logo) so you can match the brand before composing.',
  },
  capabilities: {
    name: 'capabilities',
    resource: null,
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary:
      'Full self-description of CaveCMS + this server: content model, every feature, branding/theme controls, section/column meta, batch ops, rate limits, error codes, and the complete tool list.',
  },

  // ── pages ──
  list_pages: {
    name: 'list_pages',
    resource: 'pages',
    action: 'read',
    minRole: 'editor',
    tier: 'read',
    summary: 'List pages (or the 30-day trash) with id, slug, title, status.',
  },
  get_page: {
    name: 'get_page',
    resource: 'pages',
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary:
      'Read a page row + its block tree (block ids, versions, data) for read-before-edit.',
  },
  create_page: {
    name: 'create_page',
    resource: 'pages',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Create a new page (title, slug, SEO). Returns the new page id.',
  },
  update_page: {
    name: 'update_page',
    resource: 'pages',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: "Update a page's fields (title, slug, SEO, published, isHome).",
  },
  delete_page: {
    name: 'delete_page',
    resource: 'pages',
    action: 'delete',
    minRole: 'admin',
    tier: 'destructive',
    summary: 'Move a page to the 30-day trash (soft delete).',
  },

  // ── blocks ──
  update_block: {
    name: 'update_block',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary:
      "Replace one block's data under optimistic locking (block + page version).",
  },
  update_block_meta: {
    name: 'update_block_meta',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: "Replace one block's meta (visibility, spacing, identity).",
  },
  edit_page: {
    name: 'edit_page',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary:
      'Apply a batch of block ops (create / patchData / patchMeta / reorderChildren / delete) to a page in one transaction. Delete ops require blocks:delete + confirmation.',
  },

  // ── posts ──
  list_posts: {
    name: 'list_posts',
    resource: 'posts',
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary: 'List blog posts (optionally including archived).',
  },
  get_post: {
    name: 'get_post',
    resource: 'posts',
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary: 'Read a single post (fields + block body).',
  },
  create_post: {
    name: 'create_post',
    resource: 'posts',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Create a new blog post. Returns the new post id.',
  },
  update_post: {
    name: 'update_post',
    resource: 'posts',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: "Update a post's fields (title, slug, status, SEO, body).",
  },
  delete_post: {
    name: 'delete_post',
    resource: 'posts',
    action: 'delete',
    minRole: 'admin',
    tier: 'destructive',
    summary: 'Move a post to trash (soft delete).',
  },

  // ── projects ──
  list_projects: {
    name: 'list_projects',
    resource: 'projects',
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary: 'List portfolio projects (optionally including archived).',
  },
  get_project: {
    name: 'get_project',
    resource: 'projects',
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary: 'Read a single project (fields + block body).',
  },
  create_project: {
    name: 'create_project',
    resource: 'projects',
    action: 'write',
    // Route uses adminPolicy('createProject') = ['admin'] (unlike create_page /
    // create_post which allow editors), so gate disclosure at admin to match.
    minRole: 'admin',
    tier: 'write',
    summary: 'Create a new portfolio project. Returns the new project id.',
  },
  update_project: {
    name: 'update_project',
    resource: 'projects',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: "Update a project's fields (title, slug, status, SEO, body).",
  },
  delete_project: {
    name: 'delete_project',
    resource: 'projects',
    action: 'delete',
    minRole: 'admin',
    tier: 'destructive',
    summary: 'Move a project to trash (soft delete).',
  },

  // ── media ──
  list_media: {
    name: 'list_media',
    resource: 'media',
    action: 'read',
    minRole: 'editor',
    tier: 'read',
    summary: 'List media library items (cursor-paginated).',
  },
  get_media: {
    name: 'get_media',
    resource: 'media',
    action: 'read',
    minRole: 'editor',
    tier: 'read',
    summary: 'Read a single media item (metadata + references).',
  },
  delete_media: {
    name: 'delete_media',
    resource: 'media',
    action: 'delete',
    minRole: 'admin',
    tier: 'destructive',
    summary: 'Delete a media item (blocked if still referenced).',
  },

  // ── nav ──
  get_nav: {
    name: 'get_nav',
    resource: 'nav',
    action: 'read',
    minRole: 'viewer',
    tier: 'read',
    summary: 'Read the header + footer navigation menus.',
  },
  update_nav: {
    name: 'update_nav',
    resource: 'nav',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary: 'Replace the navigation menus (header + footer trees).',
  },

  // ── settings ──
  get_settings: {
    name: 'get_settings',
    resource: 'settings',
    action: 'read',
    minRole: 'admin',
    tier: 'read',
    summary: 'Read content + branding settings (non-secret).',
  },
  update_settings: {
    name: 'update_settings',
    resource: 'settings',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Update content + branding settings (per-key allowlist; secrets/security excluded).',
  },

  // ── pages: lifecycle extras ──
  restore_page: {
    name: 'restore_page',
    resource: 'pages',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Restore a soft-deleted page from the trash. NOTE: it returns as a DRAFT (published=0) by design — re-publish with update_page({published:true, version}) to make it public again.',
  },
  page_preview_token: {
    name: 'page_preview_token',
    resource: 'pages',
    action: 'read',
    minRole: 'editor',
    tier: 'read',
    summary: 'Mint a signed preview token/URL for an unpublished page.',
  },

  // ── posts: lifecycle extras ──
  restore_post: {
    name: 'restore_post',
    resource: 'posts',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary: 'Restore a soft-deleted post from the trash.',
  },

  // ── projects: lifecycle extras ──
  restore_project: {
    name: 'restore_project',
    resource: 'projects',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary: 'Restore a soft-deleted project from the trash.',
  },
  reorder_projects: {
    name: 'reorder_projects',
    resource: 'projects',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Reorder the featured project list (full ordered id set).',
  },
  update_project_section: {
    name: 'update_project_section',
    resource: 'projects',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: "Update one section of a project's body block tree.",
  },
  project_preview_token: {
    name: 'project_preview_token',
    resource: 'projects',
    action: 'read',
    minRole: 'editor',
    tier: 'read',
    summary: 'Mint a signed preview token/URL for an unpublished project.',
  },

  // ── blocks: single-block ops + library ──
  create_block: {
    name: 'create_block',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary:
      'Create a single block (section/column/widget). For multi-op edits prefer edit_page.',
  },
  delete_block: {
    name: 'delete_block',
    resource: 'blocks',
    action: 'delete',
    minRole: 'editor',
    tier: 'destructive',
    summary: 'Soft-delete a single block (and its descendants).',
  },
  duplicate_block: {
    name: 'duplicate_block',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Duplicate a block (and its subtree) in place.',
  },
  restore_block: {
    name: 'restore_block',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Restore a soft-deleted block.',
  },
  reorder_blocks: {
    name: 'reorder_blocks',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Reorder blocks under a parent (incl. cross-parent moves).',
  },

  // ── media: upload ──
  upload_media: {
    name: 'upload_media',
    resource: 'media',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Upload a media file (base64) with alt text to the library.',
  },

  // ── saved blocks (reusable block library — `blocks` resource) ──
  list_saved_blocks: {
    name: 'list_saved_blocks',
    resource: 'blocks',
    action: 'read',
    minRole: 'editor',
    tier: 'read',
    summary: 'List saved (reusable) blocks in the library.',
  },
  get_saved_block: {
    name: 'get_saved_block',
    resource: 'blocks',
    action: 'read',
    minRole: 'editor',
    tier: 'read',
    summary: 'Read one saved block (its block subtree).',
  },
  create_saved_block: {
    name: 'create_saved_block',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Save a block subtree to the reusable library.',
  },
  delete_saved_block: {
    name: 'delete_saved_block',
    resource: 'blocks',
    action: 'delete',
    minRole: 'editor',
    tier: 'destructive',
    summary: 'Delete a saved block from the library.',
  },
  instantiate_saved_block: {
    name: 'instantiate_saved_block',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Insert a saved block into a page/parent (clones the subtree).',
  },

  // ── templates ──
  instantiate_template: {
    name: 'instantiate_template',
    resource: 'blocks',
    action: 'write',
    minRole: 'editor',
    tier: 'write',
    summary: 'Instantiate a section template into a page (clones its blocks).',
  },

  // ── sync (local↔remote content sync; admin-only on every route) ──
  sync_list_targets: {
    name: 'sync_list_targets',
    resource: 'sync',
    action: 'read',
    minRole: 'admin',
    tier: 'read',
    summary:
      'List the configured sync targets (redacted: url + last4 stub only, never the token) and which one is the default.',
  },
  sync_configure_target: {
    name: 'sync_configure_target',
    resource: 'sync',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Add or update a named sync target (name, http(s) url, admin API token, optional accountLabel). The token is encrypted at rest and never echoed back.',
  },
  sync_remove_target: {
    name: 'sync_remove_target',
    resource: 'sync',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary: 'Remove a named sync target.',
  },
  sync_pull: {
    name: 'sync_pull',
    resource: 'sync',
    action: 'write',
    minRole: 'admin',
    // Destructive: a pull wholesale-replaces this install's content. The handler
    // hand-rolls a confirm gate (no read-only variant), and the catalog tier
    // reflects the true blast radius for any UI/telemetry that reads it.
    tier: 'destructive',
    summary:
      'Pull a remote source INTO this install (REPLACES this install’s entire content — requires confirm:true). Source = a configured target name or a raw http(s) url + inline token; omit to use the default target.',
  },
  sync_push: {
    name: 'sync_push',
    resource: 'sync',
    action: 'write',
    minRole: 'admin',
    tier: 'destructive',
    summary:
      'Push THIS install’s content to a remote target, REPLACING the target’s content. Pass dryRun:true to validate against the target without writing anything (no confirm needed); a real push requires confirmation. force overwrites even if the target drifted.',
  },

  // ── backups (cloud + local archive backups; admin-only on every route) ──
  backup_now: {
    name: 'backup_now',
    resource: 'backups',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Start a backup now (detached). includeEnv:true bundles secrets for full disaster recovery (requires a passphrase when the destination is cloud). Poll backup_status to watch progress.',
  },
  backup_list: {
    name: 'backup_list',
    resource: 'backups',
    action: 'read',
    minRole: 'admin',
    tier: 'read',
    summary: 'List local backup archives (file, size, createdAt, encrypted, version).',
  },
  backup_status: {
    name: 'backup_status',
    resource: 'backups',
    action: 'read',
    minRole: 'admin',
    tier: 'read',
    summary:
      'Read the live backup or restore progress (kind:"backup" default, or "restore").',
  },
  backup_remote_list: {
    name: 'backup_remote_list',
    resource: 'backups',
    action: 'read',
    minRole: 'admin',
    tier: 'read',
    summary:
      'List the remote backups stored with a connected cloud provider (gdrive|onedrive).',
  },
  backup_restore: {
    name: 'backup_restore',
    resource: 'backups',
    action: 'delete',
    minRole: 'admin',
    tier: 'destructive',
    summary:
      'Restore from an existing LOCAL backup archive. THIS OVERWRITES ALL LIVE CONTENT with the archive. restoreEnv:true ALSO overwrites the install’s secrets/env — leave it false unless you mean to.',
  },
  backup_restore_from_cloud: {
    name: 'backup_restore_from_cloud',
    resource: 'backups',
    action: 'delete',
    minRole: 'admin',
    tier: 'destructive',
    summary:
      'Download a remote backup (provider + remoteId) and restore from it. THIS OVERWRITES ALL LIVE CONTENT. restoreEnv:true ALSO overwrites the install’s secrets/env — leave it false unless you mean to.',
  },
  backup_delete: {
    name: 'backup_delete',
    resource: 'backups',
    action: 'delete',
    minRole: 'admin',
    tier: 'destructive',
    summary: 'Move a local backup archive to trash (it is never hard-removed).',
  },
  backup_configure: {
    name: 'backup_configure',
    resource: 'backups',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Update backup options — destination (local|gdrive|onedrive), remoteRetention, keepLocalCopy, passphrase encryption, schedule. Only the fields you pass change; the rest are read from the current config and preserved.',
  },
  backup_connect_drive: {
    name: 'backup_connect_drive',
    resource: 'backups',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Start the OAuth device flow to connect a cloud destination (gdrive|onedrive). Returns a userCode + verificationUrl the HUMAN opens in a browser to approve — there is no CMS login step. Then call backup_connect_poll until it reports success.',
  },
  backup_connect_poll: {
    name: 'backup_connect_poll',
    resource: 'backups',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Poll a pending cloud-connect device flow (gdrive|onedrive). Returns pending / slow_down / success / denied / expired until the human approves the code.',
  },
  backup_disconnect_drive: {
    name: 'backup_disconnect_drive',
    resource: 'backups',
    action: 'write',
    minRole: 'admin',
    tier: 'write',
    summary:
      'Disconnect a cloud destination (gdrive|onedrive): revoke the token (best-effort) and wipe the stored connection.',
  },
})

export type McpToolName = keyof typeof MCP_TOOLS

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 }

// True iff the token's scopes permit this tool. null-resource tools (meta) are
// always permitted; otherwise defer to the shared scope predicate.
export function toolPermittedByScope(
  scopes: string[] | null,
  tool: McpToolSpec,
): boolean {
  if (tool.resource === null) return true
  return tokenAllowsScope(scopes, tool.resource, tool.action)
}

export function toolPermittedByRole(role: Role, tool: McpToolSpec): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[tool.minRole]
}

export function toolEnabled(
  role: Role,
  scopes: string[] | null,
  tool: McpToolSpec,
): boolean {
  return toolPermittedByRole(role, tool) && toolPermittedByScope(scopes, tool)
}

export class ToolScopeError extends Error {
  constructor(public toolName: string) {
    super('forbidden_scope')
  }
}

// Call-time re-check (defence in depth). Throws ToolScopeError → the handler
// returns an isError MCP result the agent can read + adapt to.
export function assertToolScope(
  role: Role,
  scopes: string[] | null,
  tool: McpToolSpec,
): void {
  if (!toolEnabled(role, scopes, tool)) throw new ToolScopeError(tool.name)
}
