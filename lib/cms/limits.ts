// Shared between server-side Zod schemas (block-registry) and client-side
// ZodForm shapes. Numbers only, no validation logic — keeps the import safe
// from both runtimes. If a max changes, both sides stay in lockstep.
export const TEXT_MAX = {
  /** lx_heading.text, lx_featured_projects.heading, lx_icon_box.title,
   *  contact_form.heading / success_headline */
  title: 220,
  /** media alt text, lx_figure.caption, lx_gallery item caption */
  short: 320,
  /** lx_quote.quote, lx_channel_card.description, lx_icon_box.body,
   *  contact_form.intro / success_body */
  body: 800,
  /** lx_accordion items[].body_richtext, lx_tabs tabs[].body_richtext */
  richtextShort: 4000,
  /** lx_text.body_richtext */
  richtextLong: 8000,
  /** lx_richtext.markdown — a full post body authored in markdown. Sized
   *  to the posts PATCH route's BODY_MD_MAX (180_000) so a migrated post
   *  body never truncates when its markdown moves onto the block engine. */
  bodyMarkdown: 180_000,
  /** lx_eyebrow.text, lx_channel_card.label / value, lx_stat.label,
   *  lx_quote.attribution / attribution_title */
  caption: 120,
  /** lx_action.label, contact_form.submit_label, button labels */
  ctaText: 80,
  /** lx_action.href and any URL field */
  url: 500,
  /** lx_icon_list / lx_icon_box / lx_channel_card icon name */
  icon: 60,
} as const
