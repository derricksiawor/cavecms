import type { Role } from '@/lib/auth/requireRole'
import {
  LayoutDashboard,
  Building2,
  Inbox,
  FileText,
  FileEdit,
  Library,
  Trash2,
  Users as UsersIcon,
  Settings as SettingsIcon,
  ShieldCheck,
  Lock,
  Plug,
  KeyRound,
  HelpCircle,
  AtSign,
  Download,
  Archive,
  Mail,
  Sparkles,
  Palette,
  Type,
  Signpost,
  FolderTree,
  // blog-system worktree (Phase 5): Permalinks settings sub-page icon.
  Link2,
  // blog-system worktree (Phase 6): Blog settings sub-page icon.
  Newspaper,
  TrendingUp,
  LayoutTemplate,
  Share2,
  Map as MapIcon,
  PlugZap,
  Cookie,
  UserCircle,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  label: string
  href: string
  roles: Role[]
  icon: LucideIcon
  /** Optional href of a parent NavItem. When set, this item renders
   *  indented underneath the named parent in both the desktop sidebar
   *  and mobile drawer. Used to express child routes (e.g. Security
   *  under Settings) as a visual sub-list instead of a sibling. */
  parent?: string
}

// Single source of truth for admin navigation. Used by both the
// desktop Sidebar (sticky aside) and the mobile drawer (Topbar's
// hamburger menu). Items are filtered by role at render — viewer-
// only surfaces (Dashboard, Leads, Help) stay visible; admin-only
// surfaces (Users, Settings, Activity) disappear for non-admins.
//
// Each entry carries a lucide icon — the sidebar renders the icon
// beside the label so the nav reads visually, not just textually.
export const NAV: readonly NavItem[] = [
  { label: 'Dashboard', href: '/admin', roles: ['admin', 'editor', 'viewer'], icon: LayoutDashboard },
  { label: 'Projects', href: '/admin/projects', roles: ['admin', 'editor'], icon: Building2 },
  { label: 'Leads', href: '/admin/leads', roles: ['admin', 'editor', 'viewer'], icon: Inbox },
  // Newsletter is the first child of Leads. The `parent` field flips
  // isActive() onto its `hasChildren` branch for /admin/leads — strict
  // equality only. If a future PR adds a /admin/leads/[id] detail
  // route, the Leads parent will NO LONGER light up on /admin/leads/123
  // because hasChildren is true. Revisit isActive() at that point —
  // the current logic is correct only while every child of /admin/leads
  // has a stable, known href (i.e. no dynamic [id] segments).
  { label: 'Newsletter', href: '/admin/leads/newsletter', roles: ['admin', 'editor', 'viewer'], icon: AtSign, parent: '/admin/leads' },
  { label: 'Posts', href: '/admin/blog', roles: ['admin', 'editor'], icon: FileText },
  // Categories & tags — child of Posts. Strict-equality isActive() lights up
  // /admin/blog only on /admin/blog exactly (Posts gains a child here), and
  // this child on /admin/blog/taxonomy. The post EDITOR route /admin/blog/[id]
  // therefore no longer lights up Posts (hasChildren flips it to strict-eq) —
  // acceptable: the editor is a leaf the breadcrumb/back-link covers, and the
  // sidebar Posts item lighting up only on the list is the cleaner signal.
  { label: 'Categories', href: '/admin/blog/taxonomy', roles: ['admin', 'editor'], icon: FolderTree, parent: '/admin/blog' },
  { label: 'Pages', href: '/admin/pages', roles: ['admin', 'editor'], icon: FileEdit },
  { label: 'Media', href: '/admin/media', roles: ['admin', 'editor'], icon: Library },
  { label: 'Trash', href: '/admin/trash', roles: ['admin', 'editor'], icon: Trash2 },
  { label: 'Users', href: '/admin/users', roles: ['admin'], icon: UsersIcon },
  { label: 'Settings', href: '/admin/settings', roles: ['admin'], icon: SettingsIcon },
  { label: 'Theme', href: '/admin/settings/theme', roles: ['admin'], icon: Palette, parent: '/admin/settings' },
  { label: 'Typography', href: '/admin/settings/typography', roles: ['admin'], icon: Type, parent: '/admin/settings' },
  { label: 'Security', href: '/admin/settings/security', roles: ['admin'], icon: Lock, parent: '/admin/settings' },
  { label: 'Integrations', href: '/admin/settings/integrations', roles: ['admin'], icon: Plug, parent: '/admin/settings' },
  { label: 'Cookies', href: '/admin/settings/cookies', roles: ['admin'], icon: Cookie, parent: '/admin/settings' },
  { label: 'API Tokens', href: '/admin/settings/api-tokens', roles: ['admin'], icon: KeyRound, parent: '/admin/settings' },
  { label: 'Redirects', href: '/admin/settings/redirects', roles: ['admin'], icon: Signpost, parent: '/admin/settings' },
  { label: 'Email', href: '/admin/settings/email', roles: ['admin'], icon: Mail, parent: '/admin/settings' },
  { label: 'AI Assistant', href: '/admin/settings/ai', roles: ['admin'], icon: Sparkles, parent: '/admin/settings' },
  { label: 'Updates', href: '/admin/settings/updates', roles: ['admin'], icon: Download, parent: '/admin/settings' },
  { label: 'Backups', href: '/admin/settings/backups', roles: ['admin'], icon: Archive, parent: '/admin/settings' },
  // ── blog-system worktree (Phase 5): Permalinks (appended so a parallel SEO-
  //    settings worktree's own appended entry merges cleanly beside this one) ──
  { label: 'Permalinks', href: '/admin/settings/permalinks', roles: ['admin'], icon: Link2, parent: '/admin/settings' },
  // ── blog-system worktree (Phase 6): Blog (appended in the same fenced region
  //    as Permalinks so the parallel SEO-settings worktree's appended entry
  //    merges cleanly beside both) ──
  { label: 'Blog', href: '/admin/settings/blog', roles: ['admin'], icon: Newspaper, parent: '/admin/settings' },
  // ─── SEO ───
  // Top-level group with five children. Overview (`/admin/seo`) is the
  // hub; it doubles as the group's own href, so isActive() uses strict
  // equality (it hasChildren) and the parent lights up only on the
  // dashboard itself, not on /admin/seo/titles etc.
  { label: 'SEO', href: '/admin/seo', roles: ['admin'], icon: TrendingUp },
  { label: 'Overview', href: '/admin/seo', roles: ['admin'], icon: LayoutDashboard, parent: '/admin/seo' },
  { label: 'Titles & Meta', href: '/admin/seo/titles', roles: ['admin'], icon: LayoutTemplate, parent: '/admin/seo' },
  { label: 'Social & Schema', href: '/admin/seo/social', roles: ['admin'], icon: Share2, parent: '/admin/seo' },
  { label: 'Sitemaps & Crawl', href: '/admin/seo/sitemaps', roles: ['admin'], icon: MapIcon, parent: '/admin/seo' },
  { label: 'Connect & Verify', href: '/admin/seo/connect', roles: ['admin'], icon: PlugZap, parent: '/admin/seo' },
  { label: 'Activity', href: '/admin/activity', roles: ['admin'], icon: ShieldCheck },
  { label: 'Account', href: '/admin/account', roles: ['admin', 'editor', 'viewer'], icon: UserCircle },
  { label: 'Help', href: '/admin/help', roles: ['admin', 'editor', 'viewer'], icon: HelpCircle },
]

// Active-state predicate shared between Sidebar and MobileNav.
//
// Default: pathname starts with the item href (so /admin/projects/123
// lights up "Projects"). Special cases:
//   - Dashboard `/admin` would otherwise match every admin subpath —
//     use strict equality.
//   - Any item that HAS at least one child in NAV (see hasChildren())
//     uses strict equality too. Otherwise being on a child route
//     (/admin/settings/security) would light up BOTH the parent
//     (Settings) and the child (Security), making the nested
//     hierarchy ambiguous.
export function isActive(href: string, pathname: string): boolean {
  if (href === '/admin') return pathname === '/admin'
  if (hasChildren(href)) return pathname === href
  return pathname === href || pathname.startsWith(href + '/')
}

function hasChildren(href: string): boolean {
  for (const i of NAV) if (i.parent === href) return true
  return false
}

// Group NAV into top-level items each with their immediate children
// resolved. Pure function so Sidebar + MobileNav share one canonical
// tree shape; role filtering happens AT the call site so each surface
// can hide entries independently.
export interface NavNode {
  item: NavItem
  children: NavItem[]
}
export function buildNavTree(items: readonly NavItem[]): NavNode[] {
  const byHref = new Map(items.map((i) => [i.href, i]))
  const tree: NavNode[] = []
  for (const i of items) {
    if (i.parent) continue
    const children = items.filter((c) => c.parent === i.href)
    // Filter children to those whose declared parent actually exists
    // in the visible items list (handles role-filtered surfaces where
    // a parent was hidden but children remained).
    const filtered = children.filter((c) => c.parent && byHref.has(c.parent))
    tree.push({ item: i, children: filtered })
  }
  return tree
}
