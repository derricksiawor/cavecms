import type { SectionTemplate } from './index'

// 3-up pricing tiers. Each column carries an lx_icon_box (headline +
// body) plus an lx_action below. Real pricing values are operator-
// supplied — the seeds show the shape, not the actual numbers.

export const TEMPLATE_PRICING_TABLE: SectionTemplate = {
  id: 'pricing-table',
  name: 'Pricing Table',
  description: 'Three-up pricing tiers, each ready for a headline + supporting copy.',
  previewImage: '/templates/pricing-table.svg',
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
                text: 'Simple pricing',
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
              blockType: 'lx_icon_box',
              data: {
                icon: 'leaf',
                headline: 'Essential',
                body: 'A starting point — replace this line with what the tier includes.',
                alignment: 'center',
                accent: 'champagne-outline',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Choose Essential',
                href: '/contact',
                openInNew: false,
                variant: 'secondary-outline',
                size: 'md',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_icon_box',
              data: {
                icon: 'star',
                headline: 'Signature',
                body: 'The most-picked tier — describe what makes this the recommendation.',
                alignment: 'center',
                accent: 'champagne-fill',
                tone: 'ivory',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Choose Signature',
                href: '/contact',
                openInNew: false,
                variant: 'primary-gold',
                size: 'md',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_icon_box',
              data: {
                icon: 'gem',
                headline: 'Bespoke',
                body: 'Custom-scoped engagements — point to the conversation.',
                alignment: 'center',
                accent: 'champagne-outline',
                tone: 'obsidian',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Talk to us',
                href: '/contact',
                openInNew: false,
                variant: 'secondary-outline',
                size: 'md',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
      ],
    },
  ],
}
