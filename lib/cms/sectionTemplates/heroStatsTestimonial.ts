import type { SectionTemplate } from './index'

// About-page starter: hero (Heading + Text), then a 3-up StatsRow,
// then a single Testimonial. Uses chunk-G widgets (StatsRow,
// Testimonial) that landed in main as part of the 6 Elementor-parity
// widgets.

export const TEMPLATE_HERO_STATS_TESTIMONIAL: SectionTemplate = {
  id: 'hero-stats-testimonial',
  name: 'Hero + Stats Row + Testimonial',
  description:
    'About-page starter: framing hero, animated stats row, single testimonial.',
  previewImage: '/templates/hero-stats-testimonial.svg',
  blocks: [
    {
      kind: 'section',
      meta: { columns: 1, background: 'cream', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'heading',
              data: { text: 'The story behind the work' },
            },
            {
              kind: 'widget',
              blockType: 'text',
              data: {
                body_richtext:
                  '<p>A few sentences of context. What you do, who it is for, what makes the approach different.</p>',
              },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      meta: { columns: 1, background: 'near-black', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'stats_row',
              data: {
                items: [
                  { value: 120, prefix: '', suffix: '+', label: 'Residences', duration_ms: 1800 },
                  { value: 14, prefix: '', suffix: '', label: 'Neighbourhoods', duration_ms: 1800 },
                  { value: 18, prefix: '', suffix: '', label: 'Years', duration_ms: 1800 },
                ],
                layout: '3up',
              },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      meta: { columns: 1, background: 'cream', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'testimonial',
              data: {
                quote:
                  'They listened to what we wanted and delivered something better than we imagined.',
              },
            },
          ],
        },
      ],
    },
  ],
}
