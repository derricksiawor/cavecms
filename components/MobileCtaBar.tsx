import { headers } from 'next/headers'
import Link from 'next/link'
import {
  Phone, MessageCircle, Mail, Download, FileDown, MapPin,
  Calendar, CalendarClock,
  ShoppingBag, ShoppingCart, CreditCard,
  ArrowRight, ExternalLink, Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { getSetting } from '@/lib/cms/getSettings'
import { MOBILE_CTA_ICONS } from '@/lib/cms/mobileCtaIcons'

// Sticky bottom CTA bar — public pages, < md viewports only. Renders
// 1 or 2 operator-configured buttons. Server component; reads
// getSetting('mobile_cta'). Suppressed on /admin/* via the
// x-pathname middleware header (same pattern as SiteHeader/Footer).
//
// Accessibility:
//   - Every button is a 44px-min hit area (WCAG 2.5.5)
//   - aria-label fallback for icon-only readers
//   - env(safe-area-inset-bottom) padding so the bar clears the
//     iPhone home indicator
//
// Layout offset:
//   - The public-page wrapper adds pb-[88px] when the bar is on so
//     the final scroll-stop doesn't sit under the bar. We surface
//     this via a `data-mobile-cta` attribute on the wrapping div in
//     layout.tsx so a CSS :has() selector or operator-toggleable
//     class can pick it up if it ever needs another consumer.

const ICON_MAP: Record<(typeof MOBILE_CTA_ICONS)[number], LucideIcon> = {
  Phone, MessageCircle, Mail, Download, FileDown, MapPin,
  Calendar, CalendarClock,
  ShoppingBag, ShoppingCart, CreditCard,
  ArrowRight, ExternalLink, Sparkles,
}

export async function MobileCtaBar() {
  const h = await headers()
  const pathname = h.get('x-pathname') ?? ''
  if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/')) return null

  const cfg = await getSetting('mobile_cta')
  if (!cfg.enabled || cfg.buttons.length === 0) return null

  return (
    // Pill container: fixed at the bottom, inset 16px from every edge
    // so the page background shows around it ("hovers above content").
    // The bar itself sits on env(safe-area-inset-bottom) of margin so it
    // clears iPhone home indicators without touching them.
    <div
      role="region"
      aria-label="Quick actions"
      className="fixed bottom-4 left-4 right-4 z-40 md:hidden"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Layout adapts to button count:
         - 1-2 buttons: roomy horizontal — icon BESIDE text, larger
           type, generous padding (the original pill design).
         - 3-4 buttons: tight vertical stack — icon ON TOP of tiny
           text, smaller padding. Each button gets ~25% of the pill
           width (~85px on a 375px viewport); horizontal text simply
           does not fit for longer labels like "BROCHURE" or
           "CONTACT". Vertical stack reads as a tab-bar pattern that
           visitors recognise instantly. */}
      <div className="flex items-stretch rounded-full bg-cream/95 backdrop-blur-md ring-1 ring-warm-stone/20 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.25)] divide-x divide-warm-stone/20 overflow-hidden">
        {cfg.buttons.map((b, i) => {
          const Icon = ICON_MAP[b.icon] ?? ArrowRight
          // Detect link semantics — tel:/mailto: do not use Next Link
          // (they hand off to the OS), external URLs open new tab.
          const isTel = /^tel:/i.test(b.href)
          const isMail = /^mailto:/i.test(b.href)
          const isExternal = /^https?:\/\//i.test(b.href)
          const opensInNewTab = isExternal
          const isMulti = cfg.buttons.length > 2
          const className = isMulti
            ? 'flex flex-1 flex-col items-center justify-center gap-0.5 px-2 py-2 min-h-[56px] text-[10px] font-semibold uppercase tracking-[0.12em] text-near-black active:bg-cream-100/60 transition-colors'
            : 'flex flex-1 items-center justify-center gap-2 px-4 py-3 min-h-[56px] text-sm font-semibold uppercase tracking-[0.16em] text-near-black active:bg-cream-100/60 transition-colors'
          // Truncate ensures a long operator-set label can never break
          // pill layout — overflow ellipsis under min-w-0 (flex
          // children must opt out of the flex shrink-by-content
          // default so truncate can take effect).
          const labelClass = isMulti
            ? 'truncate min-w-0 max-w-full leading-tight'
            : 'truncate min-w-0'
          if (isTel || isMail || isExternal) {
            return (
              <a key={i} href={b.href} aria-label={b.text}
                className={className}
                target={opensInNewTab ? '_blank' : undefined}
                rel={opensInNewTab ? 'noopener noreferrer' : undefined}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className={labelClass}>{b.text}</span>
              </a>
            )
          }
          return (
            <Link key={i} href={b.href} aria-label={b.text} className={className}>
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className={labelClass}>{b.text}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

