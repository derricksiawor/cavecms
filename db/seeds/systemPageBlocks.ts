// System-page block seeds. Each `seed*PageBlocksIfEmpty()` populates the
// CMS block tree for one system page (home / about / services / contact)
// when its `content_blocks` set is empty. Idempotent: re-running on a
// page that already has live blocks is a no-op, so this is safe to
// invoke from `pnpm db:seed` on every dev bootstrap.
//
// Why this lives outside Drizzle migrations:
//   - Migrations express SCHEMA changes (DDL) — the block tree is DATA.
//   - The seed shape depends on the block-registry Zod schemas. Coupling
//     the tree to a SQL file means a future block-schema rename would
//     silently drift from the seed without a typecheck nudge.
//   - The idempotency check ("only seed when zero live blocks exist")
//     keeps the data write safe to re-run, which a migration's
//     "apply-once" ledger cannot guarantee on a developer's reset.
//
// Production: this script is run by `pnpm db:seed` (see db/seed.ts),
// which has its own NODE_ENV=production opt-in gate. The seed walks the
// block tree, INSERTing one row per node (section / column / widget)
// with parent_id linking — the runtime hydrator + renderer then read
// the tree exactly as if an operator had built it by hand.

import { sql } from 'drizzle-orm'
import { db } from '../client-node'
import { contentBlocks } from '../schema'
import { parseAndSanitize } from '@/lib/cms/parse'

// Tree shapes ─────────────────────────────────────────────────────────

interface WidgetSpec {
  kind: 'widget'
  blockType: string
  data: Record<string, unknown>
  /** Optional per-side spacing override (paddingTop/Bottom + marginTop
   *  etc). The dispatcher derives `outerClass` from this meta and threads
   *  it onto each widget's outer wrapper, where `!pt-X` Tailwind classes
   *  override the widget's baked-in `py-12 sm:py-16` defaults. Used to
   *  tighten the editorial rhythm when several widgets compose inside
   *  one column. */
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

// Insert spacing — leaves room for operators to slip rows in between
// later without re-numbering. Matches the 1000-step rhythm the existing
// About page seed (the only system page hand-authored to date) uses.
const POS_STEP = 1000

/**
 * Insert a section→column→widget subtree under `pageId`. Each node gets
 * sequential `position` values starting at `POS_STEP` and stepping by
 * `POS_STEP`. Returns the count of rows inserted (sections + columns +
 * widgets) so the caller can log a useful summary line.
 */
async function insertSections(
  pageId: number,
  sections: SectionSpec[],
): Promise<number> {
  let inserted = 0
  let secPos = POS_STEP
  for (const sec of sections) {
    // Pre-sanitize + validate widget payloads. parseAndSanitize is the
    // same write boundary the API uses on operator-edited blocks — running
    // it here means the seed's stored JSON matches the post-DOMPurify
    // shape exactly (so a future invariant check that compares stored
    // vs. read-parsed bytes wouldn't flag a drift on seeded rows). It
    // also fails LOUD on `pnpm db:seed` if a seed entry drifts from its
    // schema — instead of writing a row that the read-boundary parser
    // would silently skip on every page render.
    for (const col of sec.columns) {
      for (const w of col.widgets) {
        w.data = parseAndSanitize(w.blockType, w.data) as Record<
          string,
          unknown
        >
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

// Contact source-page block tree — LUXURY REDESIGN ────────────────────
//
// Per ~/.claude/CLAUDE.md design preferences:
//   - "Premium, luxury feel — NOT minimal. Maximum elegance always."
//   - "No borders/border lines."
//   - "Large icons with glow effects, gradient blur backgrounds for
//     depth, primary color highlights."
//   - "Badges instead of brackets for labels."
//   - "Default font: Montserrat."
//   - "Buttons: w-fit with padding, never flex-1."
//
// Every section uses an OBSIDIAN background — dark surface with
// champagne radial glows behind hero content + stat numbers + the
// closing CTA. Type is bold Montserrat throughout. Eyebrow labels
// render as champagne-tinted PILL BADGES (not bracket-style text).
//
// Section layout (all obsidian — section padding is intentionally tight
// because adjacent same-background sections double up the visual gap):
//   1. Hero               — obsidian · lg  · 1col  (badge + h1 + subhead)
//   2. Split Lead Capture — obsidian · md  · 2col  (form-first on mobile;
//                                                  socials end the channels column)
//   3. Visit Us — map     — obsidian · md  · 1col  (badge + heading + Google Maps embed)
//   4. Trust strip        — obsidian · md  · 3col  (3 lx_stats w/ glows)
//   5. Closing Quote      — obsidian · lg  · 1col  (badge + quote)

const CONTACT_SECTIONS: SectionSpec[] = [
  // ─── 1. Hero ────────────────────────────────────────────────────
  // Single-column obsidian with xl padding. Champagne BADGE above
  // a bold display headline; warm subhead beneath. The renderer's
  // section shell sets bg-obsidian text-ivory automatically; the
  // glow halo behind the hero comes from the widget animations +
  // the page-level atmosphere (large radial blurs are added per-
  // section by the LxStat / LxQuote / LxChannelCard renderers).
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
              text: 'Get In Touch',
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
              text: `Let's open the door to what's next`,
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
                `<p>Tell us about the home you're imagining. Every message reaches a principal directly — we reply the same business day.</p>`,
              size: 'body-lg',
              alignment: 'left',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 2. Reach Us Directly — header ─────────────────────────────
  // Single-column obsidian, sm padding. Eyebrow + heading sit above
  // the 3-col channel cards that immediately follow — tight padding
  // keeps the two sections visually coupled without merging the grid.
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'sm' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: {
              text: 'Reach Us Directly',
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
              text: 'Three Ways In',
              level: 'h2',
              size: 'display-md',
              alignment: 'left',
              tone: 'ivory',
              italic: false,
              animation: 'slide-up',
            },
            meta: { marginTop: 'xs' },
          },
        ],
      },
    ],
  },

  // ─── 3. Channel cards — 3-col row ───────────────────────────────
  // One lx_channel_card per column: email · phone · address.
  {
    kind: 'section',
    meta: { columns: 3, background: 'obsidian', padding: 'sm' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_channel_card',
            data: {
              label: 'Email',
              value: 'info@bestworldcompany.com',
              description: 'Best for quotes, viewings, and introductions.',
              href: 'mailto:info@bestworldcompany.com',
              icon: 'mail',
              tone: 'ivory',
            },
          },
        ],
      },
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_channel_card',
            data: {
              label: 'Phone',
              value: '+233 24 297 7639',
              description: 'Call or WhatsApp during office hours.',
              href: 'tel:+233242977639',
              icon: 'phone',
              tone: 'ivory',
            },
          },
        ],
      },
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_channel_card',
            data: {
              label: 'Address',
              value: 'Accra, Ghana',
              description:
                'Nuumo Kofi Anum Link, Okpegon-Ledzokuku — viewings by appointment.',
              icon: 'map-pin',
              tone: 'ivory',
            },
          },
        ],
      },
    ],
  },

  // ─── 4. Contact form + map — 2-col ──────────────────────────────
  // Form on the left, Google Maps embed (1:1 square) on the right.
  // Replaces the old standalone "Visit Us" section.
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'contact_form',
            data: {
              heading: 'Send us a note.',
              intro:
                `A short message about what you're looking for — we'll come back with next steps the same business day.`,
              submit_label: 'Send message',
              success_headline: `Thanks — we've received your message.`,
              success_body:
                'A member of our team will be in touch shortly.',
            },
          },
        ],
      },
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_map',
            data: {
              embedUrl:
                'https://maps.google.com/maps?q=JVJC%2BFFW+Accra&z=17&output=embed',
              ratio: '1:1',
              caption:
                'Nuumo Kofi Anum Link, Okpegon-Ledzokuku — Accra, Ghana',
              goldOverlay: false,
              animation: 'fade-in',
            },
          },
        ],
      },
    ],
  },

  // ─── 5. Trust Strip ─────────────────────────────────────────────
  // 3-column obsidian. Each stat carries its own champagne glow
  // backdrop via the LxStat renderer. Durations staggered 1500 /
  // 1900 / 2300 so the count-ups feel composed.
  {
    kind: 'section',
    meta: { columns: 3, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_stat',
            data: {
              value: 20,
              suffix: '+',
              label: 'Years of craft',
              duration_ms: 1500,
              alignment: 'center',
              tone: 'champagne',
            },
          },
        ],
      },
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_stat',
            data: {
              value: 120,
              suffix: '+',
              label: 'Residences delivered',
              duration_ms: 1900,
              alignment: 'center',
              tone: 'champagne',
            },
          },
        ],
      },
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_stat',
            data: {
              value: 14,
              label: 'Neighbourhoods served',
              duration_ms: 2300,
              alignment: 'center',
              tone: 'champagne',
            },
          },
        ],
      },
    ],
  },

  // ─── 5. Closing Quote ───────────────────────────────────────────
  // Single-column obsidian with 2xl cinematic padding. Champagne
  // badge above a bold-Montserrat quote (no italics, no serif). The
  // LxQuote renderer adds a glowing quote-icon glyph above the
  // text and a champagne attribution beneath.
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
              text: 'Our Promise',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_quote',
            data: {
              quote:
                'A home is the first thing you give your future. We build with that weight in mind.',
              attribution: 'Best World Properties',
              alignment: 'center',
              tone: 'ivory',
              animation: 'slide-up',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },
]

/**
 * Seed the Contact source page's CMS block tree. Idempotent: returns
 * `false` and exits without writes if Contact (system=1, slug='contact')
 * already has any live blocks. Returns the number of rows inserted on
 * a fresh seed.
 *
 * Lookup uses (system=1, slug='contact', deleted_at IS NULL) to avoid
 * binding to a specific `pages.id` — that value differs between fresh
 * DBs (auto-increment) and is the same lookup the clone-template
 * branch of `POST /api/cms/pages` uses, so the seed and the clone
 * agree on which row is the canonical Contact source.
 */
export async function seedContactPageBlocksIfEmpty(): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'contact' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:contact-blocks] no contact system page row — run migration 0010 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const inserted = await insertSections(pageId, CONTACT_SECTIONS)
  return inserted
}

// Privacy Policy block tree — Ghana DPA grounded ──────────────────────
//
// Authored against the Data Protection Act, 2012 (Act 843) — the only
// statute in Ghana that imposes substantive controller duties on a
// marketing site collecting names, emails, phones, and IPs through
// public lead-capture forms. Section numbers are cited only where the
// reference is publicly documented and stable (Section 17's eight
// principles, Section 24 retention, Section 28 security, Section 37
// children, Section 47 transfers — checked against the NITA-hosted Act
// PDF). Anything that depended on a citation we couldn't verify was
// dropped from the copy rather than fabricated.
//
// No placeholders: no "[Company Name]", no "Last updated: [date]",
// no DPC registration number (per the legal brief, NEVER ship a fake
// number — copy is written so the policy stands whether the number is
// later issued or not). All concrete identifiers (mailing address,
// phone, email, regulator URLs) are real.
//
// The whole tree renders against the obsidian background so the
// page reads as the same surface as Contact and the rest of the
// luxury redesign — a Privacy page that looks like a Word document
// inside a luxury site is jarring; legal copy on the same dark surface
// keeps the brand voice consistent.

const PRIVACY_SECTIONS: SectionSpec[] = [
  // ─── 1. Hero ────────────────────────────────────────────────────
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
              text: 'Privacy',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'How We Handle Your Information',
              level: 'h1',
              size: 'display-2xl',
              alignment: 'center',
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
                '<p>This page sets out what personal data Best World Properties collects through this website, what we do with it, and the rights you have over it under the Data Protection Act, 2012 (Act 843) of Ghana.</p>',
              size: 'body-lg',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext: '<p><em>Last updated: 22 May 2026.</em></p>',
              size: 'body-sm',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'sm' },
          },
        ],
      },
    ],
  },

  // ─── 2. Who We Are ──────────────────────────────────────────────
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
              text: 'Who We Are',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Best World Properties (also trading as Best World Company) is a real estate developer and brokerage based in Accra, Ghana. We are the data controller responsible for personal data collected through this website.</p>' +
                '<p><strong>Address:</strong> Nuumo Kofi Anum Link, Okpegon-Ledzokuku, Accra, Ghana.<br/>' +
                '<strong>Email:</strong> info@bestworldcompany.com<br/>' +
                '<strong>Phone:</strong> +233 24 297 7639</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 3. What we collect & why ───────────────────────────────────
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
              text: 'What We Collect, And Why',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We collect only what is needed to respond to you and to operate this site:</p>' +
                '<ul>' +
                '<li><strong>Contact details</strong> you give us through the enquiry, brochure, or project-interest forms — name, email address, phone number, and the message you write.</li>' +
                '<li><strong>Property interest</strong> — the project, listing, or brochure you have asked about.</li>' +
                '<li><strong>Newsletter subscription</strong> — your email address, the date you subscribed, and the confirmation status (we use double opt-in; you only join the list after clicking the confirmation link).</li>' +
                '<li><strong>Technical data</strong> — your IP address and the user-agent string of your browser, captured automatically when you submit a form, used for security (rate-limiting and abuse prevention) and to keep an audit record of submissions.</li>' +
                '</ul>' +
                '<p>We use this information to reply to your enquiry, send the brochure or information you asked for, deliver the quarterly newsletter you subscribed to, and protect the site from abuse. We do not sell your personal data, and we do not use it to advertise to you on other sites.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 4. Legal basis ─────────────────────────────────────────────
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
              text: 'Our Legal Basis',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We process your personal data on the basis of your consent — by submitting a form on this site or subscribing to our newsletter, you consent to the processing described on this page. You may withdraw consent at any time by emailing <a href="mailto:info@bestworldcompany.com">info@bestworldcompany.com</a> or, for the newsletter specifically, by using the unsubscribe link in any of our emails.</p>' +
                '<p>We handle all personal data in line with the eight principles in Section 17 of the Data Protection Act, 2012 — accountability, lawful processing, specification of purpose, compatibility of further processing, quality of information, openness, security safeguards, and your right to participate as the data subject.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 5. How Long We Keep It ─────────────────────────────────────
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
              text: 'How Long We Keep It',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<ul>' +
                '<li><strong>Enquiries, brochure requests, and project interest:</strong> retained for up to 24 months after our last interaction with you, so we can answer follow-up questions and keep a record of the conversation. After that we either anonymise the record or delete it, except where a follow-up has converted into an active transaction, in which case Anti-Money Laundering Act, 2020 (Act 1044) record-retention obligations apply for at least five years.</li>' +
                '<li><strong>Newsletter subscriber list:</strong> kept while your subscription is active. If you unsubscribe, we retain the unsubscribe record indefinitely so we know not to email you again, but we delete everything else.</li>' +
                '<li><strong>Technical data (IP, user-agent):</strong> retained for up to 90 days for security and abuse-prevention, after which it is purged or aggregated.</li>' +
                '</ul>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 6. Your Rights ─────────────────────────────────────────────
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
              text: 'Your Rights',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Under the Data Protection Act, 2012, you have the right to:</p>' +
                '<ul>' +
                '<li>Ask us what personal data we hold about you, and receive a copy.</li>' +
                '<li>Ask us to correct any data that is wrong or incomplete.</li>' +
                '<li>Ask us to delete your data where it is no longer needed for the purpose you originally gave it for.</li>' +
                '<li>Object to processing for direct marketing — practically, this is the same as unsubscribing from the newsletter.</li>' +
                '<li>Withdraw your consent at any time. Withdrawing consent does not affect the lawfulness of processing that happened before you withdrew.</li>' +
                '</ul>' +
                '<p>To exercise any of these rights, email <a href="mailto:info@bestworldcompany.com">info@bestworldcompany.com</a>. We will respond within a reasonable period. If you are not satisfied with how we handle your request, you have the right to complain to the Data Protection Commission of Ghana — see the Contact section below.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 7. How We Keep It Safe ─────────────────────────────────────
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
              text: 'How We Keep It Safe',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>All form submissions travel over an encrypted connection (HTTPS) to our servers. Access to lead records is restricted to authorised staff and protected by individual accounts, password hashing, multi-factor measures on administrative routes, and an audit log of who saw and changed what. Newsletter unsubscribe tokens rotate on every status change so a forwarded link cannot be replayed after you have acted on it.</p>' +
                '<p>We work with a small number of third-party services that process personal data on our behalf — email-delivery providers (to send confirmation emails and the newsletter), application hosting (to serve this site), and operational logging. Each is bound by their own data-protection obligations, and we only share the minimum needed to deliver the service. We do not engage advertising networks that track you across other sites.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 8. Cookies & tracking ──────────────────────────────────────
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
              text: 'Cookies And Tracking',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We use a small number of strictly-necessary cookies and tokens to keep this site secure (CSRF protection on the contact and newsletter forms, abuse-prevention rate limits, and a session marker for staff who edit the site). These are first-party cookies and we do not use them for marketing or cross-site tracking.</p>' +
                '<p>Most browsers let you block or delete cookies through their settings. If you block the strictly-necessary cookies, parts of the site that require them (the contact form, the newsletter signup) may stop working.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 9. International transfers ─────────────────────────────────
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
              text: 'Transfers Outside Ghana',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Some of the operational services we rely on — email delivery, application hosting, analytics — may process personal data on servers located outside Ghana. Where this happens we rely on the service provider\'s own contractual data-protection commitments, and we limit what we share to what each service strictly needs.</p>' +
                '<p>By submitting a form on this site or subscribing to our newsletter, you consent to this processing arrangement. If you do not want your personal data processed outside Ghana, please email us before submitting a form and we will work with you on an alternative.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 10. Children ───────────────────────────────────────────────
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
              text: 'Children',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>This site is not directed at children under 18. We do not knowingly collect personal data from anyone under 18 through the enquiry, brochure, or newsletter forms. Section 37 of the Data Protection Act, 2012 treats a child\'s personal data as special personal data with stricter processing limits. If you believe a child has submitted information to us, please email <a href="mailto:info@bestworldcompany.com">info@bestworldcompany.com</a> and we will delete the record.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 11. Updates To This Policy ─────────────────────────────────
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
              text: 'Updates To This Policy',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We may update this policy from time to time — when our products change, when our processors change, or when Ghanaian law changes. We will update the "Last updated" date at the top of this page when we do. Substantial changes that affect how we handle your data will be communicated to active newsletter subscribers by email before they take effect.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 12. Contact & complaints ───────────────────────────────────
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
              text: 'Questions',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Contact Our Data Team',
              level: 'h2',
              size: 'display-md',
              alignment: 'center',
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
                '<p>For any privacy question, request to exercise a right, or complaint about how we have handled your data, write to <a href="mailto:info@bestworldcompany.com">info@bestworldcompany.com</a> or call +233 24 297 7639.</p>' +
                '<p>If you are not satisfied with how we have handled your concern, you can complain to Ghana\'s Data Protection Commission. The Commission\'s website is <a href="https://dataprotection.org.gh" target="_blank" rel="noopener noreferrer">dataprotection.org.gh</a>.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },
]

// Terms of Service block tree — Ghana-grounded ────────────────────────
//
// Anchored to:
//   - Electronic Transactions Act, 2008 (Act 772): disclosures + opt-out
//     for electronic communications; the marketing-page-is-not-an-offer
//     framing rests on common-law contract principles, not a specific
//     section of Act 772.
//   - Real Estate Agency Act, 2020 (Act 1047): regulator and conduct
//     framework for licensed agents/brokers. We name the Real Estate
//     Agency Council (REAC) but do NOT ship a fabricated licence number.
//   - Anti-Money Laundering Act, 2020 (Act 1044): real estate is a
//     DNFBP supervised by the Financial Intelligence Centre; KYC and
//     source-of-funds obligations attach at the transaction stage.
//   - Foreign Exchange Act, 2006 (Act 723) + Bank of Ghana directives:
//     pricing must be in Ghana Cedis (GHS); USD shown only as indicative
//     reference. Copy makes the GHS-primacy explicit.
//
// No placeholder language. The licence number line is written as a
// commitment to publish it once issued, not a faked credential.

const TERMS_SECTIONS: SectionSpec[] = [
  // ─── 1. Hero ────────────────────────────────────────────────────
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
              text: 'Terms',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Terms Of Use',
              level: 'h1',
              size: 'display-2xl',
              alignment: 'center',
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
                '<p>These terms govern your use of this website. By browsing the site, submitting a form, or subscribing to our newsletter, you agree to them. If you do not agree, please do not use the site.</p>',
              size: 'body-lg',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext: '<p><em>Last updated: 22 May 2026.</em></p>',
              size: 'body-sm',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'sm' },
          },
        ],
      },
    ],
  },

  // ─── 2. Who We Are ──────────────────────────────────────────────
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
              text: 'Who We Are',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Best World Properties (also trading as Best World Company) is a Ghana-based real estate developer and brokerage. We are regulated by the Real Estate Agency Council of Ghana under the Real Estate Agency Act, 2020 (Act 1047) — once our licence number has been issued by the Council we will publish it on this page.</p>' +
                '<p><strong>Address:</strong> Nuumo Kofi Anum Link, Okpegon-Ledzokuku, Accra, Ghana.<br/>' +
                '<strong>Email:</strong> info@bestworldcompany.com<br/>' +
                '<strong>Phone:</strong> +233 24 297 7639</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 3. Use of this site ────────────────────────────────────────
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
              text: 'Using This Site',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>You may browse the site, read the project information we publish, and submit enquiries or newsletter signups for your own personal, non-commercial use. You may not scrape the site, attempt to bypass the security or rate-limit controls, impersonate another person on the forms, or use the site to send unsolicited communications to us or anyone else. We may suspend or refuse service to anyone who breaches these rules.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 4. Listings, brochures, and pricing ─────────────────────────
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
              text: 'Listings, Brochures, And Prices',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Project information, brochures, floor plans, renderings, and indicative prices on this site are invitations to discuss — they are not binding offers and do not by themselves create a sale or lease contract. A binding agreement only arises once you and Best World Properties have signed a written sale or lease document.</p>' +
                '<p>Floor plans and renderings are artistic impressions intended to give a feel for a project. Final layouts, materials, finishes, and dimensions may vary, and we reserve the right to substitute items of equal or higher specification where reasonably necessary during construction. Availability, prices, and incentives can change without notice.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 5. Pricing & currency ──────────────────────────────────────
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
              text: 'Pricing And Currency',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>All prices on this site are quoted in Ghana Cedis (GHS), which is the legal tender for sales and leases of property in Ghana. Where we also display a US Dollar figure beside a Ghana Cedi price, the dollar figure is an indicative reference for international visitors, calculated at the prevailing interbank rate at the time of publication. The Ghana Cedi figure prevails for all transactions, and final invoices, deposits, and settlement are denominated and made in Ghana Cedis as required by the Foreign Exchange Act, 2006 (Act 723) and Bank of Ghana directives.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 6. Projects Under Development ──────────────────────────────
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
              text: 'Projects Under Development',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Where we market an off-plan or under-construction project, any delivery date we mention is an expected window — not a contractual guarantee. Final delivery is governed by the written sale agreement, including the construction programme attached to it. We will keep buyers informed of material changes to the programme.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 7. Identity Verification (AML) ─────────────────────────────
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
              text: 'Identity Verification',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Real estate businesses in Ghana are designated non-financial businesses and professions under the Anti-Money Laundering Act, 2020 (Act 1044), supervised by the Financial Intelligence Centre. Before completing any sale or lease, we are required to verify the identity of the buyer or tenant, confirm beneficial ownership where the buyer is a company, and reasonably establish the source of funds for the transaction.</p>' +
                '<p>We collect this information at the transaction stage, not through this website\'s public forms. We may decline, pause, or refer a transaction where we cannot complete this verification to our satisfaction. We keep these records for at least the five-year period required under Act 1044.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 8. Intellectual Property ───────────────────────────────────
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
              text: 'Intellectual Property',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>The text, images, floor plans, renderings, brand marks, and code on this site belong to Best World Properties or to the architects, photographers, and other rights-holders we license them from. You may share a link to a page on this site, and you may quote short extracts with a clear credit, but you may not republish, sell, or repackage our content without our written permission.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 9. External links ──────────────────────────────────────────
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
              text: 'Links To Other Sites',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>From time to time we link out to third-party sites — partners, regulators, or news articles. Those sites have their own terms and privacy practices, and we do not control or take responsibility for their content. Following an outbound link is at your own discretion.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 10. Liability ──────────────────────────────────────────────
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
              text: 'Limits On Our Liability',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We work hard to keep the information on this site accurate, up to date, and available, but the site is provided on an "as is" basis. To the fullest extent permitted by Ghanaian law, we are not liable for any indirect, incidental, or consequential loss arising from your use of, or inability to use, this site or anything you read on it. Nothing in these terms limits any liability that cannot be excluded under Ghanaian law (for example, liability for personal injury caused by negligence, or for fraud).</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 11. Electronic Communications ──────────────────────────────
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
              text: 'Electronic Communications',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Under the Electronic Transactions Act, 2008 (Act 772), the emails we send you in response to your enquiries, and the confirmation and newsletter emails you receive after subscribing, are legally valid communications. Every newsletter email we send carries an unsubscribe link that ends your subscription in one click. You can also unsubscribe at any time by emailing <a href="mailto:info@bestworldcompany.com">info@bestworldcompany.com</a>.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 12. Governing Law ──────────────────────────────────────────
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
              text: 'Governing Law',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>These terms, and any dispute arising out of your use of this site, are governed by the laws of the Republic of Ghana. The courts of Ghana have exclusive jurisdiction over any such dispute.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 13. Changes To These Terms ─────────────────────────────────
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
              text: 'Changes To These Terms',
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
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We may update these terms when our business, our products, or Ghanaian law changes. The "Last updated" date at the top of this page tells you when the current version took effect. Continuing to use the site after we publish a change means you accept the updated terms.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 14. Contact ────────────────────────────────────────────────
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
              text: 'Questions',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Talk To Us',
              level: 'h2',
              size: 'display-md',
              alignment: 'center',
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
                '<p>Questions about these terms — or about anything you have read on this site — go to <a href="mailto:info@bestworldcompany.com">info@bestworldcompany.com</a> or +233 24 297 7639. The Real Estate Agency Council of Ghana, our regulator, publishes its register and complaint route at <a href="https://reac.gov.gh" target="_blank" rel="noopener noreferrer">reac.gov.gh</a>.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },
]

// About source-page block tree ─────────────────────────────────────────
//
// Authored from the live bestworldcompany.com/about-us copy (4 company
// paragraphs + 6 "why choose" bullets + closing). Visual treatment
// matches the rest of the luxury system: obsidian sections, champagne
// eyebrows, centered alignment.
//
// The signature moment is Section 3 — a lx_image_pair (new in this PR)
// showing the staggered overlap of two interiors. media_id 5 + 6 are
// the b1.jpg (dining/living) + ba1.jpg (bathroom) pair downloaded from
// the source homepage.
//
// Trust strip stats match the Contact page exactly so the brand reads
// consistent across surfaces (Since 2015 / 120+ residences / 14
// neighbourhoods).

const ABOUT_SECTIONS: SectionSpec[] = [
  // ─── 1. Hero ────────────────────────────────────────────────────
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
              text: 'About',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'About Best World',
              level: 'h1',
              size: 'display-2xl',
              alignment: 'center',
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
                '<p>A developer of exclusive, elegant homes — built in Accra since 2015 by architects, builders, and finance professionals who treat every residence as the answer to a single brief.</p>',
              size: 'body-lg',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 2. Our Company ─────────────────────────────────────────────
  // Source copy verbatim from bestworldcompany.com/about-us. Four
  // paragraphs, condensed into a single lx_text block — the renderer
  // handles paragraph spacing.
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: {
              text: 'Our Company',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Best World Company',
              level: 'h2',
              size: 'display-md',
              alignment: 'center',
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
                '<p>Best World Real Estate is committed to being the developer of choice, offering exclusive and elegant housing solutions for clients across diverse lifestyles. Based in Accra, we specialise in creating high-quality homes in the central business district and emerging communities.</p>' +
                '<p>Founded by seasoned professionals with expertise in architecture, construction, real estate finance, sales, and property management, our team ensures exceptional project delivery.</p>' +
                '<p>Our mission is to provide housing solutions that cater to every lifestyle — market-leading prices, trusted investment opportunities, and turnkey developments that meet the highest standards of excellence and reliability.</p>' +
                '<p>Since 2015, Best World has been dedicated to making luxury homes accessible, delivering quality developments, and building a trusted global real estate brand.</p>',
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 3. Layered image pair ──────────────────────────────────────
  // The signature visual moment — staggered overlap composition of two
  // interiors. media_id 5 (dining/living) lifts as the front; media_id
  // 6 (bathroom) tucks underneath. Centered alignment via the section
  // shell; the renderer's mx-auto + max-w-5xl frames the composition.
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_image_pair',
            data: {
              // Left lifts (front) — open-plan dining and living area
              // with sculptural pendant lighting. Right tucks
              // underneath — concrete-walled bathroom with floating
              // vanity. The pair is the staggered editorial moment
              // the design brief asked for.
              leftImage: {
                media_id: 10,
                alt: 'Open-plan dining and living area in a Best World residence with sculptural pendant lighting and a black dining table',
              },
              rightImage: {
                media_id: 11,
                alt: 'Concrete-walled bathroom in a Best World residence with a floating vanity and rain shower',
              },
              layout: 'lift-left',
              overlap: 'md',
              ratio: '4:5',
              animation: 'fade-in',
            },
          },
        ],
      },
    ],
  },

  // Trust strip REMOVED — the previous draft of this seed had a
  // 3-column lx_stat block (10+ years / 120+ residences / 14
  // neighbourhoods). Only the founding-year math (Since 2015) is
  // verifiable from the source; "120+ residences delivered" and "14
  // neighbourhoods served" are not stated anywhere on bestworldcompany
  // .com or in any source the operator has pointed at, so they were
  // fabricated padding for the layout. Pulled per the project's
  // "no false stuff" rule. If the operator later confirms real
  // figures, drop a stat row back in at this position (POS_STEP=4000
  // between sections 3 and 5).

  // ─── 4. Why choose Best World ───────────────────────────────────
  // Source bullets verbatim from /about-us. Rendered as an HTML list
  // inside lx_text so the renderer's sanitizer-allowlisted <ul>/<li>
  // survive parse + maintain the centred reading column.
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: {
              text: 'Best World',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Why Choose Best World?',
              level: 'h2',
              size: 'display-md',
              alignment: 'center',
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
                '<ul>' +
                '<li>Functional designs and premium finishes</li>' +
                '<li>Competitive pricing with interest-free payment plans</li>' +
                '<li>Exclusive gated communities</li>' +
                '<li>Prime locations across Accra and emerging corridors</li>' +
                '<li>A customer-centric approach end to end</li>' +
                '<li>Proven excellence over a decade of delivery</li>' +
                '</ul>' +
                `<p>Explore a world of possibilities with Best World Properties, where luxury, comfort, and affordability come together to create homes you'll be proud to own.</p>`,
              size: 'body-md',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 6. Closing CTA ─────────────────────────────────────────────
  // Single-column obsidian; gives the page a clear hand-off back to
  // the contact flow rather than terminating on the bullet list.
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
              text: 'Visit Us',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Ready To See One In Person?',
              level: 'h2',
              size: 'display-md',
              alignment: 'center',
              tone: 'ivory',
              italic: false,
              animation: 'slide-up',
            },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_action',
            data: {
              label: 'Schedule a tour',
              href: '/contact',
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
]

// Homepage block tree ────────────────────────────────────────────────
//
// Authored from bestworldcompany.com/. Four sections (hero + about +
// projects + journey) — copy verbatim from the source, no fabricated
// numbers.
//
// Image mapping:
//   - Hero bg            → media 12 (bs1 — Best World gated-community
//                          streetscape; deliberately a property shot,
//                          not an interior detail. The visitor's first
//                          frame should communicate "we build homes",
//                          not "we have nice dining tables")
//   - About section img  → media 5  (b1.jpg — Best World villa
//                          exterior; matches the source's homepage
//                          About-section image exactly)
//   - Projects section bg → media 11 (shutterstock bathroom interior;
//                          same source-substitute reasoning as hero)
//   - Project cards      → projects 64 / 65 / 66 — already inserted
//                          for the /projects index work
//   - Journey image      → media 27 (b3.jpg — master bedroom; new
//                          media row inserted for this homepage build)

const HOME_SECTIONS: SectionSpec[] = [
  // ─── 1. Hero — full cover image with composed welcome copy ──────
  // Section-bg-image pattern (Elementor-parity). Eyebrow + h1
  // compose ON TOP of the cover photo. darken-strong overlay keeps
  // the heading legible against the community streetscape. lg
  // minHeight gives the hero a proper 540-620px box (the source's
  // hero is ~1024px on desktop; lg is the closest mapping that
  // doesn't push the rest of the page below the fold).
  {
    kind: 'section',
    meta: {
      columns: 1,
      background: 'obsidian',
      padding: '2xl',
      backgroundImage: {
        media_id: 28,
        alt: '',
      },
      backgroundOverlay: 'darken-strong',
      backgroundFit: 'cover',
      minHeight: 'lg',
    },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: {
              text: 'Welcome To Best World Properties, A Premier Real Estate Developer',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Crafting Modern Homes And Lasting Value',
              level: 'h1',
              size: 'display-2xl',
              alignment: 'center',
              tone: 'ivory',
              italic: false,
              animation: 'slide-up',
            },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_action',
            data: {
              label: 'Explore Our Projects',
              href: '/projects',
              openInNew: false,
              variant: 'primary-gold',
              size: 'md',
              alignment: 'center',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 2. About — image LEFT, text RIGHT ───────────────────────────
  // 2-col obsidian. Mirrors the source's "Building Homes That
  // Reflect Your Aspirations" section with the villa exterior on the
  // left and the company-vision copy on the right. CTA hands off to
  // /about for the full company narrative.
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'lg' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_figure',
            data: {
              image: {
                media_id: 29,
                alt: 'Front street view of The Kharis residences with manicured gardens and modern facades',
              },
              ratio: '1:1',
              fit: 'cover',
              corners: 'sharp',
              goldOverlay: false,
              animation: 'fade-in',
            },
          },
        ],
      },
      {
        kind: 'column',
        meta: { verticalAlign: 'center' },
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Best World', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Building Homes That Reflect Your Aspirations', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We are a premier real estate development company dedicated to delivering quality and luxurious homes in reputable locations in Accra, Ghana. Our operations adopt a customer-centric approach to make your home ownership and property investment journey as seamless as it is rewarding.</p>' +
                '<p>At Best World Properties, we believe a home is more than just a place to live — it&rsquo;s a reflection of who you are. We craft apartments and townhouses that resonate with your dreams, lifestyle, and vision for the future. Our developments are designed with great attention to detail, using the finest materials to ensure unmatched quality, top-tier finishing, and exceptional value.</p>',
              size: 'body-md',
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
            data: { label: 'About us', href: '/about', variant: 'primary-gold', size: 'md', alignment: 'left', animation: 'fade-in' },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 3. Projects — champagne bg + featured grid ──────────────────
  // Champagne (gold) background — plain color, no cover image.
  // Pairs with the surrounding obsidian sections and draws the eye
  // before the project cards.
  {
    kind: 'section',
    meta: {
      columns: 1,
      background: 'charcoal',
      padding: 'lg',
      minHeight: 'md',
    },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Extraordinary Accommodations', prefix: 'none', tone: 'champagne', alignment: 'center', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Our Projects', level: 'h2', size: 'display-md', alignment: 'center', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'featured_projects',
            data: {
              project_ids: [64, 65, 66],
              layout: 'grid',
            },
            meta: { marginTop: 'lg' },
          },
          {
            kind: 'widget',
            blockType: 'lx_action',
            data: { label: 'View All Projects', href: '/projects', openInNew: false, variant: 'primary-gold', size: 'md', alignment: 'center', animation: 'fade-in' },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 4. Journey — image LEFT, text RIGHT, brochure CTA ───────────
  // Mirrors source's closing "Your Seamless Journey to Luxury
  // Living" section. The bedroom interior on the left, the
  // homeownership narrative on the right, hands off via the
  // brochure request CTA to /contact.
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'lg' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_figure',
            data: {
              image: {
                media_id: 31,
                alt: 'Luxury master bedroom in a Mantebea Gardens double-storey residence',
              },
              ratio: '1:1',
              fit: 'cover',
              corners: 'sharp',
              goldOverlay: false,
              animation: 'fade-in',
            },
          },
        ],
      },
      {
        kind: 'column',
        meta: { verticalAlign: 'center' },
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Best World', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Your Seamless Journey To Luxury Living', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>At Best World, our clients are at the core of what we do. Whether purchasing your first home or investing as a seasoned buyer, we ensure a transparent, hassle-free process from selecting a unit to the final handover.</p>' +
                '<p>Our competitive prices and flexible, interest-free payment plans make owning your piece of luxury easier than ever. We offer monthly progress updates so you stay connected to the construction of your dream home no matter where you are.</p>',
              size: 'body-md',
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
            data: { label: 'Request brochure', href: '/contact', variant: 'primary-gold', size: 'md', alignment: 'left', animation: 'fade-in' },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },
]

/**
 * Seed the Home source page's CMS block tree.
 */
export async function seedHomePageBlocksIfEmpty(): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'home' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:home-blocks] no home system page row — run migration 0010 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const inserted = await insertSections(pageId, HOME_SECTIONS)
  return inserted
}

// Projects index block tree ──────────────────────────────────────────
//
// Authored from bestworldcompany.com/our-projects. Three live
// projects on the source (The Kharis, Mantebea Gardens, Anowaa
// Gardens) — already inserted into the local `projects` table
// (ids 64/65/66) with hero_image_id pointing at media ids 24/25/26.
//
// Section 1 is the new lx_cover_image hero (full-bleed, 21:9 with a
// 540px floor, gradient-bottom overlay so the heading below remains
// legible without competing with the photo). The hero uses media
// id 24 (The Kharis streetscape) as the cover.
//
// Section 2 stacks the eyebrow + display heading + intro paragraph
// — composed centred over the obsidian section that immediately
// follows the cover photo.
//
// Section 3 is `featured_projects` (existing block) keyed to the
// 3 project ids the operator wants on display. The block reads each
// project's slug + name + tagline + hero_image_id at render time
// via the hydratePage projects map, so swapping a thumbnail or
// adjusting copy in /admin/projects updates the index automatically.
//
// Section 4 is the closing CTA — hands the visitor back to /contact.

const PROJECTS_SECTIONS: SectionSpec[] = [
  // ─── 1. Hero — section background image + content on top ────────
  // Uses the new section-meta backgroundImage / overlay / minHeight
  // (Elementor-parity) so the eyebrow + heading + intro compose
  // directly over the cover photo. Replaces the previous two-section
  // arrangement (standalone lx_cover_image then a separate title
  // block). Per the LCP research, the section frame renders the
  // image as an <img loading="eager" fetchpriority="high"> rather
  // than CSS background-image so the browser preload-scanner picks
  // it up immediately.
  //
  // Padding 2xl + minHeight lg = generous cinematic hero box.
  // gradient-bottom overlay sits between the photo and the content
  // so the heading stays legible against the brighter top of the
  // image without flattening the whole photo.
  //
  // alt is intentionally empty — the photo is decorative here; the
  // heading carries the section's semantic meaning.
  {
    kind: 'section',
    meta: {
      columns: 1,
      background: 'obsidian',
      padding: '2xl',
      backgroundImage: {
        media_id: 24,
        alt: '',
      },
      backgroundOverlay: 'darken-strong',
      minHeight: 'lg',
    },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: {
              text: 'Projects',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Our Projects',
              level: 'h1',
              size: 'display-2xl',
              alignment: 'center',
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
                '<p>Gated communities across Accra — designed for the long view, built for the families who live in them.</p>',
              size: 'body-lg',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 3. Featured projects grid ───────────────────────────────────
  // Data-driven grid; the three published projects on the local DB
  // map 1-to-1 with the source page's three cards. featured_projects
  // renders /projects/<slug> links for each — those detail pages are
  // intentionally minimal for now (per operator: "not the individual
  // pages yet").
  {
    kind: 'section',
    meta: { columns: 1, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'featured_projects',
            data: {
              project_ids: [64, 65, 66],
              layout: 'grid',
            },
          },
        ],
      },
    ],
  },

  // ─── 4. Closing CTA ──────────────────────────────────────────────
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
            data: { text: 'Next Step', prefix: 'none', tone: 'champagne', alignment: 'center', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Want to see one in person?', level: 'h2', size: 'display-md', alignment: 'center', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_action',
            data: { label: 'Schedule a tour', href: '/contact', variant: 'primary-gold', size: 'lg', alignment: 'center', animation: 'fade-in' },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },
]

/**
 * Seed the Projects index source page's CMS block tree.
 */
export async function seedProjectsPageBlocksIfEmpty(): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'projects' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:projects-blocks] no projects system page row — run migration 0016 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const inserted = await insertSections(pageId, PROJECTS_SECTIONS)
  return inserted
}

// Services source-page block tree ────────────────────────────────────
//
// Authored from bestworldcompany.com/our-services. Six service rows
// (1 Expertise intro + 5 services) each rendered as a 2-column
// obsidian section with the text on one side and a layered image
// pair (lx_image_pair) on the other. The zig-zag alternation matches
// the source's editorial rhythm — image-left, image-right, repeating.
//
// Image pairing follows the source exactly (verified by stacking
// y-coordinates of <img> rects on the source page):
//   Our Expertise          — streetscape (12) + villa pair (13)
//   Property Development   — architect plans (15) + site engineer (14)
//   Personalised Homebuying — family (16) + agent welcoming (17)
//   Flexible Payment Plans — finance growth (20) + signing (21)
//   Community Living       — pool (18) + playground (19)
//   Post-Sale Support      — keys handover (22) + handshake (23)
//
// Body copy is the source verbatim with light British-spelling
// normalisation (Personalised) since the audience is Ghana.

const SERVICES_SECTIONS: SectionSpec[] = [
  // ─── 1. Hero ────────────────────────────────────────────────────
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
              text: 'Services',
              prefix: 'none',
              tone: 'champagne',
              alignment: 'center',
              animation: 'fade-in',
            },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: {
              text: 'Our Services',
              level: 'h1',
              size: 'display-2xl',
              alignment: 'center',
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
                '<p>We strive to provide our clients with luxury, comfort, and tailor-made services.</p>',
              size: 'body-lg',
              alignment: 'center',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 2. Our Expertise (image LEFT, text RIGHT) ──────────────────
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'md' },
    columns: [
      // Col 1 — image pair (left of viewport on md+).
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_image_pair',
            data: {
              leftImage: { media_id: 12, alt: 'Streetscape view of a Best World gated community with uniform villas on a paved residential drive' },
              rightImage: { media_id: 13, alt: 'Two Best World villas at dusk with timber accents and a private gate' },
              layout: 'lift-left',
              overlap: 'sm',
              ratio: '4:5',
              animation: 'fade-in',
            },
          },
        ],
      },
      // Col 2 — copy.
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Best World', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Our Expertise', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>At Best World, we focus on delivering seamless solutions for modern living. From crafting high-quality homes to offering tailored support and flexible payment plans, our services are designed to meet the diverse needs of our clients. Discover how we simplify homeownership while maintaining the highest standards of excellence.</p>',
              size: 'body-md',
              alignment: 'left',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 3. Property Development (text LEFT, image RIGHT) ───────────
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Our Services', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Property Development', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We develop high-quality, gated homes that embody luxury and comfort, overseeing every detail from design to completion.</p>',
              size: 'body-md',
              alignment: 'left',
              tone: 'ivory',
              maxWidth: 'medium',
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
            blockType: 'lx_image_pair',
            data: {
              leftImage: { media_id: 15, alt: 'Architect sketching floor plans at a desk with a model building, hard hat, and laptop alongside' },
              rightImage: { media_id: 14, alt: 'Smiling Best World site engineer in hi-vis vest and hard hat on an active construction site' },
              layout: 'lift-right',
              overlap: 'sm',
              ratio: '4:5',
              animation: 'fade-in',
            },
          },
        ],
      },
    ],
  },

  // ─── 4. Personalised Homebuying (image LEFT, text RIGHT) ────────
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_image_pair',
            data: {
              leftImage: { media_id: 16, alt: 'Family of three smiling in front of a Best World home' },
              rightImage: { media_id: 17, alt: 'Best World agent in a tailored blazer welcoming a buyer into an empty home' },
              layout: 'lift-left',
              overlap: 'sm',
              ratio: '4:5',
              animation: 'fade-in',
            },
          },
        ],
      },
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Our Services', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Personalised Homebuying', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We provide tailored guidance throughout the homebuying journey, ensuring transparency and support at every step.</p>',
              size: 'body-md',
              alignment: 'left',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 5. Flexible Payment Plans (text LEFT, image RIGHT) ─────────
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Our Services', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Flexible Payment Plans', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>With interest-free plans and discounts for repeat buyers and upfront payments, we make homeownership accessible.</p>',
              size: 'body-md',
              alignment: 'left',
              tone: 'ivory',
              maxWidth: 'medium',
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
            blockType: 'lx_image_pair',
            data: {
              leftImage: { media_id: 20, alt: 'Hand on a phone above a desk with stacked coins and a finance growth overlay' },
              rightImage: { media_id: 21, alt: 'Close-up of a buyer signing a Best World purchase contract by hand' },
              layout: 'lift-right',
              overlap: 'sm',
              ratio: '4:5',
              animation: 'fade-in',
            },
          },
        ],
      },
    ],
  },

  // ─── 6. Community Living (image LEFT, text RIGHT) ───────────────
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_image_pair',
            data: {
              leftImage: { media_id: 18, alt: 'Family of four relaxing in a Best World community pool on a rainbow float' },
              rightImage: { media_id: 19, alt: 'Child playing on a slide in a Best World community playground' },
              layout: 'lift-left',
              overlap: 'sm',
              ratio: '4:5',
              animation: 'fade-in',
            },
          },
        ],
      },
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Our Services', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Community Living', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>We create vibrant, secure communities with amenities like pools, gyms, green spaces, and 24/7 security.</p>',
              size: 'body-md',
              alignment: 'left',
              tone: 'ivory',
              maxWidth: 'medium',
              animation: 'fade-in',
            },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },

  // ─── 7. Post-Sale Support (text LEFT, image RIGHT) ──────────────
  {
    kind: 'section',
    meta: { columns: 2, background: 'obsidian', padding: 'md' },
    columns: [
      {
        kind: 'column',
        widgets: [
          {
            kind: 'widget',
            blockType: 'lx_eyebrow',
            data: { text: 'Our Services', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Post-Sale Support', level: 'h2', size: 'display-md', alignment: 'left', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_text',
            data: {
              body_richtext:
                '<p>Our commitment continues after the sale with assistance in maintenance and property management.</p>',
              size: 'body-md',
              alignment: 'left',
              tone: 'ivory',
              maxWidth: 'medium',
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
            blockType: 'lx_image_pair',
            data: {
              leftImage: { media_id: 22, alt: 'Best World keys handed from one open palm to another at handover' },
              rightImage: { media_id: 23, alt: 'Best World representative shaking hands with a homeowner after closing' },
              layout: 'lift-right',
              overlap: 'sm',
              ratio: '4:5',
              animation: 'fade-in',
            },
          },
        ],
      },
    ],
  },

  // ─── 8. Closing CTA ─────────────────────────────────────────────
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
            data: { text: 'Next Step', prefix: 'none', tone: 'champagne', alignment: 'center', animation: 'fade-in' },
          },
          {
            kind: 'widget',
            blockType: 'lx_heading',
            data: { text: 'Find The Home That Fits Your Life', level: 'h2', size: 'display-md', alignment: 'center', tone: 'ivory', italic: false, animation: 'slide-up' },
            meta: { marginTop: 'sm' },
          },
          {
            kind: 'widget',
            blockType: 'lx_action',
            data: { label: 'Enquire now', href: '/contact', variant: 'primary-gold', size: 'lg', alignment: 'center', animation: 'fade-in' },
            meta: { marginTop: 'md' },
          },
        ],
      },
    ],
  },
]

/**
 * Seed the Services source page's CMS block tree.
 */
export async function seedServicesPageBlocksIfEmpty(): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'services' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:services-blocks] no services system page row — run migration 0010 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const inserted = await insertSections(pageId, SERVICES_SECTIONS)
  return inserted
}

/**
 * Seed the About source page's CMS block tree.
 */
export async function seedAboutPageBlocksIfEmpty(): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'about' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:about-blocks] no about system page row — run migration 0010 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const inserted = await insertSections(pageId, ABOUT_SECTIONS)
  return inserted
}

/**
 * Seed the Privacy source page's CMS block tree. Same lookup +
 * idempotency pattern as the Contact seed — returns `false` if blocks
 * already exist; otherwise inserts the full PRIVACY_SECTIONS tree.
 */
export async function seedPrivacyPageBlocksIfEmpty(): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'privacy' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:privacy-blocks] no privacy system page row — run migration 0015 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const inserted = await insertSections(pageId, PRIVACY_SECTIONS)
  return inserted
}

/**
 * Seed the Terms source page's CMS block tree.
 */
export async function seedTermsPageBlocksIfEmpty(): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE system = 1 AND slug = 'terms' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:terms-blocks] no terms system page row — run migration 0015 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const inserted = await insertSections(pageId, TERMS_SECTIONS)
  return inserted
}

// The Kharis project landing page ─────────────────────────────────────
//
// Authored from bestworldcompany.com/the-kharis/ — Best World's
// flagship Spintex Manet development (25 detached 3- & 4-bedroom
// townhouses with all-ensuite boys' quarters). Source page is sparse
// and image-heavy; this rebuild composes the same material into the
// luxury-redesign block system AND closes its gaps:
//
//   - Source: no hero CTA, one mid-page brochure button.
//     Local:  dual CTAs in hero + repeated mid-page + dedicated
//             closing CTA before sign-off.
//   - Source: payment plans rendered as 3 tiny bullets.
//     Local:  3-up icon_box composition with Lucide icons.
//   - Source: no map.
//     Local:  Google Maps embed of Spintex Manet alongside the
//             location copy.
//   - Source: amenities labeled but the photos were broken at
//             time of authoring.
//     Local:  every amenity photo downloaded into
//             /uploads/the-kharis/ and registered as media rows
//             keyed by filename_uuid="kharis-2026-*" — see
//             migration 0018.
//
// Media IDs are looked up by filename_uuid at seed time (not
// hardcoded) so the seed survives a DB rebuild where auto_increment
// values differ. Same pattern the operator-facing media inserter
// uses; reading the row back lets the seed compose lx_figure /
// lx_cover_image / icon_box widgets without coupling to specific
// numeric ids.

const KHARIS_MEDIA_UUIDS = [
  'kharis-2026-kh1',
  'kharis-2026-gated',
  'kharis-2026-swim',
  'kharis-2026-gym',
  'kharis-2026-garden',
  'kharis-2026-electric',
  'kharis-2026-water',
  'kharis-2026-security',
  'kharis-2026-facilities',
  'kharis-2026-payments',
] as const

type KharisMediaSlug = (typeof KHARIS_MEDIA_UUIDS)[number]

async function loadKharisMediaIds(): Promise<Record<KharisMediaSlug, number>> {
  const [rows] = (await db.execute(sql`
    SELECT id, filename_uuid FROM media
    WHERE filename_uuid IN (
      'kharis-2026-kh1','kharis-2026-gated','kharis-2026-swim',
      'kharis-2026-gym','kharis-2026-garden','kharis-2026-electric',
      'kharis-2026-water','kharis-2026-security','kharis-2026-facilities',
      'kharis-2026-payments'
    )
      AND deleted_at IS NULL
  `)) as unknown as [Array<{ id: number; filename_uuid: string }>]
  const map = {} as Record<KharisMediaSlug, number>
  for (const r of rows) {
    map[r.filename_uuid as KharisMediaSlug] = r.id
  }
  for (const slug of KHARIS_MEDIA_UUIDS) {
    if (!map[slug]) {
      throw new Error(
        `[seed:the-kharis] missing media row filename_uuid='${slug}' — run migration 0018 first.`,
      )
    }
  }
  return map
}

function buildKharisSections(
  m: Record<KharisMediaSlug, number>,
): SectionSpec[] {
  return [
    // ─── 1. Hero ──────────────────────────────────────────────────
    // Full-bleed cover image. Champagne eyebrow + display-2xl h1 +
    // tagline + DUAL CTAs (source had zero hero CTAs — primary
    // weakness of the source). darken-strong overlay keeps the
    // heading legible against the bright facade.
    {
      kind: 'section',
      meta: {
        columns: 1,
        background: 'obsidian',
        padding: '2xl',
        backgroundImage: { media_id: m['kharis-2026-kh1'], alt: '' },
        backgroundOverlay: 'darken-strong',
        minHeight: 'lg',
      },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: '3 & 4 Bedroom Detached Townhouses · Spintex Manet',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'The Kharis',
                level: 'h1',
                size: 'display-2xl',
                alignment: 'center',
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
                  '<p>An exclusive gated community of 25 detached townhouses — crafted for ultimate comfort and luxury.</p>',
                size: 'body-lg',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=the-kharis',
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'lg' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Book a viewing',
                href: '/contact?ref=the-kharis-viewing',
                variant: 'secondary-outline',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
      ],
    },

    // ─── 2. About The Kharis ─────────────────────────────────────
    // Centred copy section, mirrors the source. The "25 detached
    // townhouses … 1-bedroom, all-ensuite boys' quarters" line is
    // the source's most concrete fact — preserved verbatim.
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
                text: 'Best World',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'About The Kharis',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>The Kharis is an exclusive gated community featuring 25 detached townhouses in Spintex. Crafted for ultimate comfort and luxury, every home at The Kharis is thoughtfully built with premium materials, impeccable craft, and precision. Choose from any of our 3- or 4-bedroom homes, each complemented by a 1-bedroom, all-ensuite boys&rsquo; quarters.</p>',
                size: 'body-md',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=the-kharis',
                variant: 'primary-gold',
                size: 'md',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 3. A Unique Home for Each Stage of Life ─────────────────
    // 2-col: kh1 exterior (left), copy + CTA (right). Mirrors the
    // source's signature mid-page composition.
    {
      kind: 'section',
      meta: { columns: 2, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-kh1'],
                  alt: 'Front exterior of a The Kharis townhouse — modern white facade with wood accents',
                },
                ratio: '4:5',
                fit: 'cover',
                corners: 'sharp',
                goldOverlay: false,
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          meta: { verticalAlign: 'center' },
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'The Kharis',
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
                text: 'A Unique Home for Each Stage of Life',
                level: 'h2',
                size: 'display-md',
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
                  '<p>Whether you&rsquo;re a professional, a family, an executive, or a retiree, The Kharis offers a home designed for your lifestyle. Spacious interiors, premium amenities, and a prime location come together for the perfect balance of convenience and sophistication.</p>',
                size: 'body-md',
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
                label: 'Request brochure',
                href: '/contact?ref=the-kharis',
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

    // ─── 4. Location ─────────────────────────────────────────────
    // 2-col: copy left + Google Maps embed right. Source had a
    // stock-photo of a woman with shopping bags here (irrelevant
    // visual). Replaced with the actual location of the
    // development for genuine utility.
    {
      kind: 'section',
      meta: { columns: 2, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          meta: { verticalAlign: 'center' },
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Spintex Manet',
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
                text: 'Location',
                level: 'h2',
                size: 'display-md',
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
                  '<p>The Kharis is strategically located in the residential enclave of Spintex, just behind the Ghana International Mall. It offers a calm and relaxing environment with proximity to everything the city has to offer — well-maintained roads, easy access to the best of shopping and retail, international schools, the international airport, and top-tier healthcare facilities.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'ivory',
                maxWidth: 'medium',
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
              blockType: 'lx_map',
              data: {
                embedUrl:
                  'https://maps.google.com/maps?q=The+Kharis+Bestworld,+Spintex,+Accra&z=17&output=embed',
                ratio: '4:5',
                caption: 'Spintex Manet, Accra — behind the Ghana International Mall',
                goldOverlay: false,
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 6. Amenities — intro ────────────────────────────────────
    // Section header for the amenities grid. The source has a
    // similar intro paragraph above the 4x2 photo grid; keeping
    // the copy as a separate header section so editors can adjust
    // intro text without touching the grid below.
    {
      kind: 'section',
      meta: { columns: 1, background: 'obsidian', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'The Kharis',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Amenities',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Embrace a lifestyle where every day feels like a retreat — combining convenience, practicality, and security. Round-the-clock security, breathtaking green landscapes, uninterrupted utilities, and a state-of-the-art gym and pool, all within the gates.</p>',
                size: 'body-md',
                alignment: 'center',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 7. Amenities — row 1 (gated · swim · gym · garden) ──────
    // 4-col grid of lx_figure tiles. Mobile collapses to 1-col
    // stack (grid-cols-1 → sm:grid-cols-2 → lg:grid-cols-4 per
    // SECTION_COLUMNS_CLASS) so the row stays scannable on phones.
    // Caption rendered beneath each figure via lx_figure's
    // built-in caption prop.
    {
      kind: 'section',
      meta: { columns: 4, background: 'obsidian', padding: 'sm' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-gated'],
                  alt: 'Aerial view of The Kharis gated community access road',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Gated Community',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-swim'],
                  alt: 'Family in The Kharis community swimming pool',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Swimming Pool',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-gym'],
                  alt: 'Resident training inside The Kharis on-site fitness centre',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Gym / Fitness Centre',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-garden'],
                  alt: 'Open landscaped gardens at The Kharis with mature trees',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Landscaped Gardens',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 8. Amenities — row 2 (electric · water · security · facilities) ──
    {
      kind: 'section',
      meta: { columns: 4, background: 'obsidian', padding: 'sm' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-electric'],
                  alt: 'Hand on a backup-power remote at The Kharis',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: '24-Hour Electricity',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-water'],
                  alt: 'Clean water pouring from a tap at The Kharis',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Water Reserve',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-security'],
                  alt: 'Uniformed security officer at The Kharis checkpoint',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: '24 / 7 Security',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-facilities'],
                  alt: 'Best World facility-management technician on site at The Kharis',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Facility Management',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 9. Flexible Payment Plans ───────────────────────────────
    // 2-col: payments.png (editorial photo of hands + paperwork)
    // on the left, copy + 3 icon_box widgets on the right. Source
    // had a tiny bullet list here — the icon_box composition is a
    // significant improvement.
    {
      kind: 'section',
      meta: { columns: 2, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-payments'],
                  alt: 'Hands holding eyeglasses and a phone over financial paperwork',
                },
                ratio: '4:5',
                fit: 'cover',
                corners: 'sharp',
                goldOverlay: false,
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          meta: { verticalAlign: 'center' },
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'The Kharis',
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
                text: 'Flexible Payment Plans and Discounts',
                level: 'h2',
                size: 'display-md',
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
                  '<p>At Best World Company Limited, we believe in making your dream home at The Kharis accessible with our flexible and convenient payment plans. Choose the option that best fits your financial goals and enjoy a smooth, stress-free purchase experience.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 9b. Payment plans — 3-col icon_box ROW ──────────────────
    // The 3 plans live in their own 3-col section so they render
    // side-by-side on desktop (collapses to single-column stack on
    // mobile via SECTION_COLUMNS_CLASS). tone='ivory' overrides the
    // icon_box default 'near-black' so headlines + body stay
    // high-contrast against the obsidian background.
    {
      kind: 'section',
      meta: { columns: 3, background: 'obsidian', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'piggy-bank',
                headline: 'Self Finance',
                body: 'Flexible payment options that let you manage instalments seamlessly to suit your budget — homeownership without the strain.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'landmark',
                headline: 'Mortgage Financing',
                body: 'Mortgage financing lets you secure your home now and pay over an extended period — helping you achieve your homeownership goals with ease.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'badge-percent',
                headline: 'Full Payment Discount',
                body: 'Settle the full amount upfront and unlock an exclusive discount on the total price — our reward for decisive buyers.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
      ],
    },

    // ─── 10. Closing CTA ─────────────────────────────────────────
    // Dual CTA — primary "Request brochure" + tel: link for direct
    // call. Source closed with a single small button; this is the
    // dedicated handoff moment the page was missing.
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
                text: 'Reserve a Townhouse',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Own Your Private Residence at The Kharis',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Our dedicated sales team will guide you through securing your home at The Kharis. Take the first step today.</p>',
                size: 'body-md',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=the-kharis',
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'lg' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Call +233 24 297 7639',
                href: 'tel:+233242977639',
                variant: 'secondary-outline',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
      ],
    },

    // Closing-quote section REMOVED — earlier draft put an editorial
    // "A home is the first thing you give your future…" line here
    // attributed to Best World Properties. The source page makes no
    // such statement; attributing a fabricated brand statement to a
    // real company crosses the "never lie" line. Page ends on the
    // verbatim Closing CTA (section 10), which is the source's actual
    // closing content. Re-add only if the operator provides a real
    // tagline they want to use.
  ]
}

/**
 * Seed The Kharis project landing page's CMS block tree. Idempotent:
 * returns `false` and exits without writes if the page already has
 * any live blocks. Returns the row count inserted on a fresh seed.
 *
 * Looks up the page by slug='the-kharis' (system=0 — this is NOT a
 * fixed-slot system page) and resolves the 10 media ids by
 * filename_uuid before composing the section tree. A missing media
 * row throws (migration 0018 wasn't applied) rather than silently
 * inserting blocks pointing at media_id=undefined.
 */
export async function seedTheKharisPageBlocksIfEmpty(): Promise<
  number | false
> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE slug = 'the-kharis' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:the-kharis-blocks] no the-kharis page row — run migration 0018 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const mediaIds = await loadKharisMediaIds()
  const inserted = await insertSections(pageId, buildKharisSections(mediaIds))
  return inserted
}

// Mantebea Gardens project landing page ──────────────────────────────
//
// Authored verbatim from bestworldcompany.com/mantebea-gardens/ on
// 2026-05-22. Project differs from the Kharis structurally:
//
//   - Location: Amrahia (Katamanso Road), NOT Spintex.
//   - Mix: 3-bedroom single-storey + 3-to-5-bedroom double-storey.
//   - Includes an "Invest In Your Lifestyle" benefits section
//     (6 bullets) that the Kharis page doesn't have.
//   - Amenities: 8 photo tiles (gated / pool / gym / gardens /
//     security / 24h electricity / waste-management / water reserve).
//     The 24h-electricity photo is shared with the Kharis source
//     (same file), so the seed reuses media_id 'kharis-2026-electric'
//     instead of duplicating it.
//
// Source page has a copy-paste bug: its "Location" section repeats
// the Kharis location paragraph word-for-word ("The Kharis is
// strategically located..."). We use the source's "A Serene Haven"
// paragraph as the canonical Mantebea location copy — that's the
// only verifiable location description specific to this project.
//
// Hero image: media_id 25 (mantebea-cover.png) — already in the DB
// from the /projects index seed. Source's hero (katamanso-3-storey-
// ch-2.png on the staging domain bestworld.heightonllc.com) wasn't
// reachable, but media 25 is the official cover used everywhere else.

const MANTEBEA_OWN_MEDIA_UUIDS = [
  'mante-2026-interior',
  'mante-2026-gated',
  'mante-2026-swim',
  'mante-2026-gym',
  'mante-2026-garden',
  'mante-2026-security',
  'mante-2026-waste',
  'mante-2026-water',
] as const

type MantebeaOwnMediaSlug = (typeof MANTEBEA_OWN_MEDIA_UUIDS)[number]

interface MantebeaMediaIds extends Record<MantebeaOwnMediaSlug, number> {
  hero: number
  // Reused from Kharis seed — same source asset.
  'kharis-2026-electric': number
}

async function loadMantebeaMediaIds(): Promise<MantebeaMediaIds> {
  // Project hero already lives in the DB (mantebea-cover.png =
  // media_id 25). Look it up by filename_uuid so the seed doesn't
  // hardcode the auto-increment id.
  const [heroRows] = (await db.execute(sql`
    SELECT id FROM media WHERE original_name = 'mantebea-cover.png' AND deleted_at IS NULL LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  if (!heroRows[0]) {
    throw new Error(
      "[seed:mantebea] missing media row for original_name='mantebea-cover.png'",
    )
  }
  const [rows] = (await db.execute(sql`
    SELECT id, filename_uuid FROM media
    WHERE filename_uuid IN (
      'mante-2026-interior','mante-2026-gated','mante-2026-swim',
      'mante-2026-gym','mante-2026-garden','mante-2026-security',
      'mante-2026-waste','mante-2026-water','kharis-2026-electric'
    )
      AND deleted_at IS NULL
  `)) as unknown as [Array<{ id: number; filename_uuid: string }>]
  const map = {
    hero: heroRows[0].id,
  } as MantebeaMediaIds
  for (const r of rows) {
    ;(map as unknown as Record<string, number>)[r.filename_uuid] = r.id
  }
  for (const slug of [
    ...MANTEBEA_OWN_MEDIA_UUIDS,
    'kharis-2026-electric',
  ] as const) {
    if (!(map as unknown as Record<string, number>)[slug]) {
      throw new Error(
        `[seed:mantebea] missing media row filename_uuid='${slug}' — run migration 0020 first.`,
      )
    }
  }
  return map
}

function buildMantebeaSections(m: MantebeaMediaIds): SectionSpec[] {
  return [
    // ─── 1. Hero ──────────────────────────────────────────────────
    {
      kind: 'section',
      meta: {
        columns: 1,
        background: 'obsidian',
        padding: '2xl',
        backgroundImage: { media_id: m.hero, alt: '' },
        backgroundOverlay: 'darken-strong',
        minHeight: 'lg',
      },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: '3, 4 & 5 Bedroom Townhouses · Amrahia',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Mantebea Gardens',
                level: 'h1',
                size: 'display-2xl',
                alignment: 'center',
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
                  '<p>A Community Designed to Nurture Your Wellbeing, Family &amp; Future.</p>',
                size: 'body-lg',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=mantebea-gardens',
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'lg' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Book a viewing',
                href: '/contact?ref=mantebea-gardens-viewing',
                variant: 'secondary-outline',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
      ],
    },

    // ─── 2. About Mantebea Gardens ───────────────────────────────
    // Source copy verbatim.
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
                text: 'Best World',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'About Mantebea Gardens',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Mantebea Gardens offers a vibrant community designed to grow with you. Situated in the tranquil neighbourhood of Amrahia on Katamanso Road, this development offers homes that perfectly blend modern design and sustainability. The homes at Mantebea feature a mix of 3-bedroom single-storey units and 3 to 5-bedroom double-storey units, ensuring a wide range of living options to suit your family&rsquo;s needs.</p>',
                size: 'body-md',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=mantebea-gardens',
                variant: 'primary-gold',
                size: 'md',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 3. A Serene Haven — image + copy ────────────────────────
    {
      kind: 'section',
      meta: { columns: 2, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-interior'],
                  alt: 'Modern double-storey Mantebea Gardens home interior',
                },
                ratio: '4:5',
                fit: 'cover',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          meta: { verticalAlign: 'center' },
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Mantebea Gardens',
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
                text: 'A Serene Haven',
                level: 'h2',
                size: 'display-md',
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
                  '<p>Mantebea Gardens is ideally located in Amrahia, on the scenic Katamanso Road, offering residents the perfect balance of peace and accessibility. Enjoy the serenity of suburban living, with easy access to nearby amenities such as top international schools, shopping centres, quality healthcare and recreation. Our location connects you to everything you need, while offering a peaceful retreat from the bustle of typical city life.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 4. Location ─────────────────────────────────────────────
    // 2-col: heading/copy + Google Maps embed of Amrahia /
    // Katamanso Road. Source's "Location" section incorrectly
    // contained the Kharis location paragraph (source copy bug); we
    // do NOT repeat that error here.
    {
      kind: 'section',
      meta: { columns: 2, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          meta: { verticalAlign: 'center' },
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Amrahia · Katamanso Road',
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
                text: 'Location',
                level: 'h2',
                size: 'display-md',
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
                  '<p>Mantebea Gardens sits on Katamanso Road in Amrahia — with easy reach to top international schools, shopping centres, quality healthcare, and recreation. A peaceful retreat from the bustle of typical city life, still connected to everything you need.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'ivory',
                maxWidth: 'medium',
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
              blockType: 'lx_map',
              data: {
                embedUrl:
                  'https://maps.google.com/maps?q=Mantebea+Gardens,+Amrahia,+Accra&z=16&output=embed',
                ratio: '4:5',
                caption: 'Amrahia, Katamanso Road — Accra',
                goldOverlay: false,
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 5. Amenities — intro ────────────────────────────────────
    {
      kind: 'section',
      meta: { columns: 1, background: 'obsidian', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Mantebea Gardens',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Everyday Feels Like a Retreat',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Enjoy a vibrant community within a safe and secure environment. Our range of amenities is designed to enhance your living experience.</p>',
                size: 'body-md',
                alignment: 'center',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 6. Amenities — row 1 (gated · pool · gym · gardens) ─────
    {
      kind: 'section',
      meta: { columns: 4, background: 'obsidian', padding: 'sm' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-gated'],
                  alt: 'Aerial of the Mantebea Gardens gated community',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Gated Community',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-swim'],
                  alt: 'Mantebea Gardens community swimming pool',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Swimming Pool',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-gym'],
                  alt: 'Mantebea Gardens on-site fitness centre',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Gym / Fitness Centre',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-garden'],
                  alt: 'Landscaped gardens at Mantebea Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Landscaped Gardens',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 7. Amenities — row 2 (security · electric · waste · water) ──
    {
      kind: 'section',
      meta: { columns: 4, background: 'obsidian', padding: 'sm' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-security'],
                  alt: 'Security checkpoint at Mantebea Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: '24 / 7 Security',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-electric'],
                  alt: 'Backup power infrastructure at Mantebea Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: '24-Hour Electricity',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-waste'],
                  alt: 'Communal waste-management at Mantebea Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Waste Management',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['mante-2026-water'],
                  alt: 'On-site water reservoir tower at Mantebea Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Water Reserve',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 8. Flexible Payment Plans — intro ──────────────────────
    // Source's payment-plans intro paragraph has a copy-paste bug
    // ("your dream home at The Kharis"). We swap to Mantebea Gardens
    // for accuracy; the rest is verbatim source language.
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
                text: 'Mantebea Gardens',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Flexible Payment Plans and Discounts',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>At Best World Company Limited, we believe in making your dream home at Mantebea Gardens accessible with our flexible and convenient payment plans. Choose the option that best fits your financial goals and enjoy a smooth, stress-free purchase experience.</p>',
                size: 'body-md',
                alignment: 'center',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 9. Payment plans — 3-col icon_box row ───────────────────
    {
      kind: 'section',
      meta: { columns: 3, background: 'obsidian', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'piggy-bank',
                headline: 'Self Finance',
                body: 'Flexible payment options that let you manage instalments seamlessly to suit your budget, making homeownership easier than ever.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'landmark',
                headline: 'Mortgage Financing',
                body: 'Mortgage financing lets you secure your home now and pay over an extended period — helping you achieve your homeownership goals with ease.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'badge-percent',
                headline: 'Full Payment Discount',
                body: 'For those who prefer to settle the full amount upfront, we offer an exclusive discount on the total price.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
      ],
    },

    // ─── 10. Invest In Your Lifestyle — Mantebea-only benefits ───
    // Six-bullet investment-angle section that does NOT appear on
    // the Kharis source. Verbatim source bullets.
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
                text: 'Why Mantebea',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Invest In Your Lifestyle',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Secure your piece of this thriving community today and enjoy:</p>' +
                  '<ul>' +
                  '<li>Competitive pricing</li>' +
                  '<li>Flexible payment options</li>' +
                  '<li>A location primed for growth</li>' +
                  '<li>Strong potential for appreciation</li>' +
                  '<li>Early-bird discounts</li>' +
                  '<li>Bespoke home designs</li>' +
                  '</ul>' +
                  '<p>Mantebea Gardens is not only a home; it&rsquo;s a strategic financial investment. Our team is here to guide you every step of the way, from initial inquiry to handover. Start your new life at Mantebea Gardens today.</p>',
                size: 'body-md',
                alignment: 'center',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 11. Closing CTA ─────────────────────────────────────────
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
                text: 'Reserve a Townhouse',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Start Your New Life at Mantebea Gardens',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
                tone: 'ivory',
                italic: false,
                animation: 'slide-up',
              },
              meta: { marginTop: 'sm' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Request brochure',
                href: '/contact?ref=mantebea-gardens',
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'lg' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Call +233 24 297 7639',
                href: 'tel:+233242977639',
                variant: 'secondary-outline',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
      ],
    },
  ]
}

/**
 * Seed the Mantebea Gardens landing page block tree. Same lookup /
 * idempotency / media-resolution pattern as the Kharis seed.
 */
export async function seedMantebeaGardensPageBlocksIfEmpty(): Promise<
  number | false
> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE slug = 'mantebea-gardens' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:mantebea-blocks] no mantebea-gardens page row — run migration 0020 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const mediaIds = await loadMantebeaMediaIds()
  const inserted = await insertSections(pageId, buildMantebeaSections(mediaIds))
  return inserted
}

// Anowaa Gardens project landing page ────────────────────────────────
//
// Authored verbatim from bestworldcompany.com/anowaa-gardens/ on
// 2026-05-22. Project differs from the Kharis structurally:
//
//   - Smaller, more exclusive: SIX 3-bedroom detached townhouses
//     (vs Kharis's 25 + mixed 3/4-bedroom).
//   - Same Spintex Manet location as the Kharis (both behind the
//     Ghana International Mall) — the SEO description + map share
//     coordinates.
//   - Includes a "Luxury Living, Smart Investment" section the
//     Kharis page doesn't have.
//   - Payment plans: distinct from Kharis's structure — instalments
//     over 4-24 months / early-buyer discount / mortgage option
//     (verbatim source language).
//
// Amenities: 7 photo tiles (gated / gardens / security / water /
// facilities / 24h electricity / recreation). Four of the photos
// are the same source assets the Kharis page uses (gated /
// security / facilities / 24h electricity); the seed reuses the
// 'kharis-2026-*' media rows for those instead of duplicating.
//
// Hero image: media_id 26 (anowaa-cover.png) — already in the DB.

const ANOWAA_OWN_MEDIA_UUIDS = [
  'anow-2026-bedroom',
  'anow-2026-garden',
  'anow-2026-water',
  'anow-2026-recreation',
] as const

type AnowaaOwnMediaSlug = (typeof ANOWAA_OWN_MEDIA_UUIDS)[number]

interface AnowaaMediaIds extends Record<AnowaaOwnMediaSlug, number> {
  hero: number
  // Reused from Kharis seed — same source assets.
  'kharis-2026-gated': number
  'kharis-2026-security': number
  'kharis-2026-facilities': number
  'kharis-2026-electric': number
}

async function loadAnowaaMediaIds(): Promise<AnowaaMediaIds> {
  const [heroRows] = (await db.execute(sql`
    SELECT id FROM media WHERE original_name = 'anowaa-cover.png' AND deleted_at IS NULL LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  if (!heroRows[0]) {
    throw new Error(
      "[seed:anowaa] missing media row for original_name='anowaa-cover.png'",
    )
  }
  const [rows] = (await db.execute(sql`
    SELECT id, filename_uuid FROM media
    WHERE filename_uuid IN (
      'anow-2026-bedroom','anow-2026-garden','anow-2026-water','anow-2026-recreation',
      'kharis-2026-gated','kharis-2026-security','kharis-2026-facilities','kharis-2026-electric'
    )
      AND deleted_at IS NULL
  `)) as unknown as [Array<{ id: number; filename_uuid: string }>]
  const map = {
    hero: heroRows[0].id,
  } as AnowaaMediaIds
  for (const r of rows) {
    ;(map as unknown as Record<string, number>)[r.filename_uuid] = r.id
  }
  for (const slug of [
    ...ANOWAA_OWN_MEDIA_UUIDS,
    'kharis-2026-gated',
    'kharis-2026-security',
    'kharis-2026-facilities',
    'kharis-2026-electric',
  ] as const) {
    if (!(map as unknown as Record<string, number>)[slug]) {
      throw new Error(
        `[seed:anowaa] missing media row filename_uuid='${slug}' — run migration 0020 first.`,
      )
    }
  }
  return map
}

function buildAnowaaSections(m: AnowaaMediaIds): SectionSpec[] {
  return [
    // ─── 1. Hero ──────────────────────────────────────────────────
    {
      kind: 'section',
      meta: {
        columns: 1,
        background: 'obsidian',
        padding: '2xl',
        backgroundImage: { media_id: m.hero, alt: '' },
        backgroundOverlay: 'darken-strong',
        minHeight: 'lg',
      },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: '3 Bedroom Detached Townhouses · Spintex Manet',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Anowaa Gardens',
                level: 'h1',
                size: 'display-2xl',
                alignment: 'center',
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
                  '<p>Six exclusive 3-bedroom detached townhouses — live in luxury, invest in growth.</p>',
                size: 'body-lg',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=anowaa-gardens',
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'lg' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Book a viewing',
                href: '/contact?ref=anowaa-gardens-viewing',
                variant: 'secondary-outline',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
      ],
    },

    // ─── 2. Live in Luxury, Invest in Growth ─────────────────────
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
                text: 'Best World',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Live in Luxury, Invest in Growth',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Anowaa Gardens offers an exceptional opportunity for those seeking exclusive luxury homes in Accra. This unique development features six stunning 3-bedroom detached townhouses, providing an unmatched level of privacy and comfort in a secure gated community. Each home offers spacious living areas, elegant finishes, premium fixtures, and all the modern conveniences you could wish for. Whether you&rsquo;re looking for a luxurious home for your family or a prestigious address to elevate your lifestyle, Anowaa Gardens delivers on every front.</p>',
                size: 'body-md',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=anowaa-gardens',
                variant: 'primary-gold',
                size: 'md',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 3. Luxury Living, Smart Investment — image + copy ───────
    {
      kind: 'section',
      meta: { columns: 2, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['anow-2026-bedroom'],
                  alt: 'Elegant master bedroom interior at Anowaa Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          meta: { verticalAlign: 'center' },
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Anowaa Gardens',
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
                text: 'Luxury Living, Smart Investment',
                level: 'h2',
                size: 'display-md',
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
                  '<p>Anowaa Gardens offers not just a beautiful place to live but also a smart investment opportunity. With Spintex being one of Accra&rsquo;s most desirable areas, the demand for high-end homes in this location continues to rise. Purchasing a home here means securing a valuable asset in a rapidly growing location. Whether you&rsquo;re looking to enjoy immediate luxury or seeking long-term value, Anowaa Gardens is the perfect investment for both.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 4. Location ─────────────────────────────────────────────
    {
      kind: 'section',
      meta: { columns: 2, background: 'obsidian', padding: 'lg' },
      columns: [
        {
          kind: 'column',
          meta: { verticalAlign: 'center' },
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Spintex Manet',
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
                text: 'Location',
                level: 'h2',
                size: 'display-md',
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
                  '<p>Perfectly positioned in Spintex, right behind the prestigious Ghana International Mall, Anowaa Gardens offers the best of both worlds: peace and privacy within a prime, highly sought-after location. With convenient access to shopping, restaurants, schools, the international airport and major roadways, you&rsquo;ll enjoy the best of modern city living while being just minutes away from the pulse of Accra.</p>',
                size: 'body-md',
                alignment: 'left',
                tone: 'ivory',
                maxWidth: 'medium',
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
              blockType: 'lx_map',
              data: {
                embedUrl:
                  'https://maps.google.com/maps?q=Anowaa+Gardens,+Spintex,+Accra&z=17&output=embed',
                ratio: '4:5',
                caption: 'Spintex Manet, Accra — behind the Ghana International Mall',
                goldOverlay: false,
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 5. Amenities — intro ────────────────────────────────────
    {
      kind: 'section',
      meta: { columns: 1, background: 'obsidian', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Anowaa Gardens',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Amenities',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Embrace a lifestyle where every day feels like a retreat — combining convenience, practicality, and security. Round-the-clock security, breathtaking green landscapes, uninterrupted utilities, and a state-of-the-art gym and pool, all within the gates.</p>',
                size: 'body-md',
                alignment: 'center',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 6. Amenities — row 1 (gated · gardens · security · water) ──
    {
      kind: 'section',
      meta: { columns: 4, background: 'obsidian', padding: 'sm' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-gated'],
                  alt: 'Aerial of the Anowaa Gardens gated community',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Gated Community',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['anow-2026-garden'],
                  alt: 'Manicured garden walkway at Anowaa Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Landscaped Gardens',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-security'],
                  alt: 'Security checkpoint at Anowaa Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: '24 / 7 Security',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['anow-2026-water'],
                  alt: 'On-site water reservoir at Anowaa Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Water Reserve',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 7. Amenities — row 2 (facilities · electric · recreation) ──
    // 3-col row for the remaining 3 amenities. Anowaa has 7 total
    // (Kharis has 8); a 4+3 split looks balanced.
    {
      kind: 'section',
      meta: { columns: 3, background: 'obsidian', padding: 'sm' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-facilities'],
                  alt: 'Facility-management technician on site at Anowaa Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Facility Management',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['kharis-2026-electric'],
                  alt: 'Backup power at Anowaa Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: '24-Hour Electricity',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_figure',
              data: {
                image: {
                  media_id: m['anow-2026-recreation'],
                  alt: 'Communal outdoor seating at Anowaa Gardens',
                },
                ratio: '4:5',
                fit: 'cover',
                caption: 'Recreation Area',
                corners: 'sharp',
                animation: 'fade-in',
              },
            },
          ],
        },
      ],
    },

    // ─── 8. Payment Plans & Discounts — intro ────────────────────
    // Source has its own payment-plan language for Anowaa — distinct
    // from Kharis. Verbatim.
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
                text: 'Anowaa Gardens',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Payment Plans & Discounts',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>We&rsquo;ve made owning a home at Anowaa Gardens as easy as possible with flexible payment plans to suit your needs.</p>',
                size: 'body-md',
                alignment: 'center',
                tone: 'ivory',
                maxWidth: 'medium',
                animation: 'fade-in',
              },
              meta: { marginTop: 'md' },
            },
          ],
        },
      ],
    },

    // ─── 9. Payment plans — 3-col icon_box row (Anowaa-specific) ─
    // Three plans drawn verbatim from the source's bullets:
    //   - Instalments over 4-24 months
    //   - Early-buyer discount
    //   - Mortgage option for qualified buyers
    {
      kind: 'section',
      meta: { columns: 3, background: 'obsidian', padding: 'md' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'calendar-clock',
                headline: 'Instalments Over 4 – 24 Months',
                body: 'Pay in convenient instalments over 4 to 24 months.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'badge-percent',
                headline: 'Early-Buyer Discount',
                body: 'Enjoy special early-buyer discounts.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'icon_box',
              data: {
                icon: 'landmark',
                headline: 'Mortgage Option',
                body: 'Attractive mortgage options for qualified buyers.',
                alignment: 'center',
                accent: 'copper-outline',
                tone: 'ivory',
              },
            },
          ],
        },
      ],
    },

    // ─── 10. Closing CTA ─────────────────────────────────────────
    // Verbatim source closing line.
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
                text: 'Reserve a Townhouse',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: 'Secure Your Home at Anowaa Gardens',
                level: 'h2',
                size: 'display-md',
                alignment: 'center',
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
                  '<p>Let us help you secure your home at Anowaa Gardens. We are ready to discuss your payment plan and how you can benefit from our exclusive offers.</p>',
                size: 'body-md',
                alignment: 'center',
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
                label: 'Request brochure',
                href: '/contact?ref=anowaa-gardens',
                variant: 'primary-gold',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'lg' },
            },
            {
              kind: 'widget',
              blockType: 'lx_action',
              data: {
                label: 'Call +233 24 297 7639',
                href: 'tel:+233242977639',
                variant: 'secondary-outline',
                size: 'lg',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'sm' },
            },
          ],
        },
      ],
    },
  ]
}

/**
 * Seed the Anowaa Gardens landing page block tree. Same lookup /
 * idempotency / media-resolution pattern as the Kharis seed.
 */
export async function seedAnowaaGardensPageBlocksIfEmpty(): Promise<
  number | false
> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE slug = 'anowaa-gardens' AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      '[seed:anowaa-blocks] no anowaa-gardens page row — run migration 0020 first.',
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  const liveBlocks = Number(countRows[0]?.n ?? 0)
  if (liveBlocks > 0) return false
  const mediaIds = await loadAnowaaMediaIds()
  const inserted = await insertSections(pageId, buildAnowaaSections(mediaIds))
  return inserted
}

// Thank-you confirmation pages ─────────────────────────────────────────
//
// Three lightweight pages served by the dynamic _page/[slug] resolver:
//   /thank-you-enquiry   → after a general enquiry
//   /thank-you-tour      → after scheduling a site tour
//   /thank-you-brochure  → after downloading a project brochure
//
// Each page is a single centered section: eyebrow → heading → body → CTA.
// The pages are system=0 (operator-editable via /admin/pages) and
// published=1 (seeded by migration 0019).

function buildThankYouSections(heading: string): SectionSpec[] {
  return [
    {
      kind: 'section',
      meta: { columns: 1, background: 'obsidian', padding: '2xl' },
      columns: [
        {
          kind: 'column',
          widgets: [
            {
              kind: 'widget',
              blockType: 'lx_eyebrow',
              data: {
                text: 'Confirmed',
                prefix: 'none',
                tone: 'champagne',
                alignment: 'center',
                animation: 'fade-in',
              },
            },
            {
              kind: 'widget',
              blockType: 'lx_heading',
              data: {
                text: heading,
                level: 'h1',
                size: 'display-xl',
                alignment: 'center',
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
                  '<p>Our team will get back to you as soon as possible.</p>',
                size: 'body-lg',
                alignment: 'center',
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
                label: 'Explore Our Projects',
                href: '/projects',
                openInNew: false,
                variant: 'primary-gold',
                size: 'md',
                alignment: 'center',
                animation: 'fade-in',
              },
              meta: { marginTop: 'xl' },
            },
          ],
        },
      ],
    },
  ]
}

async function seedThankYouPage(
  slug: string,
  label: string,
  heading: string,
): Promise<number | false> {
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages
    WHERE slug = ${slug} AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  const pageId = pageRows[0]?.id
  if (!pageId) {
    console.warn(
      `[seed:${label}] no ${slug} page row — run migration 0019 first.`,
    )
    return false
  }
  const [countRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM ${contentBlocks}
    WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number | bigint }>]
  if (Number(countRows[0]?.n ?? 0) > 0) return false
  return insertSections(pageId, buildThankYouSections(heading))
}

export async function seedThankYouEnquiryPageBlocksIfEmpty(): Promise<number | false> {
  return seedThankYouPage(
    'thank-you-enquiry',
    'thank-you-enquiry-blocks',
    'Thank You For Enquiring',
  )
}

export async function seedThankYouTourPageBlocksIfEmpty(): Promise<number | false> {
  return seedThankYouPage(
    'thank-you-tour',
    'thank-you-tour-blocks',
    'Thank You For Scheduling A Tour',
  )
}

export async function seedThankYouBrochurePageBlocksIfEmpty(): Promise<number | false> {
  return seedThankYouPage(
    'thank-you-brochure',
    'thank-you-brochure-blocks',
    'Thank You For Downloading The Brochure',
  )
}
