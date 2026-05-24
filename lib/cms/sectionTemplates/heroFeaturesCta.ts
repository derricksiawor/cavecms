import type { SectionTemplate } from './index'

// Landing-page starter: full-bleed hero (Heading + Text + Button) →
// 3-up feature grid (IconBox each) → copper CTA strip.
//
// Widget shapes mirror the SEED_DATA defaults in lib/cms/blockSeeds.ts
// so the round-trip test (tests/unit/sectionTemplates.test.ts) parses
// every entry through parseAndSanitize successfully.
//
// Each section carries explicit meta — SectionMetaSchema.strict()
// requires the (columns, background, padding) triple; the instantiate
// endpoint forwards meta verbatim. `columns` MUST equal the section's
// `columns` array length so the renderer's grid track count matches
// the actual row count.

export const TEMPLATE_HERO_FEATURES_CTA: SectionTemplate = {
  id: 'hero-features-cta',
  name: 'Hero + Features + CTA',
  description:
    'Landing-page starter: bold hero, three-up feature grid, copper CTA strip.',
  previewImage: '/templates/hero-features-cta.svg',
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
              data: { text: 'A bold opening line that earns attention' },
            },
            {
              kind: 'widget',
              blockType: 'text',
              data: {
                body_richtext:
                  '<p>Tell visitors who you are and why this page exists. One or two sentences here usually beat a paragraph.</p>',
              },
            },
            {
              kind: 'widget',
              blockType: 'button',
              data: { text: 'Get in touch', href: '/contact' },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      meta: { columns: 3, background: 'cream', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: { icon: 'sparkles', headline: 'Crafted detail' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: { icon: 'compass', headline: 'Honest guidance' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: { icon: 'star', headline: 'Premium materials' },
            },
          ],
        },
      ],
    },
    {
      kind: 'section',
      meta: { columns: 1, background: 'copper-tint', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'cta',
              data: {
                title: 'Ready when you are.',
                cta: { text: 'Start a conversation', href: '/contact', openInNew: false },
              },
            },
          ],
        },
      ],
    },
  ],
}
