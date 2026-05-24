import type { SectionTemplate } from './index'

// Project showcase: a wide Heading + Text intro, followed by a
// Testimonial. Operators replace the placeholder copy with a real
// project narrative + client quote.

export const TEMPLATE_PROJECT_SHOWCASE: SectionTemplate = {
  id: 'project-showcase',
  name: 'Project Showcase',
  description:
    'A framing narrative paired with a client quote — perfect for case studies.',
  previewImage: '/templates/project-showcase.svg',
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
              data: { text: 'A signature project' },
            },
            {
              kind: 'widget',
              blockType: 'text',
              data: {
                body_richtext:
                  '<p>Two short paragraphs about the brief, the constraints, and the outcome. Specific numbers earn trust — vague claims do not.</p><p>Include one detail that surprised you. Readers remember texture, not adjectives.</p>',
              },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      meta: { columns: 1, background: 'near-black', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'testimonial',
              data: {
                quote:
                  'They saw the project we wanted before we knew how to describe it — and delivered it ahead of schedule.',
              },
            },
          ],
        },
      ],
    },
  ],
}
