import type { SectionTemplate } from './index'

// 3-up quote wall: three lx_testimonial widgets side by side. Useful
// for "what our clients say" sections where a single quote feels
// lonely on the page.

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
              blockType: 'lx_heading',
              data: {
                text: 'What clients are saying',
                level: 'h2',
                size: 'display-lg',
                alignment: 'center',
                tone: 'obsidian',
                italic: false,
                animation: 'slide-up',
              },
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
              blockType: 'lx_testimonial',
              data: {
                quote: 'Better than the brief, on schedule, on budget.',
                attribution: 'M. Reyes',
                alignment: 'left',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_testimonial',
              data: {
                quote: 'They listened first, then designed. It shows.',
                attribution: 'A. Chen',
                alignment: 'left',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_testimonial',
              data: {
                quote: 'A genuine collaboration from start to finish.',
                attribution: 'J. Bauer',
                alignment: 'left',
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
