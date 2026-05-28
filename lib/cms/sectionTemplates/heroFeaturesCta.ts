import type { SectionTemplate } from './index'

// Landing-page starter — premium re-skin (2026-05-28).
//
// Previously composed legacy widgets (hero / icon_box / cta) into a
// utilitarian three-section starter. This re-skin recomposes the SAME
// three-section shape (hero half → 3-up feature columns → closing CTA
// bar) entirely from lx_* widgets so the inserted section feels at
// home next to the rest of the luxury template library.
//
// What changed:
//   Section 1 (hero half, obsidian)
//     - lx_eyebrow (champagne kicker)
//     - lx_heading (h1, display-2xl, ivory, slide-up)
//     - lx_text (body-lg, ivory, fade-in)
//     - lx_action (primary-gold pill)
//   Section 2 (three feature columns, ivory)
//     - per column: lx_eyebrow + lx_heading (h3 display-sm) + lx_text
//   Section 3 (closing bar, obsidian)
//     - lx_heading (h2 display-md, centered, ivory)
//     - lx_action (primary-gold pill, centered)
//
// The template's id, name, description, and previewImage are
// intentionally preserved so:
//   • the palette gallery entry surfaces it under the same name,
//   • existing instantiate URLs (POST templateId=hero-features-cta) keep working,
//   • the round-trip test (tests/unit/sectionTemplates.test.ts) re-runs against
//     the new widget shapes without registry surgery.
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
    'Landing-page starter: editorial hero, three-up feature columns, champagne CTA close.',
  previewImage: '/templates/hero-features-cta.svg',
  blocks: [
    // ─── Section 1 — Editorial hero on obsidian ──────────────────────
    {
      kind: 'section',
      meta: { columns: 1, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Introducing',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'left',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'A bold opening line that earns attention',
                level: 'h1',
                size: 'display-2xl',
                alignment: 'left',
                tone: 'ivory',
                italic: false,
                animation: 'slide-up',
              },
              meta: { marginTop: 'sm' },
            },
            {
              kind: 'widget',
              blockType: 'lx_text',
              data: {
                body_richtext:
                  '<p>Tell visitors who you are and why this page exists. One or two sentences here usually beat a paragraph.</p>',
                size: 'body-lg',
                alignment: 'left',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Get in touch',
                href: '/contact',
                openInNew: false,
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'left',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },
    // ─── Section 2 — Three feature columns on ivory ──────────────────
    {
      kind: 'section',
      meta: { columns: 3, background: 'ivory', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Detail',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'left',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Crafted detail',
                level: 'h3',
                size: 'display-sm',
                alignment: 'left',
                tone: 'obsidian',
                italic: false,
                animation: 'fade-in',
              },
              meta: { marginTop: 'xs' },
            },
            {
              kind: 'widget',
              blockType: 'lx_text',
              data: {
                body_richtext:
                  '<p>Every surface considered, every edge resolved. A single line of copy beats a paragraph here.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'obsidian',
                maxWidth: 'wide',
                animation: 'fade-in',
              },
              meta: { marginTop: 'xs' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Guidance',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'left',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Honest guidance',
                level: 'h3',
                size: 'display-sm',
                alignment: 'left',
                tone: 'obsidian',
                italic: false,
                animation: 'fade-in',
              },
              meta: { marginTop: 'xs' },
            },
            {
              kind: 'widget',
              blockType: 'lx_text',
              data: {
                body_richtext:
                  '<p>Direct answers, no upsell. We help you choose what is right for the project — even when that is less than you asked for.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'obsidian',
                maxWidth: 'wide',
                animation: 'fade-in',
              },
              meta: { marginTop: 'xs' },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Materials',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'left',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Premium materials',
                level: 'h3',
                size: 'display-sm',
                alignment: 'left',
                tone: 'obsidian',
                italic: false,
                animation: 'fade-in',
              },
              meta: { marginTop: 'xs' },
            },
            {
              kind: 'widget',
              blockType: 'lx_text',
              data: {
                body_richtext:
                  '<p>Sourced for longevity. Finishes that read well on day one and on year ten — without the maintenance burden.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'obsidian',
                maxWidth: 'wide',
                animation: 'fade-in',
              },
              meta: { marginTop: 'xs' },
            },
          ],
        },
      ],
    },
    // ─── Section 3 — Closing CTA bar on obsidian ─────────────────────
    {
      kind: 'section',
      meta: { columns: 1, background: 'obsidian', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Ready when you are.',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
                tone: 'ivory',
                italic: false,
                animation: 'slide-up',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Start a conversation',
                href: '/contact',
                openInNew: false,
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'center',
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
