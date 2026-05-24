// Pure-data const tuple — no server-only deps. Lives outside
// settings-registry.ts so client components (the SettingsForm
// MobileCtaCard's icon-picker) can import it without dragging
// `'server-only'` + the Zod registry into the client bundle.
// Both the server-side Zod schema (settings-registry.ts) and the
// client-side icon-select share this single literal.
export const MOBILE_CTA_ICONS = [
  'Phone',
  'MessageCircle',
  'Mail',
  'Download',
  'FileDown',
  'MapPin',
  'Calendar',
  'CalendarClock',
  'ShoppingBag',
  'ShoppingCart',
  'CreditCard',
  'ArrowRight',
  'ExternalLink',
  'Sparkles',
] as const

export type MobileCtaIcon = (typeof MOBILE_CTA_ICONS)[number]
