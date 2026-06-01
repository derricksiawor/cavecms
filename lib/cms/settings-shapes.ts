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
      placeholder: 'CaveCMS',
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
    {
      kind: 'media',
      key: 'favicon',
      label: 'Favicon (browser-tab icon)',
      help: 'The little icon shown in the browser tab, bookmarks, and when the site is saved to a phone home screen. Upload a SQUARE PNG (512×512 works best). Leave empty to use the default CaveCMS icon.',
    },
  ],

  footer: [
    {
      kind: 'select',
      key: 'theme',
      label: 'Footer tone (light or dark)',
      options: [
        { value: 'obsidian', label: 'Obsidian — premium dark (default)' },
        { value: 'cream', label: 'Cream — warm light' },
        { value: 'ivory', label: 'Ivory — crisp neutral light' },
        { value: 'champagne', label: 'Champagne — gold statement' },
        { value: 'bone', label: 'Bone — softest light' },
      ],
      help: 'This only sets whether the footer reads light or dark — background, text, links, and the Subscribe button shift together. It does NOT set your colours. The actual colours (and the ready-made styles like Obsidian & Gold, Carbon, or Sand & Sea you saw on cavecms) come from your site-wide palette under Settings → Theme. Pick your palette there; pick this footer’s light-or-dark tone here.',
    },
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
      help: 'An alternate wordmark for the footer (e.g. a lighter variant for a dark footer theme). If empty, we’ll use the site header’s logo.',
    },
    {
      kind: 'logoSize',
      key: 'logoMaxHeight',
      label: 'Footer logo height',
      logoKey: 'logo',
      min: 24,
      max: 96,
      fallback: 48,
      help: 'How tall the footer logo appears. If you haven’t uploaded a separate footer logo, this still sets the height of the header logo shown here.',
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
      placeholder: 'CaveCMS',
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
      placeholder: 'CaveCMS',
      help: 'Shown next to the logo, or in place of it if you haven’t uploaded one.',
    },
    {
      kind: 'media',
      key: 'logo',
      label: 'Logo',
      help: 'Upload a transparent PNG or SVG. Use the height control below to set how big it appears in the header.',
    },
    {
      kind: 'logoSize',
      key: 'logoMaxHeight',
      label: 'Logo height',
      logoKey: 'logo',
      min: 24,
      max: 96,
      fallback: 40,
      help: 'Drag to set how tall the logo appears in the header bar — the preview updates live.',
    },
    {
      kind: 'select',
      key: 'theme',
      label: 'Header tone (light or dark)',
      options: [
        { value: 'cream', label: 'Cream — warm light (default)' },
        { value: 'obsidian', label: 'Obsidian — premium dark' },
        { value: 'ivory', label: 'Ivory — crisp neutral light' },
        { value: 'champagne', label: 'Champagne — gold statement' },
        { value: 'bone', label: 'Bone — softest light' },
      ],
      help: 'This only sets whether the header bar reads light or dark — background, text, border, nav-hover, and button shift together. It does NOT set your colours. The actual colours (and the ready-made styles like Obsidian & Gold, Carbon, or Sand & Sea you saw on cavecms) come from your site-wide palette under Settings → Theme. Pick your palette there; pick this bar’s light-or-dark tone here.',
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
      placeholder: 'CaveCMS',
    },
    {
      kind: 'string',
      key: 'altName',
      label: 'Alternate name (optional)',
      maxLength: 180,
      placeholder: 'e.g. BWP',
    },
    {
      kind: 'media',
      key: 'logo',
      label: 'Logo for Google',
      help: 'Upload the logo Google shows beside your site in branded search results. Leave this empty and we’ll use your site-header logo automatically — most sites never need to touch this.',
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

  site_general: [
    {
      kind: 'string',
      key: 'siteUrl',
      label: 'Site URL',
      maxLength: 500,
      placeholder: 'https://www.yoursite.com',
      help: 'Your site’s public web address — used in email links, search-engine sitemaps, and structured data. Must start with https and have no trailing slash.',
    },
    {
      kind: 'string',
      key: 'siteName',
      label: 'Site name (optional)',
      maxLength: 120,
      placeholder: 'My CaveCMS Site',
      help: 'Shown in email subject lines and as the display name in update notifications.',
    },
  ],

  session_config: [
    {
      kind: 'number',
      key: 'jwtTtlSec',
      label: 'Session length (seconds)',
      min: 3600,
      max: 28800,
      step: 60,
      help: 'How long an admin stays logged in before they need to sign in again. Min 1 hour, max 8 hours.',
    },
    {
      kind: 'number',
      key: 'jwtRenewAfterSec',
      label: 'Auto-renew sessions older than (seconds)',
      min: 300,
      max: 3600,
      step: 60,
      help: 'When an admin is active near the end of their session, we silently issue a fresh token. Min 5 minutes, max 1 hour.',
    },
    {
      kind: 'number',
      key: 'jwtAbsoluteMaxSec',
      label: 'Absolute max session length (seconds)',
      min: 3600,
      max: 86400,
      step: 60,
      help: 'Hard cap on how long a single login can keep rolling, regardless of activity. Max 24 hours.',
    },
    {
      kind: 'number',
      key: 'csrfTtlSec',
      label: 'CSRF token lifetime (seconds)',
      min: 900,
      max: 86400,
      step: 60,
      help: 'How long a CSRF token stays valid. Lower = stricter; higher = fewer "refresh" interruptions.',
    },
  ],

  smtp_config: [
    {
      kind: 'boolean',
      key: 'enabled',
      label: 'Send outbound email from this site',
      help: 'When off, CaveCMS will not send any email (lead notifications, password reset, update notifications). Turn this on after filling in the rest of this form.',
    },
    {
      kind: 'string',
      key: 'host',
      label: 'SMTP server',
      maxLength: 200,
      placeholder: 'smtp.sendgrid.net',
      help: 'The hostname your email provider gave you. Common ones: smtp.sendgrid.net, smtp.mailgun.org, smtp-relay.gmail.com.',
    },
    {
      kind: 'number',
      key: 'port',
      label: 'Port',
      min: 1,
      max: 65535,
      step: 1,
      help: 'Use 587 for STARTTLS (recommended), or 465 for implicit TLS.',
    },
    {
      kind: 'boolean',
      key: 'secure',
      label: 'Use implicit TLS (only if your server uses port 465)',
    },
    {
      kind: 'string',
      key: 'user',
      label: 'Username',
      maxLength: 180,
      placeholder: 'apikey  (SendGrid uses literally "apikey")',
    },
    {
      kind: 'string',
      key: 'password',
      label: 'Password / API key',
      maxLength: 400,
      placeholder: 'Paste your API key or SMTP password',
      help: 'We store this safely and never show it back to you. Leave blank to keep the saved value.',
    },
    {
      kind: 'string',
      key: 'fromAddress',
      label: 'Send emails from',
      maxLength: 180,
      placeholder: 'noreply@yoursite.com',
      help: 'Must be an address your SMTP provider has verified for you.',
    },
    {
      kind: 'string',
      key: 'fromName',
      label: 'Display name (optional)',
      maxLength: 120,
      placeholder: 'CaveCMS',
    },
    {
      kind: 'string',
      key: 'notificationRecipient',
      label: 'Lead notifications go to (optional)',
      maxLength: 180,
      placeholder: 'sales@yoursite.com',
      help: 'Receives an email when a visitor submits the contact, inquiry, or brochure form. Leave blank to use the From address.',
    },
  ],

  updates: [
    {
      kind: 'boolean',
      key: 'autoDownload',
      label: 'Download updates in the background',
      help: 'When a new version is found, download and verify it ahead of time so installing is near-instant when you click Update. Nothing installs on its own. Turn off if your server is on a metered or restricted connection.',
    },
    {
      kind: 'boolean',
      key: 'autoApplySecurityPatches',
      label: 'Apply security patches automatically',
      help: 'When a release is flagged as a security fix, install it on the next check without asking. Feature updates always require a click.',
    },
    {
      kind: 'string',
      key: 'notificationEmail',
      label: 'Notify this email when an update is available (optional)',
      maxLength: 180,
      placeholder: 'ops@example.com',
      help: 'Leave blank to skip email notifications — the dashboard banner is shown to every admin regardless.',
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
  updates:
    'CaveCMS checks for new releases automatically. Security patches can install on their own; feature updates always wait for your click.',
  site_general:
    'Your site’s public address and display name. CaveCMS uses these to build links in emails, sitemap.xml, and search-engine metadata.',
  smtp_config:
    'Outbound email — used for lead notifications, password reset, and update alerts. Most operators paste credentials from a transactional email provider like SendGrid, Mailgun, or AWS SES.',
  session_config:
    'How long admin sessions last and when they auto-renew. Defaults follow the security gold-standard (8 h session, 24 h absolute cap).',
  ai_config:
    'Bring your own Gemini API key. The AI writing partner appears as a sparkle on every CMS section and as a Page Assistant chat in the bottom-left. AI never touches your settings, users, or files — only the words inside your blocks.',
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
  updates: 'object',
  smtp_config: 'object',
  site_general: 'object',
  session_config: 'object',
  ai_config: 'object',
}

export const SETTINGS_LABELS: Record<string, string> = {
  contact_info: 'Contact information',
  social_links: 'Social profiles',
  default_seo: 'Default search-engine details',
  footer: 'Footer',
  organization_json_ld: 'Brand info for search engines',
  site_header: 'Site header',
  updates: 'Updates',
  smtp_config: 'Email',
  site_general: 'General',
  session_config: 'Session lifetimes',
  ai_config: 'AI Assistant',
}
