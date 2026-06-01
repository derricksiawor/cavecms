'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { isLikelyExternal, externalRel } from '@/lib/url/external'
import { isNavLinkActive, type HeaderThemeClasses } from '@/lib/cms/headerTheme'

// Desktop nav links. Client component so the "active" class recomputes
// on every client-side navigation — the root layout that mounts
// <SiteHeader /> is cached across client navs, which means a
// server-resolved pathname would freeze at first load. usePathname()
// re-runs per navigation and keeps the active highlight honest.
//
// The Projects entry (detected by href === '/projects') renders a
// hover-and-focus dropdown of every published project. Clicking the
// "Projects" label itself still navigates to /projects — the dropdown
// is additive, not a replacement for the index link.

interface NavItem {
  label: string
  href: string
}

interface Project {
  slug: string
  name: string
}

const PROJECTS_HREF = '/projects'
const CLOSE_GRACE_MS = 160

export function SiteHeaderNav({
  navItems,
  theme,
  projects,
  initialPathname,
}: {
  navItems: NavItem[]
  theme: HeaderThemeClasses
  projects: Project[]
  // Server-resolved path (x-pathname header). Used for SSR + the first
  // client render so the active-link class/aria-current match exactly;
  // usePathname() takes over after mount to stay reactive on soft navs.
  // Without this, usePathname() is empty during SSR (this lives in the
  // cached root layout) → the active link renders inactive on the
  // server, active on the client → hydration mismatch.
  initialPathname: string
}) {
  const livePathname = usePathname()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const pathname = mounted ? (livePathname ?? '') : initialPathname
  return (
    <nav className="ml-auto hidden items-center gap-8 lg:flex">
      {navItems.map((item) => {
        const isProjectsItem =
          item.href === PROJECTS_HREF && projects.length > 0
        if (isProjectsItem) {
          return (
            <ProjectsDropdown
              key={`${item.label}-${item.href}`}
              item={item}
              projects={projects}
              theme={theme}
              pathname={pathname}
            />
          )
        }
        const active = isNavLinkActive(item.href, pathname)
        return (
          <Link
            key={`${item.label}-${item.href}`}
            href={item.href}
            rel={externalRel(item.href, true)}
            target={isLikelyExternal(item.href) ? '_blank' : undefined}
            aria-current={active ? 'page' : undefined}
            className={`text-sm font-medium transition-[color] duration-200 ${
              active ? theme.navActive : `${theme.nav} ${theme.navHover}`
            }`}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

function ProjectsDropdown({
  item,
  projects,
  theme,
  pathname,
}: {
  item: NavItem
  projects: Project[]
  theme: HeaderThemeClasses
  pathname: string
}) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const parentActive = isNavLinkActive(item.href, pathname)

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = () => {
    clearCloseTimer()
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS)
  }
  const openNow = () => {
    clearCloseTimer()
    setOpen(true)
  }

  // Esc + click-outside close. Keyboard users get focus-within open
  // (handled via onFocus / onBlur on the wrapper below).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  // Clean up the close timer if the component unmounts mid-grace.
  useEffect(() => () => clearCloseTimer(), [])

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={(e) => {
        // Only close if focus leaves the wrapper entirely.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          scheduleClose()
        }
      }}
    >
      <Link
        href={item.href}
        aria-current={parentActive ? 'page' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 text-sm font-medium transition-[color] duration-200 ${
          parentActive ? theme.navActive : `${theme.nav} ${theme.navHover}`
        }`}
      >
        {item.label}
        <ChevronDown
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className={`transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </Link>

      {open && (
        <div
          role="menu"
          aria-label={`${item.label} submenu`}
          className={`absolute left-1/2 top-full z-40 mt-3 w-72 -translate-x-1/2 overflow-hidden rounded-2xl border shadow-[0_30px_60px_-20px_rgba(5,5,5,0.4)] ${theme.drawer} ${
            theme.bar.includes('obsidian')
              ? 'border-champagne/20'
              : 'border-obsidian/10'
          }`}
        >
          <ul
            className="max-h-[60vh] overflow-y-auto py-2"
            // Keep the hover bridge alive when the cursor enters the
            // panel (otherwise the wrapper's mouseleave fires and the
            // panel disappears mid-click).
            onMouseEnter={openNow}
            onMouseLeave={scheduleClose}
          >
            {projects.map((p) => {
              const href = `/projects/${p.slug}`
              const active = pathname === href
              return (
                <li key={p.slug}>
                  <Link
                    role="menuitem"
                    href={href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={`block px-5 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? theme.drawerNavActive
                        : `${theme.drawerNav}`
                    }`}
                  >
                    {p.name}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
