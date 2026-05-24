import type { SectionTemplate } from './index'

// 3-up pricing tiers. Each column carries an IconBox (headline + body
// line). Real pricing values are operator-supplied — the seeds show
// the shape, not the actual numbers.

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
              blockType: 'heading',
              data: { text: 'Simple pricing' },
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
              blockType: 'icon_box',
              data: { icon: 'leaf', headline: 'Essential' },
            },
            {
              kind: 'widget',
              blockType: 'button',
              data: { text: 'Choose Essential', href: '/contact' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: { icon: 'star', headline: 'Signature' },
            },
            {
              kind: 'widget',
              blockType: 'button',
              data: { text: 'Choose Signature', href: '/contact' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: { icon: 'gem', headline: 'Bespoke' },
            },
            {
              kind: 'widget',
              blockType: 'button',
              data: { text: 'Talk to us', href: '/contact' },
            },
          ],
        },
      ],
    },
  ],
}
