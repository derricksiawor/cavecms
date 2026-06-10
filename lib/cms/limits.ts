// Shared between server-side Zod schemas (block-registry) and client-side
// ZodForm shapes. Numbers only, no validation logic — keeps the import safe
// from both runtimes.
//
// CaveCMS does NOT cap how much an operator writes. A legal page, a long
// article, a full Terms doc — none of it should ever be refused. Every field
// below is sized to "effectively unlimited": you'd need ~5 million characters
// in ONE field (about 1,500 printed pages) to reach it, which no real content
// does. The only true ceiling is the request-size backstop in
// lib/api/jsonBody.ts, and that exists to stop a pathological payload from
// crashing the server, not to limit content.
const UNLIMITED = 5_000_000

export const TEXT_MAX = {
  /** lx_heading.text, lx_featured_projects.heading, lx_icon_box.title, ... */
  title: UNLIMITED,
  /** media alt text, lx_figure.caption, lx_gallery item caption */
  short: UNLIMITED,
  /** lx_quote.quote, lx_channel_card.description, lx_icon_box.body, ... */
  body: UNLIMITED,
  /** lx_accordion items[].body_richtext, lx_tabs tabs[].body_richtext */
  richtextShort: UNLIMITED,
  /** lx_text.body_richtext */
  richtextLong: UNLIMITED,
  /** lx_richtext.markdown — a full post body authored in markdown. */
  bodyMarkdown: UNLIMITED,
  /** lx_eyebrow.text, lx_channel_card.label / value, lx_stat.label, ... */
  caption: UNLIMITED,
  /** lx_action.label, contact_form.submit_label, button labels */
  ctaText: UNLIMITED,
  /** lx_action.href and any URL field */
  url: UNLIMITED,
  /** lx_icon_list / lx_icon_box / lx_channel_card icon name */
  icon: UNLIMITED,
} as const
