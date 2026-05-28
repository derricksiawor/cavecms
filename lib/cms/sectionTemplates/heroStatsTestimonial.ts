import type { SectionTemplate } from './index'

// About-page starter — premium re-skin (2026-05-28).
//
// Three sections: framing hero (lx_heading + lx_text on cream), then
// a 3-up animated stats row using lx_stat widgets in three columns,
// then a closing lx_testimonial on cream.
//
// The legacy stats_row widget exploded into three lx_stat children
// because lx_stat is a single-value widget by design; the 3-up layout
// comes from the section's `columns: 3` meta + one lx_stat per column.

export const TEMPLATE_HERO_STATS_TESTIMONIAL: SectionTemplate = {
  id: 'hero-stats-testimonial',
  name: 'Hero + Stats Row + Testimonial',
  description:
    'About-page starter: framing hero, animated stats row, single testimonial.',
  previewImage: '/templates/hero-stats-testimonial.svg',
  blocks: [
    // ─── Section 1 — Framing hero on cream ───────────────────────────
    {
      kind: 'section',
      meta: { columns: 1, background: 'cream', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'The story behind the work',
                level: 'h2',
                size: 'display-lg',
                alignment: 'left',
                tone: 'obsidian',
                italic: false,
                animation: 'slide-up',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_text',
              data: {
                body_richtext:
                  '<p>A few sentences of context. What you do, who it is for, what makes the approach different.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'obsidian',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },
    // ─── Section 2 — 3-up stats row on near-black ────────────────────
    {
      kind: 'section',
      meta: { columns: 3, background: 'near-black', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_stat',
              data: {
                value: 120,
                suffix: '+',
                label: 'Residences',
                duration_ms: 1800,
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_stat',
              data: {
                value: 14,
                label: 'Neighbourhoods',
                duration_ms: 1800,
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_stat',
              data: {
                value: 18,
                label: 'Years',
                duration_ms: 1800,
                tone: 'ivory',
              },
            },
          ],
        },
      ],
    },
    // ─── Section 3 — Closing testimonial on cream ────────────────────
    {
      kind: 'section',
      meta: { columns: 1, background: 'cream', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_testimonial',
              data: {
                quote:
                  'They listened to what we wanted and delivered something better than we imagined.',
                attribution: 'A. Bauer',
                attribution_title: 'Whole-home renovation, 2024',
                alignment: 'center',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },
  ],
}
