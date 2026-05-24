// Visual-form shapes for each settings.key. Mirrors the Zod schemas in
// lib/cms/settings-registry.ts — Zod is the trust boundary (validates
// on save), this is the UI builder so operators edit real fields
// instead of raw JSON.

import type { FieldShape } from '@/components/inline-edit/ZodForm'

export const SETTINGS_SHAPES: Record<string, FieldShape[]> = {
  contact_info: [
    {
      kind: 'string',
      key: 'phone',
      label: 'Phone number',
      maxLength: 40,
      placeholder: '+1 555 0100',
    },
    {
      kind: 'string',
      key: 'email',
      label: 'Email address',
      maxLength: 180,
      placeholder: 'hello@example.com',
    },
    {
      kind: 'string',
      key: 'address',
      label: 'Street address',
      maxLength: 280,
      multiline: true,
      placeholder: '12 Example Road\nCity, Region',
    },
    {
      kind: 'string',
      key: 'hours',
      label: 'Business hours',
      maxLength: 120,
      placeholder: 'Mon–Fri 9am–6pm',
    },
  ],

  social_links: [
    // Rendered with the dedicated SocialLinksField below. The kind
    // `social_link_array` collapses the platform-URL pair into a single
    // visual row with platform presets, icons, and inline validation —
    // without changing the wire shape (still `[{ platform, url }, …]`).
    {
      kind: 'social_link_array',
      key: '__root',
      label: 'Social profiles',
      addLabel: 'Add social profile',
      maxItems: 20,
    },
  ],

  default_seo: [
    {
      kind: 'string',
      key: 'title',
      label: 'Default page title',
      maxLength: 180,
      placeholder: 'Best World Properties',
      help: 'Appears as the browser tab title when a page does not set its own.',
    },
    {
      kind: 'string',
      key: 'description',
      label: 'Default meta description',
      maxLength: 320,
      multiline: true,
      help: 'Search-result snippet when a page does not set its own. Keep under 160 characters for best display.',
    },
    {
      kind: 'string',
      key: 'ogImagePath',
      label: 'Default social-share image',
      maxLength: 500,
      placeholder: '/uploads/og-default.jpg  or  https://…',
      help: 'The preview image that shows up when someone shares your site on Facebook, X, LinkedIn, WhatsApp, or in iMessage. Paste a full https link, or upload an image to Media and paste its path here.',
    },
  ],

  footer: [
    {
      kind: 'string',
      key: 'tagline',
      label: 'Footer tagline',
      maxLength: 220,
      multiline: true,
      placeholder: 'Crafting homes since 1992.',
    },
    {
      kind: 'object_array',
      key: 'columns',
      label: 'Footer columns',
      itemNoun: 'footer column',
      addLabel: 'Add column',
      maxItems: 6,
      itemTitle: (item, i) => (item.label as string) || `Column ${i + 1}`,
      itemFields: [
        {
          kind: 'string',
          key: 'label',
          label: 'Column heading',
          maxLength: 60,
          placeholder: 'e.g. Company, Resources',
        },
        {
          kind: 'object_array',
          key: 'links',
          label: 'Links in this column',
          itemNoun: 'link',
          addLabel: 'Add link',
          maxItems: 20,
          itemTitle: (link, i) => (link.text as string) || `Link ${i + 1}`,
          itemFields: [
            {
              kind: 'string',
              key: 'text',
              label: 'Link text',
              maxLength: 60,
              placeholder: 'e.g. About us',
            },
            {
              kind: 'string',
              key: 'href',
              label: 'Link target',
              maxLength: 500,
              placeholder: '/about, #section, or https://…',
              help: 'A page on your own site (like /about), a section anchor (#contact), a full link, or an email/phone (mailto: / tel:).',
            },
          ],
        },
      ],
    },
    {
      kind: 'media',
      key: 'logo',
      label: 'Footer logo (optional)',
      help: 'A lighter or wordmark variant for the dark footer. If empty, we’ll use the site header’s logo.',
    },
    {
      kind: 'string',
      key: 'newsletterHeading',
      label: 'Newsletter heading',
      maxLength: 120,
      placeholder: 'Stay informed',
    },
    {
      kind: 'string',
      key: 'newsletterBody',
      label: 'Newsletter description',
      maxLength: 400,
      multiline: true,
      placeholder: 'Quarterly updates on new launches and project milestones.',
    },
    {
      kind: 'string',
      key: 'newsletterCtaLabel',
      label: 'Newsletter button label',
      maxLength: 40,
      placeholder: 'Subscribe',
    },
    {
      kind: 'string',
      key: 'copyright',
      label: 'Copyright text',
      maxLength: 220,
      placeholder: 'Best World Properties',
      help: 'Shown beside the year at the very bottom. Leave empty to use the brand name.',
    },
    {
      kind: 'object_array',
      key: 'legalLinks',
      label: 'Legal links',
      itemNoun: 'legal link',
      addLabel: 'Add link',
      maxItems: 4,
      itemTitle: (item, i) => (item.text as string) || `Link ${i + 1}`,
      itemFields: [
        { kind: 'string', key: 'text', label: 'Label', maxLength: 60, placeholder: 'e.g. Privacy' },
        {
          kind: 'string',
          key: 'href',
          label: 'Goes to',
          maxLength: 500,
          placeholder: '/privacy, #section, or https://…',
          help: 'A page on your own site, a section anchor, or a full link.',
        },
      ],
    },
  ],

  site_header: [
    {
      kind: 'string',
      key: 'brandText',
      label: 'Brand name',
      maxLength: 120,
      placeholder: 'Best World Properties',
      help: 'Shown next to the logo, or in place of it if you haven’t uploaded one.',
    },
    {
      kind: 'media',
      key: 'logo',
      label: 'Logo',
      help: 'Upload a transparent PNG or SVG. Tall enough to read clearly at 40 px high.',
    },
    {
      kind: 'select',
      key: 'theme',
      label: 'Header theme',
      options: [
        { value: 'cream', label: 'Cream — warm light (default)' },
        { value: 'obsidian', label: 'Obsidian — premium dark' },
        { value: 'ivory', label: 'Ivory — crisp neutral light' },
        { value: 'champagne', label: 'Champagne — gold statement' },
        { value: 'bone', label: 'Bone — softest light' },
      ],
      help: 'Sets the header background, text, border, nav-hover, and primary-button colours together so the bar reads as one coherent surface.',
    },
    {
      kind: 'object_array',
      key: 'navItems',
      label: 'Top navigation links',
      itemNoun: 'navigation link',
      addLabel: 'Add link',
      maxItems: 6,
      itemTitle: (item, i) => (item.label as string) || `Link ${i + 1}`,
      itemFields: [
        {
          kind: 'string',
          key: 'label',
          label: 'Label',
          maxLength: 60,
          placeholder: 'e.g. Projects, About, Contact',
        },
        {
          kind: 'string',
          key: 'href',
          label: 'Goes to',
          maxLength: 500,
          placeholder: '/about, #section, or https://…',
          help: 'A page on your own site (like /about), a section anchor (#contact), or a full https:// link.',
        },
      ],
    },
    {
      kind: 'cta',
      key: 'primaryCta',
      label: 'Primary button',
    },
  ],

  organization_json_ld: [
    {
      kind: 'string',
      key: 'name',
      label: 'Organization name',
      maxLength: 180,
      placeholder: 'Best World Properties',
    },
    {
      kind: 'string',
      key: 'altName',
      label: 'Alternate name (optional)',
      maxLength: 180,
      placeholder: 'e.g. BWP',
    },
    {
      kind: 'string',
      key: 'logoUrl',
      label: 'Logo URL',
      maxLength: 500,
      placeholder: '/brand/logo.svg  or  https://…',
      help: 'Path to your logo on this site, or a full https:// link. Google uses this in branded search results.',
    },
    {
      kind: 'string',
      key: 'foundingDate',
      label: 'Founding date (optional)',
      maxLength: 40,
      placeholder: 'YYYY-MM-DD',
    },
    {
      kind: 'string_array',
      key: 'sameAs',
      label: 'Your official profile links',
      help: 'Paste full https links to your own pages on LinkedIn, Wikipedia, Crunchbase, etc. Helps Google trust that all these pages belong to the same brand.',
    },
  ],
}

// Per-key help copy shown above the form. Settings rows are
// short-lived in admin UI but consequential everywhere on the public
// site — a paragraph of context helps the operator know what they're
// editing.
export const SETTINGS_HELP: Record<string, string> = {
  contact_info:
    'Shows up in your footer, on the Contact page, and helps Google connect your brand.',
  social_links:
    'Your social profiles appear as icons in the footer, and help Google verify your brand.',
  default_seo:
    "The fallback page title, description, and preview image used when an individual project or post doesn't set its own.",
  footer:
    "Your footer's tagline and the link columns that show up at the bottom of every page.",
  organization_json_ld:
    'Background info Google reads to understand your brand. Filling this in unlocks richer search result cards.',
  site_header:
    'The top of every public page — your logo, the main navigation links, and any call-to-action buttons.',
}

// Most settings values are objects (shapes apply at the top level).
// `social_links` is the exception: it's a bare array. We expose it
// through ZodForm under a synthetic `__root` key, then unwrap before
// PATCH so the server still sees the array shape the Zod schema
// expects.
export const SETTINGS_ROOT_KIND: Record<string, 'object' | 'array'> = {
  contact_info: 'object',
  social_links: 'array',
  default_seo: 'object',
  footer: 'object',
  organization_json_ld: 'object',
  site_header: 'object',
}

export const SETTINGS_LABELS: Record<string, string> = {
  contact_info: 'Contact information',
  social_links: 'Social profiles',
  default_seo: 'Default search-engine details',
  footer: 'Footer',
  organization_json_ld: 'Brand info for search engines',
  site_header: 'Site header',
}
