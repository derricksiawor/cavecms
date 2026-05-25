'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { Role } from '@/lib/auth/requireRole'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'
import { Menu, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { NAV, isActive, buildNavTree, type NavItem } from './nav'
import { Wordmark } from '@/components/Wordmark'

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
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-warm-stone/30 text-near-black transition-all duration-standard ease-standard hover:border-copper-400 hover:bg-cream-50 active:scale-95 lg:hidden"
      >
        {/* Lucide icons — no hand-rolled SVG. The cross-fade between
            hamburger / X gives a soft state-change cue that pairs
            with the drawer slide. */}
        <AnimatePresence mode="wait" initial={false}>
          {open ? (
            <motion.span
              key="x"
              initial={{ rotate: -45, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: 45, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="inline-flex"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </motion.span>
          ) : (
            <motion.span
              key="menu"
              initial={{ rotate: 45, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: -45, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="inline-flex"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Admin navigation"
              className="fixed inset-y-0 right-0 z-50 flex w-72 flex-col bg-near-black px-8 py-10 text-cream-50 shadow-2xl lg:hidden"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              // Spring-based slide — feels light + organic, not a
              // hard linear ease. Damping 30 keeps it from bouncing
              // past the closed edge.
              transition={{ type: 'spring', stiffness: 320, damping: 32, mass: 0.7 }}
            >
              <motion.p
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08, duration: 0.3 }}
                className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-400"
              >
                Admin
              </motion.p>
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12, duration: 0.3 }}
                className="mt-2"
              >
                <Wordmark label="CaveCMS" />
              </motion.div>
              <motion.nav
                className="mt-12 flex flex-col gap-1 text-sm font-medium tracking-wide"
                initial="hidden"
                animate="visible"
                variants={{
                  visible: {
                    transition: { staggerChildren: 0.04, delayChildren: 0.18 },
                  },
                  hidden: {},
                }}
              >
                {tree.map((node) => {
                  const sectionActive =
                    isActive(node.item.href, pathname) ||
                    node.children.some((c) => isActive(c.href, pathname))
                  return (
                    <motion.div
                      key={node.item.href}
                      className="flex flex-col"
                      variants={{
                        hidden: { opacity: 0, x: 16 },
                        visible: {
                          opacity: 1,
                          x: 0,
                          transition: { duration: 0.32, ease: 'easeOut' },
                        },
                      }}
                    >
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
                    </motion.div>
                  )
                })}
              </motion.nav>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
