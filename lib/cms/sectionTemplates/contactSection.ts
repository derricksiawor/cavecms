import type { SectionTemplate } from './index'

// Contact section: 2-up split — left column has the address / hours /
// social block (Heading + Text + SocialIcons); right column has the
// call-to-action. The actual contact form widget is not in V1's
// freeform-widget set (InquiryForm is a fixed-slot widget); operators
// add the form via the contact page template.

export const TEMPLATE_CONTACT_SECTION: SectionTemplate = {
  id: 'contact-section',
  name: 'Contact Section',
  description:
    'Two-up split: address + social on the left, a clear CTA on the right.',
  previewImage: '/templates/contact-section.svg',
  blocks: [
    {
      kind: 'section',
      meta: { columns: 2, background: 'cream', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'heading',
              data: { text: 'Visit or send a note' },
            },
            {
              kind: 'widget',
              blockType: 'text',
              data: {
                body_richtext:
                  '<p>123 Studio Lane, City</p><p>Tue – Sat, 10am – 6pm</p><p>hello@example.com</p>',
              },
            },
            {
              kind: 'widget',
              blockType: 'social_icons',
              data: {
                items: [
                  { platform: 'instagram', url: 'https://instagram.com/your-handle' },
                  { platform: 'linkedin', url: 'https://linkedin.com/company/your-org' },
                ],
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'heading',
              data: { text: 'Prefer a conversation?' },
            },
            {
              kind: 'widget',
              blockType: 'text',
              data: {
                body_richtext:
                  '<p>Open the form on our contact page or send a quick email — we reply within a day.</p>',
              },
            },
            {
              kind: 'widget',
              blockType: 'button',
              data: { text: 'Open contact form', href: '/contact' },
            },
          ],
        },
      ],
    },
  ],
}
