// Shared between server-side Zod schemas (block-registry) and client-side
// ZodForm shapes. Numbers only, no validation logic — keeps the import safe
// from both runtimes. If a max changes, both sides stay in lockstep.
export const TEXT_MAX = {
  /** hero.title, services_intro.title, about_history.title,
   *  cta.title, featured_projects.title, text.heading */
  title: 220,
  /** hero.subtitle, image.caption, media alt, gallery item caption */
  short: 320,
  /** cta.body, quote.quote */
  body: 800,
  /** services_intro.body_richtext */
  richtextShort: 4000,
  /** about_history.body_richtext, text.body_richtext */
  richtextLong: 8000,
  /** quote.attribution, quote.attribution_title, services_intro.items.title */
  caption: 120,
  /** Cta.text button label */
  ctaText: 80,
  /** Cta.href and any URL field */
  url: 500,
  /** services_intro.items[].icon (icon name/class) */
  icon: 60,
  /** services_intro.items[].body */
  itemBody: 500,
} as const
