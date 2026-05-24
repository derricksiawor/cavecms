'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Eye } from 'lucide-react'
import type { Role } from '@/lib/auth/requireRole'
import { NAV, isActive, buildNavTree, type NavItem } from './nav'

// Single nav row — used for both top-level items and indented
// children. Visual treatment for `nested` is one notch lighter
// (smaller icon, slightly tighter padding, subdued idle state) so a
// child reads as a sub-item without competing with the parent.
function NavRow({
  item,
  pathname,
  nested = false,
}: {
  item: NavItem
  pathname: string
  nested?: boolean
}) {
  const active = isActive(item.href, pathname)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? `group flex items-center justify-between gap-3 ${nested ? 'py-2 text-[13px]' : 'py-3'} text-copper-300 transition-colors`
          : `group flex items-center justify-between gap-3 ${nested ? 'py-2 text-[13px]' : 'py-3'} ${nested ? 'text-cream-50/75' : 'text-cream-50'} transition-colors hover:text-copper-300`
      }
    >
      <span className="flex items-center gap-3">
        <Icon
          size={nested ? 13 : 16}
          strokeWidth={1.8}
          className={
            active
              ? 'text-copper-400 transition-colors'
              : 'text-cream-50/60 transition-colors group-hover:text-copper-400'
          }
        />
        {item.label}
      </span>
      <span
        aria-hidden="true"
        className={
          active
            ? `h-px ${nested ? 'w-4' : 'w-6'} bg-copper-500 opacity-100 transition-opacity`
            : `h-px ${nested ? 'w-4' : 'w-6'} bg-copper-500 opacity-0 transition-opacity group-hover:opacity-100`
        }
      />
    </Link>
  )
}

// Desktop sidebar — sticky aside visible at lg+. The mobile equivalent
// lives in components/admin/MobileNav.tsx and is toggled from the
// Topbar hamburger. The shared NAV definition lives in nav.ts.
//
// Layout: three flex regions inside the aside.
//   - Header (brand label) — pinned top, doesn't scroll.
//   - <nav>   — flex-1 + overflow-y-auto, scrolls when entries
//               exceed the viewport.
//   - Footer (Preview site) — pinned bottom, doesn't scroll.
//
// brandText is the same setting the public SiteHeader reads
// (site_header.brandText), passed down from the admin layout so a
// rename in /admin/settings flows through to both surfaces in one
// edit. `role`-filtered NAV mirrors the rest of the admin chrome.
export function AdminSidebar({ role, brandText }: { role: Role; brandText: string }) {
  const pathname = usePathname() ?? '/admin'
  const items = NAV.filter((i) => i.roles.includes(role))
  const tree = buildNavTree(items)
  return (
    // `self-start` is load-bearing: the parent flex container in
    // app/(admin)/admin/layout.tsx defaults to `align-items: stretch`,
    // which would stretch this sidebar to match the parent's full
    // content height. A stretched sticky element has no scroll room
    // to stick against. `self-start` pins the sidebar's height to the
    // declared `h-screen` so sticky has slack to engage.
    //
    // `flex flex-col` + the inner `flex-1` on <nav> gives us the
    // three-region layout (sticky header / scrolling middle / sticky
    // footer) without absolute positioning. NO outer `overflow-y-auto`
    // here — only the middle <nav> scrolls, so the header + footer
    // stay visible at any nav length.
    <aside className="sticky top-0 hidden h-screen w-72 flex-col self-start bg-near-black px-10 py-12 text-cream-50 lg:flex">
      {/* Header — sticky-feeling because it's a flex child with no
          grow. Carries the brand label from settings. */}
      <div className="shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-400">
          Admin
        </p>
        <p className="mt-2 font-serif text-2xl font-bold leading-tight tracking-tight text-cream-50">
          {brandText}
        </p>
      </div>

      {/* Scrolling middle. flex-1 takes all remaining vertical space
          between header + footer; overflow-y-auto handles a tall nav
          list. min-h-0 is required so the flex child can shrink below
          its content height (the default min-h is auto, which would
          force the parent to scroll instead). */}
      <nav className="mt-12 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1 text-sm font-medium tracking-wide">
        {tree.map((node) => {
          const sectionActive =
            isActive(node.item.href, pathname) ||
            node.children.some((c) => isActive(c.href, pathname))
          return (
            <div key={node.item.href} className="flex flex-col">
              <NavRow item={node.item} pathname={pathname} />
              {node.children.length > 0 && (
                <div
                  className={
                    sectionActive
                      ? 'mt-0.5 flex flex-col border-l border-copper-500/40 pl-4 ml-[7px] transition-colors'
                      : 'mt-0.5 flex flex-col border-l border-cream-50/10 pl-4 ml-[7px] transition-colors'
                  }
                >
                  {node.children.map((c) => (
                    <NavRow key={c.href} item={c} pathname={pathname} nested />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer — pinned bottom. Preview site link. Hairline border on
          top reads as "leaving the admin surface" rather than a peer
          of the nav items. Plain <a> rather than next/link: this
          navigates from /admin (admin route group) to / (public root
          layout) — a soft Link nav tears down the shared root-layout
          chrome in transit (SiteHeader, footer flicker absent). A
          hard nav reliably re-mounts the public chrome. */}
      <div className="mt-6 shrink-0 border-t border-cream-50/10 pt-5">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="group inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-cream-50/70 transition-colors hover:text-copper-300"
        >
          <Eye
            size={14}
            strokeWidth={1.8}
            className="text-cream-50/60 transition-colors group-hover:text-copper-400"
          />
          Preview site
        </a>
      </div>
    </aside>
  )
}
