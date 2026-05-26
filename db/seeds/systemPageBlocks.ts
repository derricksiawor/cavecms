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

interface WidgetSpec {
  kind: 'widget'
  blockType: string
  data: Record<string, unknown>
  meta?: Record<string, unknown>
}
interface ColumnSpec {
  kind: 'column'
  meta?: Record<string, unknown>
  widgets: WidgetSpec[]
}
interface SectionSpec {
  kind: 'section'
  meta: Record<string, unknown>
  columns: ColumnSpec[]
}

const POS_STEP = 1000

async function insertSections(pageId: number, sections: SectionSpec[]): Promise<number> {
  let inserted = 0
  let secPos = POS_STEP
  for (const sec of sections) {
    for (const col of sec.columns) {
      for (const w of col.widgets) {
        w.data = parseAndSanitize(w.blockType, w.data) as Record<string, unknown>
      }
    }
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
        const widgetMetaJson = w.meta ? JSON.stringify(w.meta) : null
        await db.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
          VALUES
            (${pageId}, ${columnId}, 'widget', NULL, ${w.blockType}, ${widPos},
             ${JSON.stringify(w.data)}, ${widgetMetaJson}, 0)
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
const HOME_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'lg' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Welcome', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: `${PH.company} — ${PH.tagline}`, level: 'h1', size: 'display-2xl', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>Replace this hero with a one-line description of who you are and what you do. Use the admin to edit any block.</p>', size: 'body-lg', alignment: 'left', tone: 'ivory', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
      { kind: 'widget', blockType: 'lx_action', data: { label: 'Get in touch', href: '/contact', variant: 'primary-gold', size: 'lg', alignment: 'left', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
  {
    kind: 'section',
    meta: { columns: 3, background: 'ivory', padding: 'md' },
    columns: [
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'What we do', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'obsidian', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>A short description of your first value proposition. Replace this with the headline benefit you deliver.</p>', size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'How we work', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'obsidian', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>A short description of your process. Replace this with how clients engage with you — the steps from first contact to delivery.</p>', size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
      { kind: 'column', widgets: [
        { kind: 'widget', blockType: 'lx_heading', data: { text: 'Who we serve', level: 'h3', size: 'display-sm', alignment: 'left', tone: 'obsidian', italic: false, animation: 'fade-in' } },
        { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>A short description of your audience. Replace this with the type of client, customer, or community you work with most.</p>', size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'wide', animation: 'fade-in' }, meta: { marginTop: 'xs' } },
      ] },
    ],
  },
  {
    kind: 'section',
    meta: { columns: 3, background: 'obsidian', padding: 'md' },
    columns: [
      { kind: 'column', widgets: [{ kind: 'widget', blockType: 'lx_stat', data: { value: 10, suffix: '+', label: 'Years of experience', duration_ms: 1500, alignment: 'center', tone: 'champagne' } }] },
      { kind: 'column', widgets: [{ kind: 'widget', blockType: 'lx_stat', data: { value: 100, suffix: '+', label: 'Projects delivered', duration_ms: 1900, alignment: 'center', tone: 'champagne' } }] },
      { kind: 'column', widgets: [{ kind: 'widget', blockType: 'lx_stat', data: { value: 50, suffix: '+', label: 'Happy clients', duration_ms: 2300, alignment: 'center', tone: 'champagne' } }] },
    ],
  },
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'lg' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'A kind word', prefix: 'none', tone: 'champagne', alignment: 'center', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_quote', data: { quote: 'Working with this team was the clearest decision we made this year. They listened, they delivered, and they did it on time.', attribution: 'A Happy Customer', alignment: 'center', tone: 'ivory', animation: 'slide-up' }, meta: { marginTop: 'md' } },
    ] }],
  },
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Ready to talk?', level: 'h2', size: 'display-md', alignment: 'center', tone: 'obsidian', italic: false, animation: 'slide-up' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: `<p>Tell us about what you're working on. We respond to every message.</p>`, size: 'body-md', alignment: 'center', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_action', data: { label: 'Start a conversation', href: '/contact', variant: 'primary-gold', size: 'md', alignment: 'center', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
]
export async function seedHomePageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('home', HOME_SECTIONS) }

// ── ABOUT ───────────────────────────────────────────────────────────
const ABOUT_SECTIONS: SectionSpec[] = [
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
const SERVICES_SECTIONS: SectionSpec[] = [
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
const PROJECTS_SECTIONS: SectionSpec[] = [
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
const CONTACT_SECTIONS: SectionSpec[] = [
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

// ── PRIVACY ─────────────────────────────────────────────────────────
const PRIVACY_BODY = `
<p>This page sets out what personal data ${PH.company} collects through this website, what we do with it, and the rights you have over it. Replace the placeholder copy with language that matches your jurisdiction and the data you actually collect.</p>

<h3>Who we are</h3>
<p>${PH.company} is the data controller responsible for personal data collected through this website. You can reach us at <a href="${PH.emailHref}">${PH.email}</a> or by post at ${PH.addressLong}.</p>

<h3>What we collect</h3>
<ul>
  <li><strong>Contact-form submissions:</strong> the name, email, and message you send via the contact form.</li>
  <li><strong>Newsletter subscriptions:</strong> the email address you provide.</li>
  <li><strong>Usage data:</strong> basic analytics about how visitors navigate the site (page URLs, referrer, device type, anonymised IP).</li>
  <li><strong>Cookies:</strong> we use a small number of cookies — essential ones to keep the site working and, optionally, analytics cookies you can decline.</li>
</ul>

<h3>What we do with it</h3>
<ul>
  <li><strong>Respond to enquiries</strong> you send through the contact form or by email.</li>
  <li><strong>Send newsletters</strong> only when you have opted in. Every newsletter includes a one-click unsubscribe.</li>
  <li><strong>Understand what works</strong> on the site through aggregate analytics. We do not sell your personal data to anyone.</li>
</ul>

<h3>Your rights</h3>
<p>You can request a copy of the personal data we hold about you, ask us to correct or delete it, or object to a specific use. Write to <a href="${PH.emailHref}">${PH.email}</a> and we will respond within 30 days.</p>

<h3>Sharing and storage</h3>
<p>We share personal data with the service providers we use to run this site (hosting, email delivery, analytics). We do not transfer your data outside the regions we operate in without notifying you. We keep contact-form submissions for as long as the conversation is active, and newsletter subscriptions until you unsubscribe.</p>

<h3>Updates</h3>
<p>We update this policy when our practices change. The current version is dated below; major changes will be flagged on this page.</p>
`.trim()

const PRIVACY_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Legal', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Privacy Policy', level: 'h1', size: 'display-xl', alignment: 'left', tone: 'obsidian', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: PRIVACY_BODY, size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
]
export async function seedPrivacyPageBlocksIfEmpty(): Promise<number | false> { return seedSystemPageIfEmpty('privacy', PRIVACY_SECTIONS) }

// ── TERMS ───────────────────────────────────────────────────────────
const TERMS_BODY = `
<p>These terms govern your use of this website operated by ${PH.company}. They sit alongside the contracts and agreements you sign with us for specific work. Replace the placeholder language with terms that match the products or services you sell.</p>

<h3>Using the site</h3>
<p>You may browse this site, share links to its pages, and quote short extracts with a clear credit. You may not republish, resell, or repackage substantial portions of our content without written permission.</p>

<h3>Content on the site</h3>
<p>Information on this site is for general guidance. Prices, examples, descriptions, and project information are invitations to discuss — they are not binding offers and do not by themselves create a contract. A contract only arises once both parties have signed a written agreement.</p>

<h3>Accuracy and changes</h3>
<p>We do our best to keep the site accurate and up to date, but we do not warrant that every piece of information is current or free from error. We may update or remove content without notice.</p>

<h3>Your information</h3>
<p>When you contact us through this site you submit personal data, which we handle according to our <a href="/privacy">Privacy Policy</a>. Please do not send confidential or sensitive material through the contact form.</p>

<h3>Intellectual property</h3>
<p>The text, images, brand marks, and code on this site belong to ${PH.company} or to the partners and rights-holders we license them from.</p>

<h3>Liability</h3>
<p>We are not liable for indirect or consequential loss arising from your use of this site. Nothing in these terms limits liability for fraud, death, or personal injury caused by negligence to the extent that the law does not allow such limits.</p>

<h3>Governing law</h3>
<p>These terms are governed by the laws applicable at our place of business. Replace this line with the jurisdiction you operate in.</p>

<h3>Contact</h3>
<p>Questions about these terms go to <a href="${PH.emailHref}">${PH.email}</a> or ${PH.phone}.</p>
`.trim()

const TERMS_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Legal', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Terms of Service', level: 'h1', size: 'display-xl', alignment: 'left', tone: 'obsidian', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: TERMS_BODY, size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
]
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
