'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X, ChevronDown } from 'lucide-react'
import { isLikelyExternal } from '@/lib/url/external'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'
import {
  isNavLinkActive,
  navLinkOverrideProps,
  type ChromeOverrideProps,
  type HeaderThemeClasses,
} from '@/lib/cms/headerTheme'
import type { NavItem, NavChild } from '@/lib/cms/navTypes'

const PROJECTS_HREF = '/projects'

// Mobile drawer for SiteHeader. Hamburger button below `lg`. Opens a
// slide-in overlay with the same nav items + CTA as the desktop bar.
// Any item with children (operator-authored, or the auto-Projects list when
// no manual children exist) renders as a collapsible accordion. Kept in a
// sibling client component so the SiteHeader itself stays server-rendered.

interface Cta {
  text: string
  href: string
  openInNew?: boolean
}

interface Project {
  slug: string
  name: string
}

// Resolve the child links for an item: operator children win; otherwise the
// auto-Projects list (only for the /projects entry when projects exist).
function childLinksFor(item: NavItem, projects: Project[]): NavChild[] {
  if (item.children && item.children.length > 0) return item.children
  if (item.href === PROJECTS_HREF && projects.length > 0) {
    return projects.map((p) => ({ label: p.name, href: `/projects/${p.slug}` }))
  }
  return []
}

export function SiteHeaderMobile({
  navItems,
  cta,
  theme,
  projects,
  ctaOverride,
  navColor,
  navActiveColor,
}: {
  navItems: NavItem[]
  cta: Cta | null
  theme: HeaderThemeClasses
  projects: Project[]
  // Optional operator colour overrides (Settings → Site header) — the
  // drawer mirrors the desktop bar so the chrome reads as one surface.
  ctaOverride?: ChromeOverrideProps | null
  navColor?: string
  navActiveColor?: string
}) {
  // usePathname() (not a server-passed prop) — the root layout that
  // mounts <SiteHeader /> is cached across client-side navigations,
  // so a server-resolved pathname freezes at first load and the active
  // highlight sticks on the wrong link as the user navigates.
  const pathname = usePathname() ?? ''
  const [open, setOpen] = useState(false)
  // Auto-expand any submenu whose parent or a child matches the current path
  // — the user is more likely to want a sibling than a different section.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    // Key is index-prefixed (positional) so duplicate label+href entries get
    // distinct expand-state keys. The init loop and the render map below MUST
    // build the key identically — both iterate navItems in order, so the
    // index lines up.
    navItems.forEach((item, i) => {
      const links = childLinksFor(item, projects)
      if (links.length === 0) return
      const key = `${i}-${item.label}-${item.href}`
      if (
        isNavLinkActive(item.href, pathname) ||
        links.some((l) => isNavLinkActive(l.href, pathname))
      ) {
        init[key] = true
      }
    })
    return init
  })
  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }))

  // Operator nav-colour overrides, shared across every drawer link. The
  // helpers return '' / undefined when nothing is overridden so the
  // theme class set renders unchanged.
  const navOvCls = (active: boolean) => {
    const o = navLinkOverrideProps(active, navColor, navActiveColor)
    return o ? ` ${o.className}` : ''
  }
  const navOvStyle = (active: boolean) =>
    navLinkOverrideProps(active, navColor, navActiveColor)?.style

  // Close on Escape; lock body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    acquireScrollLock()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseScrollLock()
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className={`inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors ${theme.hamburger}`}
      >
        <Menu size={20} strokeWidth={2} />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-near-black/45 backdrop-blur-[2px]"
          />
          <aside
            role="dialog"
            aria-modal="true"
            className={`fixed right-0 top-0 z-50 flex h-full w-[88%] max-w-sm flex-col gap-2 px-6 py-6 shadow-[0_30px_60px_-20px_rgba(5,5,5,0.6)] ${theme.drawer}`}
          >
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className={`inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors ${theme.drawerClose}`}
              >
                <X size={20} strokeWidth={2} />
              </button>
            </div>
            <nav className="mt-4 flex flex-col gap-1">
              {navItems.map((item, i) => {
                const key = `${i}-${item.label}-${item.href}`
                const links = childLinksFor(item, projects)

                if (links.length > 0) {
                  const isOpen = expanded[key] ?? false
                  const parentActive =
                    isNavLinkActive(item.href, pathname) ||
                    links.some((l) => isNavLinkActive(l.href, pathname))
                  const hasHref = item.href.trim() !== ''
                  return (
                    <div key={key} className="flex flex-col">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={`mobile-submenu-${key}`}
                        onClick={() => toggle(key)}
                        className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-base font-medium transition-colors ${
                          parentActive ? theme.drawerNavActive : theme.drawerNav
                        }${navOvCls(parentActive)}`}
                        style={navOvStyle(parentActive)}
                      >
                        <span>{item.label}</span>
                        <ChevronDown
                          size={18}
                          strokeWidth={2}
                          aria-hidden="true"
                          className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                        />
                      </button>
                      {isOpen && (
                        <ul
                          id={`mobile-submenu-${key}`}
                          className="mt-1 flex flex-col gap-0.5 pl-3"
                        >
                          {hasHref && (
                            <li>
                              <Link
                                href={item.href}
                                onClick={() => setOpen(false)}
                                aria-current={pathname === item.href ? 'page' : undefined}
                                className={`block rounded-xl px-4 py-2.5 text-sm font-medium uppercase tracking-[0.18em] transition-colors ${
                                  pathname === item.href ? theme.drawerNavActive : theme.drawerNav
                                }${navOvCls(pathname === item.href)}`}
                                style={navOvStyle(pathname === item.href)}
                              >
                                Go to {item.label}
                              </Link>
                            </li>
                          )}
                          {links.map((l, ci) => {
                            const active = isNavLinkActive(l.href, pathname)
                            return (
                              <li key={`${ci}-${l.label}-${l.href}`}>
                                <Link
                                  href={l.href}
                                  onClick={() => setOpen(false)}
                                  target={isLikelyExternal(l.href) ? '_blank' : undefined}
                                  rel={isLikelyExternal(l.href) ? 'noopener noreferrer' : undefined}
                                  aria-current={active ? 'page' : undefined}
                                  className={`block rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                                    active ? theme.drawerNavActive : theme.drawerNav
                                  }${navOvCls(active)}`}
                                  style={navOvStyle(active)}
                                >
                                  {l.label}
                                </Link>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )
                }

                const active = isNavLinkActive(item.href, pathname)
                return (
                  <Link
                    key={key}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    target={isLikelyExternal(item.href) ? '_blank' : undefined}
                    rel={isLikelyExternal(item.href) ? 'noopener noreferrer' : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center justify-between rounded-xl px-4 py-3 text-base font-medium transition-colors ${
                      active ? theme.drawerNavActive : theme.drawerNav
                    }${navOvCls(active)}`}
                    style={navOvStyle(active)}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </nav>
            {cta && (
              <Link
                href={cta.href}
                onClick={() => setOpen(false)}
                target={cta.openInNew || isLikelyExternal(cta.href) ? '_blank' : undefined}
                rel={cta.openInNew || isLikelyExternal(cta.href) ? 'noopener noreferrer' : undefined}
                className={`mt-6 inline-flex w-fit items-center justify-center rounded-full px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all ${theme.drawerCta}${ctaOverride ? ` ${ctaOverride.className}` : ''}`}
                style={ctaOverride?.style}
              >
                {cta.text}
              </Link>
            )}
          </aside>
        </>
      )}
    </>
  )
}
