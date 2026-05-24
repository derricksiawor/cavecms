'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { Role } from '@/lib/auth/requireRole'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'
import { NAV, isActive, buildNavTree, type NavItem } from './nav'

// Single nav row — see Sidebar.tsx for the rationale. Duplicated
// here so MobileNav stays a single self-contained file; both
// surfaces share the same NAV definition + buildNavTree, so a
// future top-level item lands in both places automatically.
function MobileNavRow({
  item,
  pathname,
  nested = false,
  onClick,
}: {
  item: NavItem
  pathname: string
  nested?: boolean
  onClick?: () => void
}) {
  const active = isActive(item.href, pathname)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? `flex items-center gap-3 ${nested ? 'py-2 text-[13px]' : 'py-3'} text-copper-300 transition-colors`
          : `flex items-center gap-3 ${nested ? 'py-2 text-[13px]' : 'py-3'} ${nested ? 'text-cream-50/75' : 'text-cream-50'} transition-colors hover:text-copper-300`
      }
    >
      <Icon
        size={nested ? 13 : 16}
        strokeWidth={1.8}
        className={active ? 'text-copper-400' : 'text-cream-50/60'}
      />
      {item.label}
    </Link>
  )
}

// Mobile-only nav. The desktop Sidebar (Sidebar.tsx) is `hidden lg:flex`
// so below lg the only navigation surface is this drawer, toggled by
// the hamburger button in the Topbar. Closes automatically on route
// change so a click on a nav link doesn't leave the panel open behind
// the new page.
export function AdminMobileNav({ role }: { role: Role }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const items = NAV.filter((i) => i.roles.includes(role))
  const tree = buildNavTree(items)

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Escape-key dismiss for keyboard users + lock body scroll while
  // the drawer is open so the underlying page doesn't scroll behind
  // it on iOS.
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
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-warm-stone/30 text-near-black transition-colors hover:border-copper-400 lg:hidden"
      >
        <svg
          width="18"
          height="14"
          viewBox="0 0 18 14"
          fill="none"
          aria-hidden="true"
        >
          {open ? (
            <>
              <line x1="2" y1="2" x2="16" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="16" y1="2" x2="2" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </>
          ) : (
            <>
              <line x1="1" y1="2" x2="17" y2="2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="1" y1="7" x2="17" y2="7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <line x1="1" y1="12" x2="17" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </>
          )}
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Admin navigation"
            className="fixed inset-y-0 right-0 z-50 flex w-72 flex-col bg-near-black px-8 py-10 text-cream-50 shadow-2xl lg:hidden"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-400">
              Best World
            </p>
            <p className="mt-2 font-serif text-2xl font-bold tracking-tight text-cream-50">
              Properties
            </p>
            <nav className="mt-12 flex flex-col gap-1 text-sm font-medium tracking-wide">
              {tree.map((node) => {
                const sectionActive =
                  isActive(node.item.href, pathname) ||
                  node.children.some((c) => isActive(c.href, pathname))
                return (
                  <div key={node.item.href} className="flex flex-col">
                    <MobileNavRow item={node.item} pathname={pathname} />
                    {node.children.length > 0 && (
                      <div
                        className={
                          sectionActive
                            ? 'mt-0.5 ml-[7px] flex flex-col border-l border-copper-500/40 pl-4 transition-colors'
                            : 'mt-0.5 ml-[7px] flex flex-col border-l border-cream-50/10 pl-4 transition-colors'
                        }
                      >
                        {node.children.map((c) => (
                          <MobileNavRow key={c.href} item={c} pathname={pathname} nested />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </nav>
          </aside>
        </>
      )}
    </>
  )
}
