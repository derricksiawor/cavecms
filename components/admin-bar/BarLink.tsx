import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import {
  PILL_BASE,
  VARIANT_CLASS,
  SIZE_CLASS,
  ICON_SIZE,
} from '@/components/admin/pillStyle'

// Visually identical to <PillButton variant="bar" size="bar"> but
// renders a plain anchor (NOT next/link) so navigation reliably
// crosses the public ↔ (admin) route-group boundary. Next 15's soft
// Link nav between sibling route groups (`(admin)/admin/*` vs root
// public routes) tears down the shared root-layout chrome — the
// SiteHeader, SiteFooter, and the bar itself momentarily disappear
// because the layout doesn't re-render across that transition. A
// plain <a> forces a full document load on every bar click, which
// is the correct semantics here anyway: the bar's links navigate
// AWAY from the public site into admin chrome (or vice versa), so
// there's no SPA benefit lost.
export function BarLink({
  href,
  icon: Icon,
  children,
  ariaLabel,
}: {
  href: string
  icon: LucideIcon
  children: React.ReactNode
  ariaLabel?: string
}) {
  return (
    <a
      href={href}
      aria-label={ariaLabel}
      className={clsx(PILL_BASE, VARIANT_CLASS.bar, SIZE_CLASS.bar)}
    >
      <Icon size={ICON_SIZE.bar} strokeWidth={1.8} aria-hidden />
      {children}
    </a>
  )
}
