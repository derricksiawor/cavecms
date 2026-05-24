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
  HelpCircle,
  AtSign,
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
  { label: 'Pages', href: '/admin/pages', roles: ['admin', 'editor'], icon: FileEdit },
  { label: 'Media', href: '/admin/media', roles: ['admin', 'editor'], icon: Library },
  { label: 'Trash', href: '/admin/trash', roles: ['admin', 'editor'], icon: Trash2 },
  { label: 'Users', href: '/admin/users', roles: ['admin'], icon: UsersIcon },
  { label: 'Settings', href: '/admin/settings', roles: ['admin'], icon: SettingsIcon },
  { label: 'Security', href: '/admin/settings/security', roles: ['admin'], icon: Lock, parent: '/admin/settings' },
  { label: 'Integrations', href: '/admin/settings/integrations', roles: ['admin'], icon: Plug, parent: '/admin/settings' },
  { label: 'Activity', href: '/admin/activity', roles: ['admin'], icon: ShieldCheck },
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
