import type { SectionTemplate } from './index'

// Project showcase: framing lx_heading + lx_text intro on cream,
// followed by a closing lx_testimonial on near-black. Operators
// replace the placeholder copy with a real project narrative + a
// client quote.

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
              blockType: 'lx_heading',
              data: {
                text: 'A signature project',
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
                  '<p>Two short paragraphs about the brief, the constraints, and the outcome. Specific numbers earn trust — vague claims do not.</p><p>Include one detail that surprised you. Readers remember texture, not adjectives.</p>',
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
    {
      kind: 'section',
      meta: { columns: 1, background: 'near-black', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_testimonial',
              data: {
                quote:
                  'They saw the project we wanted before we knew how to describe it — and delivered it ahead of schedule.',
                attribution: 'A. Client',
                attribution_title: 'Project lead',
                alignment: 'center',
                tone: 'ivory',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },
  ],
}
