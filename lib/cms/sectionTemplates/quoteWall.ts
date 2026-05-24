import type { SectionTemplate } from './index'

// 3-up quote wall: three Testimonial widgets side by side. Useful for
// "what our clients say" sections where a single quote feels lonely.

export const TEMPLATE_QUOTE_WALL: SectionTemplate = {
  id: 'quote-wall',
  name: 'Quote Wall',
  description: 'A three-up grid of testimonials — social proof at a glance.',
  previewImage: '/templates/quote-wall.svg',
  blocks: [
    {
      kind: 'section',
      meta: { columns: 1, background: 'cream', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'heading',
              data: { text: 'What clients are saying' },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      meta: { columns: 3, background: 'cream', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'testimonial',
              data: { quote: 'Better than the brief, on schedule, on budget.' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'testimonial',
              data: { quote: 'They listened first, then designed. It shows.' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'testimonial',
              data: { quote: 'A genuine collaboration from start to finish.' },
            },
          ],
        },
      ],
    },
  ],
}
