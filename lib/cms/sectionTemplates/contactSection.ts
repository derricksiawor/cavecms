import type { SectionTemplate } from './index'

// Contact section: 2-up split — left column has address/hours/social
// (lx_heading + lx_text + lx_social_icons); right column has a CTA
// (lx_heading + lx_text + lx_action). The contact form widget itself
// is a fixed-slot widget on the contact page template.

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
              blockType: 'lx_heading',
              data: {
                text: 'Visit or send a note',
                level: 'h3',
                size: 'display-md',
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
                  '<p>123 Studio Lane, City</p><p>Tue – Sat, 10am – 6pm</p><p>hello@example.com</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'obsidian',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
            {
              kind: 'widget',
              blockType: 'lx_social_icons',
              data: {
                items: [
                  { platform: 'instagram', href: 'https://www.instagram.com/example' },
                  { platform: 'linkedin', href: 'https://www.linkedin.com/company/example' },
                ],
                size: 'md',
                alignment: 'left',
                tone: 'warm-stone',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Prefer a conversation?',
                level: 'h3',
                size: 'display-md',
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
                  '<p>Open the form on our contact page or send a quick email — we reply within a day.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'obsidian',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Open contact form',
                href: '/contact',
                openInNew: false,
                variant: 'primary-gold',
                size: 'md',
                alignment: 'left',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },
  ],
}
