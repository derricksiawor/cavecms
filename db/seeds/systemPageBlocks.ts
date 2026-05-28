// System-page block seeds. Each `seed*PageBlocksIfEmpty()` populates the
// CMS block tree for one system page (home / about / services / contact /
// privacy / terms / projects) when its `content_blocks` set is empty.
// Idempotent: re-running on a page that already has live blocks is a
// no-op, so this is safe to invoke from `pnpm db:seed` on every dev
// bootstrap.
//
// All copy is GENERIC placeholder content with [Your Company]-style
// markers so a fresh CaveCMS install reads as a neutral demo. Operators
// edit the literal placeholder text in /admin/pages via the inline-edit
// drawer.

import { sql } from 'drizzle-orm'
import { db } from '../client-node'
import { contentBlocks } from '../schema'
import { parseAndSanitize } from '@/lib/cms/parse'
import type {
  SectionSpec,
  ColumnSpec,
  WidgetSpec,
} from '@/lib/cms/siteTemplates/types'
import { PRIVACY_SECTIONS, TERMS_SECTIONS } from '@/lib/cms/siteTemplates/legalContent'

// Re-export so existing consumers of these interfaces inside this
// module remain explicit. The canonical definitions live in
// lib/cms/siteTemplates/types.ts because the install-template path
// also needs them.
export type { SectionSpec, ColumnSpec, WidgetSpec }

const POS_STEP = 1000

async function insertSections(pageId: number, sections: SectionSpec[]): Promise<number> {
  // IMPORTANT: this function MUST NOT mutate `sections`, `sec`, `col`,
  // or `w` — the SECTION arrays are exported and re-imported by
  // lib/cms/siteTemplates/default-welcome.ts. Mutating `w.data` on the
  // shared module-scope reference would corrupt the install-template
  // re-seed path (which reads the same arrays). Always produce a local
  // sanitized copy and pass that to the DB write.
  let inserted = 0
  let secPos = POS_STEP
  for (const sec of sections) {
    const [secRes] = (await db.execute(sql`
      INSERT INTO content_blocks
        (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
      VALUES
        (${pageId}, NULL, 'section', NULL, 'section', ${secPos}, '{}',
         ${JSON.stringify(sec.meta)}, 0)
    `)) as unknown as [{ insertId: number | bigint }]
    const sectionId = Number(secRes.insertId)
    inserted++
    let colPos = POS_STEP
    for (const col of sec.columns) {
      const colMeta = col.meta ?? {}
      const [colRes] = (await db.execute(sql`
        INSERT INTO content_blocks
          (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
        VALUES
          (${pageId}, ${sectionId}, 'column', NULL, 'column', ${colPos}, '{}',
           ${JSON.stringify(colMeta)}, 0)
      `)) as unknown as [{ insertId: number | bigint }]
      const columnId = Number(colRes.insertId)
      inserted++
      let widPos = POS_STEP
      for (const w of col.widgets) {
        const cleaned = parseAndSanitize(w.blockType, w.data) as Record<string, unknown>
        const widgetMetaJson = w.meta ? JSON.stringify(w.meta) : null
        await db.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
          VALUES
            (${pageId}, ${columnId}, 'widget', NULL, ${w.blockType}, ${widPos},
             ${JSON.stringify(cleaned)}, ${widgetMetaJson}, 0)
        `)
        inserted++
        widPos += POS_STEP
      }
      colPos += POS_STEP
    }
    secPos += POS_STEP
  }
  return inserted
}

const PH = {
  company: '[Your Company]',
  tagline: '[Your tagline]',
  email: 'hello@yourdomain.com',
  phone: '+1 555 0100',
  phoneHref: 'tel:+15550100',
  address: '123 Your Street, Your City',
  addressLong: '123 Your Street, Suite 100, Your City, State 00000',
  emailHref: 'mailto:hello@yourdomain.com',
} as const

// ── HOME ────────────────────────────────────────────────────────────
// Default home is a CaveCMS welcome page. Fresh install lands here:
// the operator sees what's running and what they can do next. They
// edit this page (or replace it entirely) once they choose a template
// from the install wizard's template chooser (planned).
export const HOME_SECTIONS: SectionSpec[] = [
  // ── Hero — welcome
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'lg' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Welcome', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: `You're running CaveCMS.`, level: 'h1', size: 'display-2xl', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>This entire page is built from CMS blocks. Sign in to your admin URL to start editing — drag, drop, type, save.</p>', size: 'body-lg', alignment: 'left', tone: 'ivory', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
      { kind: 'widget', blockType: 'lx_action', data: { label: 'Read the docs', href: 'https://cavecms.derricksiawor.com', openInNew: true, variant: 'primary-gold', size: 'lg', alignment: 'left', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },

  // ── 3 cards — what's in CaveCMS
  {
    kind: 'section',
    meta: { columns: 3, background: 'obsidian', padding: 'md' },
    columns: [
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Pages', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'ivory', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Drag-and-drop block trees. Hero, columns, forms, media, embeds — edit inline on the live page or from the admin drawer.</p>', size: 'body-md', alignment: 'left', tone: 'ivory', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Posts', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'ivory', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Blog posts authored in markdown or the same block editor. Schedule, tag, and feature them anywhere a posts list block appears.</p>', size: 'body-md', alignment: 'left', tone: 'ivory', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Settings', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'ivory', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>SMTP, integrations, AI assistant, security policies, auto-updates — all dashboard-configurable. No .env editing after install.</p>', size: 'body-md', alignment: 'left', tone: 'ivory', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
    ],
  },

  // ── Get started (ivory breakout — keeps obsidian-dominant rhythm
  // but lets the "next steps" section breathe with a lighter surface)
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Get started', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Make this site yours', level: 'h2', size: 'display-md', alignment: 'left', tone: 'obsidian', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: {
        body_richtext:
          '<p>Three steps to take this from a fresh install to a real site:</p>' +
          '<ol>' +
            '<li><strong>Sign in</strong> at the secret admin URL you set during install.</li>' +
            '<li><strong>Edit this page</strong> — and the other system pages (About, Services, Contact, Privacy, Terms) — from Admin → Pages.</li>' +
            '<li><strong>Configure</strong> your site name, contact info, SMTP, and integrations under Admin → Settings.</li>' +
          '</ol>' +
          '<p>If you want a different starter template, run the install wizard’s template chooser (coming soon) or just replace this page block-by-block.</p>',
        size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in',
      }, meta: { marginTop: 'md' } },
    ] }],
  },

  // ── Resources — links to docs and source
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Resources', prefix: 'none', tone: 'champagne', alignment: 'center', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Docs and source', level: 'h2', size: 'display-md', alignment: 'center', tone: 'ivory', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: {
        body_richtext:
          '<p>Documentation, install guides, and release notes live at <a href="https://cavecms.derricksiawor.com" target="_blank" rel="noopener noreferrer">cavecms.derricksiawor.com</a>.</p>' +
          '<p>Source and issues: <a href="https://github.com/derricksiawor/cavecms" target="_blank" rel="noopener noreferrer">github.com/derricksiawor/cavecms</a>.</p>',
        size: 'body-md', alignment: 'center', tone: 'ivory', maxWidth: 'medium', animation: 'fade-in',
      }, meta: { marginTop: 'md' } },
    ] }],
  },
]
export async function seedHomePageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('home', HOME_SECTIONS) }

// ── ABOUT ───────────────────────────────────────────────────────────
export const ABOUT_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'lg' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'About', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: `About ${PH.company}`, level: 'h1', size: 'display-2xl', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Replace this with a single sentence about why your company exists.</p>', size: 'body-lg', alignment: 'left', tone: 'ivory', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Our story', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Built on craft and care', level: 'h2', size: 'display-md', alignment: 'left', tone: 'obsidian', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Replace this paragraph with the origin story. Where did you start, what was the first project, who did you build for?</p><p>Then a second paragraph about where you are today — the team, the practice, what you spend your days on.</p>', size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
  {
    kind: 'section',
    meta: { columns: 3, background: 'obsidian', padding: 'md' },
    columns: [
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Craft', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'ivory', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>What craft means inside your company — the standard you hold yourselves to.</p>', size: 'body-md', alignment: 'left', tone: 'ivory', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Honesty', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'ivory', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>How you talk with clients, contractors, and each other. Straight, transparent, on the record.</p>', size: 'body-md', alignment: 'left', tone: 'ivory', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Care', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'ivory', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>The follow-through. The small details that the spec sheet never mentions but the customer always notices.</p>', size: 'body-md', alignment: 'left', tone: 'ivory', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
    ],
  },
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Get to know us.', level: 'h2', size: 'display-md', alignment: 'center', tone: 'obsidian', italic: false, animation: 'slide-up' } },
      { kind: 'widget', blockType: 'lx_action', data: { label: 'Talk with us', href: '/contact', variant: 'primary-gold', size: 'md', alignment: 'center', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
]
export async function seedAboutPageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('about', ABOUT_SECTIONS) }

// ── SERVICES ────────────────────────────────────────────────────────
export const SERVICES_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'lg' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'What we offer', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Services', level: 'h1', size: 'display-2xl', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>One or two sentences framing your service catalogue — the shape of what you sell, how you scope it, and who it fits.</p>', size: 'body-lg', alignment: 'left', tone: 'ivory', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
  {
    kind: 'section',
    meta: { columns: 3, background: 'ivory', padding: 'md' },
    columns: [
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Service One', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'obsidian', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Describe your first service in two or three lines. What you do, what the outcome looks like, what is included.</p>', size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Service Two', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'obsidian', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Describe your second service. Keep it concrete — what the deliverable is, how long it usually takes, what the client gets at the end.</p>', size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Service Three', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'obsidian', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Describe your third service. If you offer more than three, duplicate this column from the admin.</p>', size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
    ],
  },
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Need something custom?', level: 'h2', size: 'display-md', alignment: 'center', tone: 'ivory', italic: false, animation: 'slide-up' } },
      { kind: 'widget', blockType: 'lx_action', data: { label: 'Get in touch', href: '/contact', variant: 'primary-gold', size: 'md', alignment: 'center', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
]
export async function seedServicesPageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('services', SERVICES_SECTIONS) }

// ── PROJECTS ────────────────────────────────────────────────────────
export const PROJECTS_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'lg' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Portfolio', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Selected work', level: 'h1', size: 'display-2xl', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>A short framing of how you choose what to show here, and what each project says about the team that delivered it.</p>', size: 'body-lg', alignment: 'left', tone: 'ivory', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Projects you add via <strong>Admin → Projects</strong> appear here automatically. Drop in a featured-projects block from the inline-edit drawer to surface them in a custom layout.</p>', size: 'body-md', alignment: 'center', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in' } },
    ] }],
  },
]
export async function seedProjectsPageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('projects', PROJECTS_SECTIONS) }

// ── CONTACT ─────────────────────────────────────────────────────────
export const CONTACT_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'lg' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Get in touch', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Tell us what you are working on', level: 'h1', size: 'display-2xl', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Every message reaches a real person. We respond the same business day.</p>', size: 'body-lg', alignment: 'left', tone: 'ivory', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
  {
    kind: 'section',
    meta: { columns: 3, background: 'obsidian', padding: 'sm' },
    columns: [
      { kind: 'column', widgets: [{ kind: 'widget', blockType: 'lx_channel_card', data: { label: 'Email', value: PH.email, description: 'Best for quotes, briefs, and introductions.', href: PH.emailHref, icon: 'mail', tone: 'ivory' } }] },
      { kind: 'column', widgets: [{ kind: 'widget', blockType: 'lx_channel_card', data: { label: 'Phone', value: PH.phone, description: 'Call during office hours.', href: PH.phoneHref, icon: 'phone', tone: 'ivory' } }] },
      { kind: 'column', widgets: [{ kind: 'widget', blockType: 'lx_channel_card', data: { label: 'Address', value: PH.address, description: 'Visits by appointment.', icon: 'map-pin', tone: 'ivory' } }] },
    ],
  },
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'contact_form', data: { heading: 'Send us a note.', intro: 'A short message about what you need — we will come back with next steps the same business day.', submit_label: 'Send message', success_headline: 'Thanks — we received your message.', success_body: 'A member of our team will be in touch shortly.' } },
    ] }],
  },
]
export async function seedContactPageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('contact', CONTACT_SECTIONS) }

// ── PRIVACY + TERMS ─────────────────────────────────────────────────
// Generic legal content moved to lib/cms/siteTemplates/legalContent.ts
// (pure data, no DB import) so the customer install path can seed the
// same content into empty legal pages without importing this node-DB
// module. The contributor `db:seed` path still seeds via the helpers
// below.
export async function seedPrivacyPageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('privacy', PRIVACY_SECTIONS) }
export async function seedTermsPageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('terms', TERMS_SECTIONS) }

// ── Shared helper ───────────────────────────────────────────────────
async function seedSystemPageIfEmpty(slug: string, sections: SectionSpec[]): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages WHERE system = 1 AND slug = ${slug} AND deleted_at IS NULL LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(`[seed:${slug}-blocks] no ${slug} system page row — run migrations first.`)
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  return insertSections(pageId, sections)
}
