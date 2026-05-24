import type { SectionTemplate } from './index'

// Single section, single column, single Accordion widget with 5
// starter items. Operators add / remove items via the EditDrawer's
// repeater UI after insert.

export const TEMPLATE_FAQ_ACCORDION: SectionTemplate = {
  id: 'faq-accordion',
  name: 'FAQ Accordion',
  description:
    'A single accordion section with five starter questions ready to edit.',
  previewImage: '/templates/faq-accordion.svg',
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
              data: { text: 'Frequently asked questions' },
            },
            {
              kind: 'widget',
              blockType: 'accordion',
              data: {
                items: [
                  {
                    title: 'What is your typical turnaround?',
                    body_richtext:
                      '<p>Replace this answer with what fits your work — usually one or two sentences keeps it scannable.</p>',
                  },
                  {
                    title: 'Do you take on smaller projects?',
                    body_richtext:
                      '<p>Share your stance on scope. Honesty up front saves both sides time.</p>',
                  },
                  {
                    title: 'How is pricing structured?',
                    body_richtext:
                      '<p>A one-line summary of how you price, with a path to a fuller conversation.</p>',
                  },
                  {
                    title: 'What does the process look like?',
                    body_richtext:
                      '<p>Three or four stages of your delivery, in plain language. Specifics build trust.</p>',
                  },
                  {
                    title: 'Where are you based?',
                    body_richtext:
                      '<p>Your city + the regions you serve. A map link or address is a nice touch here.</p>',
                  },
                ],
                allow_multiple: false,
              },
            },
          ],
        },
      ],
    },
  ],
}
