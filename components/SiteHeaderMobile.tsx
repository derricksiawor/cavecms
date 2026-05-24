'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X, ChevronDown } from 'lucide-react'
import { isLikelyExternal } from '@/lib/url/external'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'
import { isNavLinkActive, type HeaderThemeClasses } from '@/lib/cms/headerTheme'

const PROJECTS_HREF = '/projects'

// Mobile drawer for SiteHeader. Hamburger button below `lg`. Opens a
// slide-in overlay with the same nav items + CTA as the desktop bar.
// Kept in a sibling client component so the SiteHeader itself stays
// server-rendered.

interface NavItem {
  label: string
  href: string
}

interface Cta {
  text: string
  href: string
  openInNew?: boolean
}

interface Project {
  slug: string
  name: string
}

export function SiteHeaderMobile({
  navItems,
  cta,
  theme,
  projects,
}: {
  navItems: NavItem[]
  cta: Cta | null
  theme: HeaderThemeClasses
  projects: Project[]
}) {
  // usePathname() (not a server-passed prop) — the root layout that
  // mounts <SiteHeader /> is cached across client-side navigations,
  // so a server-resolved pathname freezes at first load and the active
  // highlight sticks on the wrong link as the user navigates.
  const pathname = usePathname() ?? ''
  const [open, setOpen] = useState(false)
  // Auto-expand the Projects section when the user opens the drawer
  // from a project detail page — they're more likely to want to jump
  // to a sibling project than to a different top-level section.
  const [projectsExpanded, setProjectsExpanded] = useState(() =>
    pathname.startsWith(PROJECTS_HREF + '/'),
  )

  // Close on route change — we don't have direct access to the route
  // change event from a server-routed Link, so listen for the popstate
  // + click bubbling up. Simpler: close whenever an internal link is
  // clicked (handled inline below).
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
              {navItems.map((item) => {
                const isProjectsItem =
                  item.href === PROJECTS_HREF && projects.length > 0
                if (isProjectsItem) {
                  const parentActive = isNavLinkActive(item.href, pathname)
                  return (
                    <div
                      key={`${item.label}-${item.href}`}
                      className="flex flex-col"
                    >
                      <button
                        type="button"
                        aria-expanded={projectsExpanded}
                        aria-controls="mobile-projects-submenu"
                        onClick={() => setProjectsExpanded((v) => !v)}
                        className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-base font-medium transition-colors ${
                          parentActive
                            ? theme.drawerNavActive
                            : theme.drawerNav
                        }`}
                      >
                        <span>{item.label}</span>
                        <ChevronDown
                          size={18}
                          strokeWidth={2}
                          aria-hidden="true"
                          className={`transition-transform duration-200 ${
                            projectsExpanded ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                      {projectsExpanded && (
                        <ul
                          id="mobile-projects-submenu"
                          className="mt-1 flex flex-col gap-0.5 pl-3"
                        >
                          <li>
                            <Link
                              href={item.href}
                              onClick={() => setOpen(false)}
                              aria-current={
                                pathname === item.href ? 'page' : undefined
                              }
                              className={`block rounded-xl px-4 py-2.5 text-sm font-medium uppercase tracking-[0.18em] transition-colors ${
                                pathname === item.href
                                  ? theme.drawerNavActive
                                  : theme.drawerNav
                              }`}
                            >
                              View all projects
                            </Link>
                          </li>
                          {projects.map((p) => {
                            const href = `/projects/${p.slug}`
                            const active = pathname === href
                            return (
                              <li key={p.slug}>
                                <Link
                                  href={href}
                                  onClick={() => setOpen(false)}
                                  aria-current={active ? 'page' : undefined}
                                  className={`block rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                                    active
                                      ? theme.drawerNavActive
                                      : theme.drawerNav
                                  }`}
                                >
                                  {p.name}
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
                    key={`${item.label}-${item.href}`}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    target={isLikelyExternal(item.href) ? '_blank' : undefined}
                    rel={isLikelyExternal(item.href) ? 'noopener noreferrer' : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center justify-between rounded-xl px-4 py-3 text-base font-medium transition-colors ${
                      active ? theme.drawerNavActive : theme.drawerNav
                    }`}
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
                className={`mt-6 inline-flex w-fit items-center justify-center rounded-full px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all ${theme.drawerCta}`}
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
