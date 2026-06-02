'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { isLikelyExternal, externalRel } from '@/lib/url/external'
import { isNavLinkActive, type HeaderThemeClasses } from '@/lib/cms/headerTheme'
import type { NavItem, NavChild } from '@/lib/cms/navTypes'

// Desktop nav links. Client component so the "active" class recomputes
// on every client-side navigation — the root layout that mounts
// <SiteHeader /> is cached across client navs, which means a
// server-resolved pathname would freeze at first load. usePathname()
// re-runs per navigation and keeps the active highlight honest.
//
// Dropdowns: any item with `children` renders a hover/focus dropdown of
// those sub-links (operator-authored, via Settings → Header). The Projects
// entry (href === '/projects') ALSO auto-builds a dropdown of every
// published project — but ONLY when the operator hasn't authored their own
// children for it (manual children win). Clicking a parent that has its own
// href still navigates; a parent with a blank href is a dropdown-only toggle.

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
  initialPathname: string
}) {
  const livePathname = usePathname()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const pathname = mounted ? (livePathname ?? '') : initialPathname
  return (
    <nav className="ml-auto hidden items-center gap-8 lg:flex">
      {navItems.map((item, i) => {
        // 1) Operator-authored submenu wins.
        if (item.children && item.children.length > 0) {
          return (
            <NavDropdown
              key={`${i}-${item.label}-${item.href}`}
              trigger={{ label: item.label, href: item.href }}
              links={item.children}
              theme={theme}
              pathname={pathname}
            />
          )
        }
        // 2) Auto-Projects dropdown (only when no manual children).
        if (item.href === PROJECTS_HREF && projects.length > 0) {
          return (
            <NavDropdown
              key={`${i}-${item.label}-${item.href}`}
              trigger={{ label: item.label, href: item.href }}
              links={projects.map((p) => ({ label: p.name, href: `/projects/${p.slug}` }))}
              theme={theme}
              pathname={pathname}
            />
          )
        }
        // 3) Flat link.
        const active = isNavLinkActive(item.href, pathname)
        return (
          <Link
            key={`${i}-${item.label}-${item.href}`}
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

// Generic dropdown — renders a trigger plus a hover/focus panel of links.
// Trigger is a <Link> when `trigger.href` is non-empty (clicking navigates,
// the dropdown is additive) or a <button> when blank (dropdown-only toggle).
function NavDropdown({
  trigger,
  links,
  theme,
  pathname,
}: {
  trigger: { label: string; href: string }
  links: NavChild[]
  theme: HeaderThemeClasses
  pathname: string
}) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const parentActive =
    isNavLinkActive(trigger.href, pathname) ||
    links.some((l) => isNavLinkActive(l.href, pathname))
  const hasHref = trigger.href.trim() !== ''

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

  useEffect(() => () => clearCloseTimer(), [])

  const triggerClass = `inline-flex items-center gap-1 text-sm font-medium transition-[color] duration-200 ${
    parentActive ? theme.navActive : `${theme.nav} ${theme.navHover}`
  }`

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          scheduleClose()
        }
      }}
    >
      {hasHref ? (
        <Link
          href={trigger.href}
          aria-current={parentActive ? 'page' : undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          className={triggerClass}
        >
          {trigger.label}
          <ChevronDown
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </Link>
      ) : (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={triggerClass}
        >
          {trigger.label}
          <ChevronDown
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>
      )}

      {open && (
        <div
          role="menu"
          aria-label={`${trigger.label} submenu`}
          className={`absolute left-1/2 top-full z-40 mt-3 w-72 -translate-x-1/2 overflow-hidden rounded-2xl border shadow-[0_30px_60px_-20px_rgba(5,5,5,0.4)] ${theme.drawer} ${
            theme.bar.includes('obsidian') ? 'border-champagne/20' : 'border-obsidian/10'
          }`}
        >
          <ul
            className="max-h-[60vh] overflow-y-auto py-2"
            // Keep the hover bridge alive when the cursor enters the panel.
            onMouseEnter={openNow}
            onMouseLeave={scheduleClose}
          >
            {links.map((l, li) => {
              const active = isNavLinkActive(l.href, pathname)
              return (
                <li key={`${li}-${l.label}-${l.href}`}>
                  <Link
                    role="menuitem"
                    href={l.href}
                    rel={externalRel(l.href, true)}
                    target={isLikelyExternal(l.href) ? '_blank' : undefined}
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={`block px-5 py-2.5 text-sm font-medium transition-colors ${
                      active ? theme.drawerNavActive : `${theme.drawerNav}`
                    }`}
                  >
                    {l.label}
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
