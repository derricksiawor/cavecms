import 'server-only'
import { z } from 'zod'
import { env } from '@/lib/env'
import { RESERVED } from '@/lib/cms/page-slug'
import { parseCidr } from '@/lib/security/ipMatch'
import { MOBILE_CTA_ICONS } from '@/lib/cms/mobileCtaIcons'
import { AI_MODEL_IDS } from '@/lib/cms/aiModelIds'
import { encryptedSecretSchema } from '@/lib/security/secretCipher'
import { HEX_COLOR_RE } from '@/lib/cms/designTokens'
import { isFontKeySlug, TYPOGRAPHY_ROLES_DEFAULT } from '@/lib/typography/catalog'
import { CUSTOM_FONT_KEY_RE, CUSTOM_FONT_FILE_RE } from '@/lib/typography/customFonts'
import { GOOGLE_FONT_KEY_RE, GOOGLE_FONT_FILE_RE } from '@/lib/typography/googleFontKeys'

// One Zod schema per `settings.key`. getSetting() parses every value
// through this registry on read — so a tampered DB cell or a
// pre-migration default that no longer fits the current shape fails
// closed instead of crashing the renderer. Each entry has a `default`
// used when the row is missing — the admin Settings page synthesizes
// a `{version:0, value: default}` row for every registry key not yet
// in the DB, and the PATCH route's first-save path INSERTs it.

// Restrictive URL validator. Plain z.string().url() accepts
// javascript:, data:, file:, vbscript: schemes — any of which become
// stored-XSS when rendered into href / src / JSON-LD url fields.
// Every URL we accept from settings must be http(s).
const HttpsUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), 'must_be_http_or_https')

// Universal site link. Accepts anything an operator might reasonably
// type into a "link to…" field on header / footer:
//
//   - Full URL with explicit scheme: https://… or http://…
//   - Same-origin path: starts with /, next char is NOT / (the
//     non-/ guard blocks protocol-relative `//evil.com` injection)
//   - On-page anchor: starts with # followed by ≥ 1 char
//   - mailto:foo@bar.tld
//   - tel:+15551234567 (digits, plus, dashes, spaces, parens)
//   - Empty string — operators "remove" a CTA by clearing both
//     fields; the public renderer hides any CTA whose text is empty.
//
// EVERYTHING that doesn't match (javascript:, data:, file:, vbscript:,
// //schema-relative URLs) is rejected. The check lives once here and
// every href field in header/footer/columns/legal links reuses it so
// the rule never drifts.
const siteLink = z
  .string()
  .max(500)
  .refine((u) => {
    if (u === '') return true
    if (/^https?:\/\//i.test(u)) return true
    // Same-origin: bare `/` OR `/` followed by a non-`/` (rejects
    // protocol-relative `//evil.com` injection).
    if (/^\/(?!\/)/.test(u)) return true
    // Anchors: `#` followed by ≥1 non-whitespace character. Rejects
    // bare `#`, `# `, etc. — those scroll-to-top and look like a bug.
    if (/^#\S+$/.test(u)) return true
    if (/^mailto:.+@.+/i.test(u)) return true
    if (/^tel:[+\d\s\-()]+$/i.test(u)) return true
    return false
  }, 'must_be_valid_link')

const contactInfo = z.object({
  // Phone allows digits, +, spaces, dashes, parens, and dots — the
  // same character class accepted by the tel: branch of siteLink. The
  // footer + Contact page both build `tel:${phone}` hrefs from this
  // value; constraining the schema here means a malformed phone can
  // never reach the renderer.
  phone: z.string().max(40).regex(/^[+\d\s\-().]*$/, 'invalid_phone'),
  email: z.string().email().max(180),
  address: z.string().max(280),
  hours: z.string().max(120),
})

const socialLinks = z
  .array(
    z.object({
      platform: z.string().max(40),
      url: HttpsUrl,
    }),
  )
  .max(20)

const defaultSeo = z.object({
  title: z.string().max(180),
  description: z.string().max(320),
  // Operator-picked default social-share (Open Graph) image — the
  // preview card shown when the site is shared on social platforms.
  // Stored as a media reference like the favicon / header logo; the
  // SEO resolver (lib/seo/resolve.ts) turns it into an ABSOLUTE url
  // using the configured site URL. Inline media shape (not the shared
  // `mediaRef`) for the same temporal-dead-zone reason as `favicon`
  // below — `mediaRef` is declared after `defaultSeo` in this module.
  ogImage: z
    .object({
      media_id: z.number().int().positive(),
      alt: z.string().max(180),
    })
    .nullable()
    .optional(),
  // LEGACY free-text OG image URL/path. Superseded by `ogImage` (the
  // Media-library picker) — no longer surfaced in the admin form, but
  // still read as a fallback so an install that configured it before
  // the picker existed never loses its share image. Either a
  // same-origin path (starts with /) or an https URL.
  ogImagePath: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine(
      (u) => u == null || /^(?:https?:\/\/|\/[^/])/i.test(u),
      'must_be_https_or_same_origin_path',
    ),
  // Operator-uploaded favicon (browser-tab / bookmark / home-screen
  // icon). Stored as a media reference like the header logo; the root
  // layout resolves it to <link rel="icon"> in generateMetadata. When
  // null, Next's file convention serves the bundled app/favicon.ico.
  // Inline media shape rather than the shared `mediaRef` because
  // mediaRef is declared AFTER defaultSeo in this module — referencing
  // it here would hit the const temporal-dead-zone at module load.
  favicon: z
    .object({
      media_id: z.number().int().positive(),
      alt: z.string().max(180),
    })
    .nullable()
    .optional(),
})

// Reusable media-ref shape for fields that point at an uploaded asset.
// `media_id` keys back into the `media` table; `alt` is denormalised
// here so the renderer doesn't need a JOIN to know the alt text.
const mediaRef = z.object({
  media_id: z.number().int().positive(),
  alt: z.string().max(180),
})

const ctaRef = z.object({
  text: z.string().max(60),
  href: siteLink,
  openInNew: z.boolean().optional(),
})

// Public footer theme. Same palette as the header (headerTheme) so the
// two surfaces can be matched. Default 'obsidian' reproduces the
// historic always-dark footer; resolveFooterTheme (lib/cms/footerTheme)
// maps each value to the footer's class set. Default fills on read for
// installs whose stored footer JSON predates this field.
const footerTheme = z
  .enum(['cream', 'obsidian', 'ivory', 'champagne', 'bone'])
  .default('obsidian')

const footer = z.object({
  tagline: z.string().max(220),
  // Visual theme — see footerTheme above.
  theme: footerTheme,
  // Same blank-seeding MenuBuilder as the header → prune unlabeled columns +
  // links before validation so an abandoned "Add column"/"Add link" row never
  // persists and renders as an empty heading / dead link in the public footer.
  // Footer link label key is `text`; the column label is `label`.
  columns: z.preprocess(
    makeMenuPrune({
      childrenKey: 'links',
      childLabelKey: 'text',
      childHrefKey: 'href',
      conservativeParent: true,
    }),
    z
      .array(
        z.object({
          label: z.string().max(60),
          links: z
            .array(
              z.object({
                text: z.string().max(60),
                href: siteLink,
              }),
            )
            .max(20),
        }),
      )
      .max(6),
  ),
  // Optional footer logo override. When null, the footer falls back
  // to the header logo (or brand text). Lets the operator use a
  // lighter wordmark on the dark footer if the dark logo doesn't read
  // on cream.
  logo: mediaRef.nullable().optional(),
  // Rendered footer-logo height in px. Mirrors siteHeader.logoMaxHeight.
  // Default 48 reproduces the historic hard-coded `h-12`; `.default()`
  // back-fills on read for installs whose stored footer JSON predates
  // this field — no migration needed.
  logoMaxHeight: z.number().int().min(24).max(96).default(48),
  // Newsletter card heading / body / CTA label. Previously hardcoded
  // in SiteFooter.tsx — exposed as flat keys so the admin form
  // renderer (which doesn't do dotted-path access) shows them as
  // three separate inputs the operator can edit independently.
  newsletterHeading: z.string().max(120).optional(),
  newsletterBody: z.string().max(400).optional(),
  newsletterCtaLabel: z.string().max(40).optional(),
  // Copyright line. Empty → renderer falls back to the header brand
  // name. The renderer auto-appends the current year so the operator
  // doesn't have to update it annually.
  copyright: z.string().max(220).optional(),
  // Bottom-row legal links (Privacy, Terms, Cookies, etc.). Capped at
  // 4 so they fit on one row on mobile.
  legalLinks: z
    .array(z.object({ text: z.string().max(60), href: siteLink }))
    .max(4)
    .optional(),
})

// Public site header theme. Mirrors the luxury section palette in
// lib/cms/blockMeta.ts (obsidian / ivory / champagne / bone) plus
// the warm `cream` page-default. Public SiteHeader.tsx maps each
// value to a class set covering bg + border + brand + nav + nav-
// hover + CTA bg/text/hover so the whole bar reads consistent and
// the CTA doesn't visually disappear on its own background.
//
// Default 'cream' so existing deployments without this key in the
// stored `settings.value` JSON render exactly as they did before
// this field was added (Zod `.default('cream')` fills on read).
const headerTheme = z
  .enum(['cream', 'obsidian', 'ivory', 'champagne', 'bone'])
  .default('cream')

// Operator brand palette. See lib/cms/themeCss.ts for how these values
// drive --brand-* CSS vars. All colors are 6-char hex; HEX_COLOR_RE
// (designTokens) also allows 3/8-char but the picker emits 6-char and
// the brand-var generator re-validates on emit.
const themePalette = z.object({
  mode: z.enum(['light', 'dark']).default('light'),
  primary: z.string().regex(HEX_COLOR_RE).default('#050505'),
  secondary: z.string().regex(HEX_COLOR_RE).default('#6E665A'),
  accent: z.string().regex(HEX_COLOR_RE).default('#C9A961'),
  surfaceDark: z.string().regex(HEX_COLOR_RE).default('#050505'),
  surfaceLight: z.string().regex(HEX_COLOR_RE).default('#F5F1EA'),
})

// Global typography roles (the "Global Fonts" tier). Each role stores a
// font key — a bundled catalog slug OR a runtime custom-font key — so the
// validator is the loose slug shape, not the static catalog membership (the
// settings layer can't see the runtime custom-font registry). roleVarsCss
// fails closed to the default for a key that isn't ACTIVE at render time.
// Token-writable so an AI agent can rebrand the site's typefaces via the
// API — these are presentational, not security-sensitive like siteUrl.
const fontKey = z
  .string()
  .max(64)
  .refine((v) => isFontKeySlug(v), { message: 'unknown_font' })
const typographyRoles = z.object({
  display: fontKey.default(TYPOGRAPHY_ROLES_DEFAULT.display),
  body: fontKey.default(TYPOGRAPHY_ROLES_DEFAULT.body),
})

// Operator-uploaded custom fonts. Managed ONLY by the /api/admin/fonts
// endpoint (which validates the on-disk binary + writes this row) — the
// generic settings PATCH rejects this key so no one can point it at an
// arbitrary file. getSetting parses it on read; the layout emits its
// @font-face from here.
const customFontEntry = z.object({
  key: z.string().regex(CUSTOM_FONT_KEY_RE),
  family: z.string().min(1).max(60),
  category: z.enum(['serif', 'sans', 'display', 'mono']),
  file: z.string().regex(CUSTOM_FONT_FILE_RE),
  format: z.enum(['woff2', 'woff', 'ttf', 'otf']),
  weightRange: z.tuple([z.number().int(), z.number().int()]).nullable().optional(),
  staticWeight: z.number().int().optional(),
  italic: z.boolean().optional(),
})
const customFonts = z.array(customFontEntry).max(50)

// Activated Google fonts. SAME shape as customFontEntry (so the CSS emitter,
// picker, and renderer treat both lists identically) but with the `gf-`
// key/file regexes. Managed ONLY by /api/admin/fonts/google (which fetches
// the woff2 server-side, stores it self-hosted, and writes this row) — the
// generic settings PATCH rejects this key, exactly like custom_fonts, so no
// one can point it at an arbitrary file. getSetting parses it on read; the
// layout emits its @font-face from here. Cap 100 (the activation endpoint
// enforces the same ceiling under its mutex).
const googleFontEntry = z.object({
  key: z.string().regex(GOOGLE_FONT_KEY_RE),
  family: z.string().min(1).max(80),
  category: z.enum(['serif', 'sans', 'display', 'mono']),
  file: z.string().regex(GOOGLE_FONT_FILE_RE),
  format: z.literal('woff2'),
  weightRange: z.tuple([z.number().int(), z.number().int()]).nullable().optional(),
  staticWeight: z.number().int().optional(),
  italic: z.boolean().optional(),
})
const googleFonts = z.array(googleFontEntry).max(100)

// Prune abandoned rows before item validation. Runs on every parse — INCLUDING
// reads (getSetting → safeParse) — so it MUST be non-destructive to data an
// existing install legitimately stored. The two menus differ in what "valid"
// means, so the prune is parameterised:
//
//   • Header (strict): `label` was ALWAYS `.min(1)` on prior versions, so no
//     stored item can have a blank label — dropping blank-label rows on read
//     therefore can't lose real data, and on write it stops the shared
//     MenuBuilder's seeded-but-empty row from rejecting the whole save with an
//     opaque `label.min(1)` 400.
//   • Footer (conservative): column headings + link text were NEVER required
//     (`max(60)`, no `.min(1)`), so an existing footer may legitimately store a
//     blank-heading column that still carries links, or a blank-text link that
//     still carries an href. Those MUST survive (else upgrading silently drops
//     them from the public footer). Here a child is "blank" only when BOTH its
//     text AND href are empty, and a blank-heading column is dropped only when
//     it has no surviving links.
//
// `childLabelKey` is 'label' (header children) | 'text' (footer links); the
// parent/column label is always 'label'.
function makeMenuPrune(opts: {
  childrenKey: string
  childLabelKey: string
  childHrefKey?: string
  conservativeParent?: boolean
}) {
  const { childrenKey, childLabelKey, childHrefKey, conservativeParent } = opts
  const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')
  const blankLeaf = (c: unknown): boolean => {
    if (!c || typeof c !== 'object') return true
    const o = c as Record<string, unknown>
    const label = str(o[childLabelKey])
    // Footer: keep an href-carrying link even with blank text (back-compat).
    if (childHrefKey) return label === '' && str(o[childHrefKey]) === ''
    return label === ''
  }
  return (v: unknown): unknown => {
    if (!Array.isArray(v)) return v
    return v
      .map((it) => {
        if (!it || typeof it !== 'object') return it
        const o = it as Record<string, unknown>
        const kids = o[childrenKey]
        if (Array.isArray(kids)) {
          return { ...o, [childrenKey]: kids.filter((c) => !blankLeaf(c)) }
        }
        return o
      })
      .filter((it) => {
        if (!it || typeof it !== 'object') return false
        const o = it as Record<string, unknown>
        if (str(o.label) !== '') return true
        // Conservative (footer): keep a blank-heading column that still carries
        // links so existing footers render unchanged after upgrade.
        if (conservativeParent) {
          const kids = Array.isArray(o[childrenKey]) ? (o[childrenKey] as unknown[]) : []
          return kids.length > 0
        }
        // Strict (header): a blank-label item can't validate or render — drop.
        return false
      })
  }
}

const siteHeader = z.object({
  // Brand text shown next to (or in place of) the logo.
  brandText: z.string().max(120),
  // Optional uploaded logo. When null, the header falls back to brandText.
  logo: mediaRef.nullable(),
  // Rendered logo height in px. Operator-tunable via Settings → Site
  // header (slider). Bounds: 24px floor keeps a logo legible; 96px
  // ceiling stops the sticky bar from ballooning. Default 40 reproduces
  // the historic hard-coded `h-10`. `.default()` back-fills on read for
  // installs whose stored site_header JSON predates this field — no
  // migration needed (settings are JSON, validated on read).
  logoMaxHeight: z.number().int().min(24).max(96).default(40),
  // Visual theme — see headerTheme above.
  theme: headerTheme,
  // Primary navigation links shown in the top bar. Capped at 6 per
  // operator request — keeps the bar from wrapping and forces editorial
  // discipline.
  navItems: z.preprocess(
    makeMenuPrune({ childrenKey: 'children', childLabelKey: 'label' }),
    z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          // '' allowed (siteLink permits empty) → a parent with children and
          // an empty href is a dropdown-only toggle on the public header.
          href: siteLink,
          // One level of submenu only — a child has no `children`, so the
          // tree can never exceed depth 1. Optional → stored flat menus parse
          // unchanged (settings JSON is validated on read; no migration).
          children: z
            .array(
              z.object({
                label: z.string().min(1).max(60),
                href: siteLink,
              }),
            )
            .max(12)
            .optional(),
        }),
      )
      .max(6),
  ),
  // Single primary call-to-action button. Either field empty → the
  // public renderer hides the button entirely.
  // Nullable so a fresh one-pager install can omit the CTA entirely.
  // Public renderer treats `null` and empty-text-or-href as "no CTA".
  primaryCta: ctaRef.nullable(),
})

// ───────────────────────── Security ─────────────────────────
// Six narrow keys (not one composite "security" blob) so a partial
// save failure can never half-lock the operator out. Every key with
// lockout risk also gets a server-side guard in the PATCH handler
// (app/api/admin/settings/route.ts) — Zod here is shape-only; the
// guards are policy.

// Single-segment admin login URL. Same shape constraint as the env
// fallback (lib/env.ts LOGIN_PATH); the env value seeds the default
// so a fresh deploy with no DB row still finds the login page.
// getResolvedLoginPath() (lib/security/getResolvedLoginPath.ts) reads
// env override first → DB row → env fallback, so a corrupted JSON
// cell can never lock the operator out.
const securityLoginPath = z.object({
  path: z
    .string()
    .regex(
      /^[a-z0-9-]{6,32}$/,
      'must_be_6_to_32_lowercase_or_dash',
    )
    .refine((v) => !RESERVED.has(v.toLowerCase()), {
      message: 'collides_with_reserved_path',
    }),
})

// Global reCAPTCHA — one (version, siteKey, secretKey) tuple applied
// to all public forms AND admin login. Two enabled flags: `enabled`
// gates PUBLIC forms (contact / newsletter / inquiry / brochure);
// `enabledOnLogin` gates ADMIN LOGIN and is itself gated behind a
// verify-before-enable handshake (the PATCH handler refuses to write
// enabledOnLogin=true unless a fresh matching verification row exists
// — see security_recaptcha_verification table).
// `minScore` applies to v3 only; ignored for v2 (which is pass/fail).
const securityRecaptcha = z
  .object({
    enabled: z.boolean(),
    enabledOnLogin: z.boolean(),
    version: z.enum(['v2', 'v3']),
    // Google site/secret keys are 40-char base64-ish strings. The
    // bounds here are generous (Google has changed key length over
    // the years) and the real test is "siteverify accepts them" —
    // performed by /api/admin/security/verify-recaptcha.
    siteKey: z.string().min(20).max(120).optional(),
    secretKey: z.string().min(20).max(120).optional(),
    minScore: z.number().min(0).max(1),
  })
  .refine(
    (d) => !d.enabled || (!!d.siteKey && !!d.secretKey),
    { message: 'siteKey_and_secretKey_required_when_enabled' },
  )
  .refine(
    (d) => !d.enabledOnLogin || d.enabled,
    { message: 'enable_on_public_first' },
  )

// CIDR validation delegates to the actual parser (lib/security/ipMatch
// parseCidr). One source of truth: the SAME function that the
// middleware uses for matching decides whether a string is acceptable.
// Allowlist capped at 50 (operator scenarios: home + office + a few
// VPN exit nodes); blocklist at 500 (abuse-IP datasets).
// Defensive cap of 1000 on the BASE alias guards a future setting
// that forgets to apply its own `.max(...)` — never leaves the
// payload unbounded.
const cidrList = z
  .array(z.string().max(45).refine((s) => parseCidr(s) !== null, 'invalid_cidr'))
  .max(1000)
const securityIpLists = z.object({
  allowlist: z.object({
    enabled: z.boolean(),
    cidrs: cidrList.max(50),
  }),
  blocklist: z.object({
    enabled: z.boolean(),
    cidrs: cidrList.max(500),
  }),
})

// Login attempt rate-limit knobs. Bounds keep the operator from
// effectively disabling rate-limiting (cap 20 per window) or setting
// nonsense windows (10s..24h). The login route reads these at request
// time with the existing rateLimit() bucket — changing the values
// applies to the next request, not retroactively to current buckets.
//
// Lockout DURATIONS (after sustained failures) remain env-driven via
// LOCKOUT_THRESHOLDS / LOCKOUT_DURATIONS_MIN — those drive the
// 3-tier lockout in lib/auth/lockout.ts which doesn't map onto a
// single integer. Surfacing a "lockoutMinutes" field in the UI that
// silently has no effect was misleading; removed.
//
// Cross-field guard: a very low limit paired with a very long window
// (e.g. perEmailLimit=1, perEmailWindowSec=86400) lets a hostile
// admin DOS any user account for 24h with one failed login. Require
// at least 3 attempts when the window exceeds 5 minutes.
const securityLoginThresholds = z
  .object({
    perIpLimit: z.number().int().min(1).max(20),
    perIpWindowSec: z.number().int().min(10).max(3600),
    perEmailLimit: z.number().int().min(1).max(20),
    perEmailWindowSec: z.number().int().min(10).max(86400),
  })
  .refine(
    (d) => d.perEmailLimit >= 3 || d.perEmailWindowSec <= 300,
    {
      message: 'perEmailLimit < 3 requires perEmailWindowSec ≤ 300 (DOS guard)',
      path: ['perEmailLimit'],
    },
  )
  .refine(
    (d) => d.perIpLimit >= 3 || d.perIpWindowSec <= 300,
    {
      message: 'perIpLimit < 3 requires perIpWindowSec ≤ 300 (DOS guard)',
      path: ['perIpLimit'],
    },
  )

// Public-traffic maintenance mode. `bypassIps` is the operator's own
// allowlist for "I can still browse the site"; the PATCH handler
// auto-includes the saver's detected IP so an over-eager toggle
// doesn't lock the operator off their own public pages.
const securityMaintenance = z.object({
  enabled: z.boolean(),
  message: z.string().max(280),
  bypassIps: cidrList.max(20),
})

// Suspicious-request blocks. Pure booleans — NO user-entered patterns
// (regex-DoS surface + lockout risk if the pattern matches /admin).
// Patterns themselves live in lib/security/suspiciousRequest.ts.
const securitySuspiciousBlocks = z.object({
  blockMissingUserAgent: z.boolean(),
  blockBotUaPatterns: z.boolean(),
  blockProbePaths: z.boolean(),
})

// ─────────────────────── Integrations ───────────────────────
// One narrow registry key per provider so a malformed save on one
// (e.g., bad HubSpot token shape) can never roll back an unrelated
// provider's row. Analytics/tracking/widget keys are non-credentialed
// — saving them is routine (no step-up reauth). The two CRM keys
// (integrations_hubspot, integrations_zoho_crm) ARE credentialed and
// gated by `requireFreshReauth` in app/api/admin/settings/route.ts.
//
// Credentials are write-only in the UI: the admin Integrations page
// redacts secret fields before sending the row to the client form,
// and PATCH preserves any incoming undefined/empty credential field
// instead of overwriting the stored value (see integrations page).
//
// Per-source destination maps for the CRM keys cover the lead
// endpoints that aren't block widgets (newsletter / brochure /
// inquiry). The contact_form block widget overrides per-instance via
// its own crmDestinations on the block tree.

const hubspotPortalId = z.string().regex(/^[0-9]+$/, 'must_be_digits').max(20)
const hubspotFormId = z.string().uuid()
const hubspotFieldMap = z.record(z.string().max(60), z.string().max(120))
const zohoFieldMap = z.record(z.string().max(60), z.string().max(120))
const fieldMapMaxKeys = (m: Record<string, string>) => Object.keys(m).length <= 40

const integrationsGtm = z
  .object({
    enabled: z.boolean(),
    containerId: z.string().regex(/^GTM-[A-Z0-9]+$/, 'must_be_GTM-XXX').max(20).optional(),
  })
  .refine((d) => !d.enabled || !!d.containerId, { message: 'containerId_required_when_enabled', path: ['containerId'] })

const integrationsGa4 = z
  .object({
    enabled: z.boolean(),
    measurementId: z.string().regex(/^G-[A-Z0-9]+$/, 'must_be_G-XXX').max(20).optional(),
    // When true and GTM is also enabled, the GA4 loader is suppressed
    // (GA4 fires through GTM instead). The renderer enforces this —
    // the schema just stores the operator's intent.
    viaGtm: z.boolean(),
  })
  .refine((d) => !d.enabled || !!d.measurementId, { message: 'measurementId_required_when_enabled', path: ['measurementId'] })

const integrationsGoogleAds = z
  .object({
    enabled: z.boolean(),
    conversionId: z.string().regex(/^AW-[0-9]+$/, 'must_be_AW-XXX').max(20).optional(),
    defaultConversionLabel: z.string().max(40).optional(),
  })
  .refine((d) => !d.enabled || !!d.conversionId, { message: 'conversionId_required_when_enabled', path: ['conversionId'] })

const integrationsHotjar = z
  .object({
    enabled: z.boolean(),
    siteId: z.string().regex(/^[0-9]+$/, 'must_be_digits').max(20).optional(),
    snippetVersion: z.number().int().min(6).max(8),
  })
  .refine((d) => !d.enabled || !!d.siteId, { message: 'siteId_required_when_enabled', path: ['siteId'] })

const integrationsZohoSalesIq = z
  .object({
    enabled: z.boolean(),
    widgetCode: z.string().min(20).max(400).optional(),
    region: z.enum(['com', 'eu', 'in', 'com.au', 'jp']),
  })
  .refine((d) => !d.enabled || !!d.widgetCode, { message: 'widgetCode_required_when_enabled', path: ['widgetCode'] })

// HubSpot lead source → form destination map. Keys constrained to the
// known submit-handler sources (matches leads.source enum + extra
// 'newsletter' which lives in its own subscriber table).
const leadSource = z.enum(['contact', 'newsletter', 'brochure', 'inquiry'])

const hubspotDestination = z.object({
  formId: hubspotFormId,
  fieldMap: hubspotFieldMap.refine(fieldMapMaxKeys, 'too_many_field_mappings'),
  listIds: z.array(z.number().int().positive()).max(10).optional(),
})

const integrationsHubspot = z
  .object({
    enabled: z.boolean(),
    portalId: hubspotPortalId.optional(),
    // Private App access token. NEVER returned to the client by the
    // admin Integrations page — the server-side render redacts it
    // before handing to the form, and PATCH preserves the stored
    // value when an incoming value is empty/undefined.
    privateAppAccessToken: z.string().min(20).max(200).optional(),
    // Independently toggles the tracking script that mints the
    // hubspotutk cookie (visitor attribution for Forms API submits).
    trackingEnabled: z.boolean(),
    // Per-source defaults for the lead endpoints that aren't block
    // widgets. contact_form block instances override per-instance.
    formSourceMap: z.record(leadSource, hubspotDestination).optional(),
  })
  .refine((d) => !d.enabled || (!!d.portalId && !!d.privateAppAccessToken), {
    message: 'portalId_and_token_required_when_enabled',
  })

const zohoDestination = z.object({
  module: z.enum(['Leads', 'Contacts', 'Deals']),
  mode: z.enum(['webform', 'oauth']),
  // xnQsjsdp value when mode === 'webform'. Empty for oauth mode.
  webformAuthToken: z.string().max(200).optional(),
  fieldMap: zohoFieldMap.refine(fieldMapMaxKeys, 'too_many_field_mappings'),
  assignmentRuleId: z.string().max(40).optional(),
})

const integrationsZohoCrm = z
  .object({
    enabled: z.boolean(),
    region: z.enum(['com', 'eu', 'in', 'com.au', 'jp']),
    authMode: z.enum(['webform', 'oauth']),
    // OAuth credentials — only required when authMode === 'oauth'.
    // Refresh token rotation happens server-side in lib/crm/zoho.ts.
    // All three redacted by the integrations page render path.
    oauthClientId: z.string().min(10).max(200).optional(),
    oauthClientSecret: z.string().min(10).max(200).optional(),
    oauthRefreshToken: z.string().min(10).max(400).optional(),
    formSourceMap: z.record(leadSource, zohoDestination).optional(),
  })
  .refine(
    (d) =>
      !d.enabled ||
      d.authMode !== 'oauth' ||
      (!!d.oauthClientId && !!d.oauthClientSecret && !!d.oauthRefreshToken),
    { message: 'oauth_credentials_required_when_oauth_enabled' },
  )

// ─────────────────────── Mobile CTA ───────────────────────
// Sticky bottom bar visible ONLY on < md viewports on PUBLIC pages.
// Up to 2 operator-configurable buttons. icon is constrained to a
// render-time lucide allowlist (see lib/cms/mobileCtaIcons.ts —
// the canonical const tuple lives there so client components can
// import it without dragging this server-only registry into the
// client bundle).

const mobileCtaButton = z.object({
  text: z.string().max(40),
  href: siteLink,
  icon: z.enum(MOBILE_CTA_ICONS),
})

const mobileCta = z.object({
  enabled: z.boolean(),
  // Cap at 4 — 1-2 buttons render horizontal (icon beside text);
  // 3-4 buttons render vertical stack (icon over tiny text), the
  // tab-bar pattern. Anything beyond 4 wouldn't fit even with
  // vertical stacking on a 375px viewport.
  buttons: z.array(mobileCtaButton).max(4),
})

const organizationJsonLd = z.object({
  name: z.string().max(180),
  altName: z.string().max(180).optional(),
  // Optional uploaded logo for Google branded-search results
  // (schema.org Organization.logo). Stored as a media reference like
  // the header logo / favicon — the operator picks a file, never types
  // a URL. When null, organizationLd() falls back to the site-header
  // logo automatically; if neither is set the `logo` field is omitted
  // from the JSON-LD (a missing logo beats a broken one for indexers).
  logo: mediaRef.nullable().optional(),
  foundingDate: z.string().max(40).optional(),
  sameAs: z.array(HttpsUrl).max(20).optional(),
})

// Site-wide identity — used wherever CaveCMS emits absolute URLs
// (sitemap.xml, robots.txt, JSON-LD `url` fields, every email link).
//
// `siteUrl` is REQUIRED for those surfaces to emit anything; until an
// operator configures it, sitemap/robots fall back to relative URLs
// and email-based notifications are skipped. This is intentional — a
// freshly-installed CaveCMS shouldn't be putting a placeholder URL
// into emails by mistake.
const siteGeneral = z.object({
  siteUrl: z
    .string()
    .max(500)
    .url()
    .refine(
      (u) => u.startsWith('https://') && !u.endsWith('/'),
      'must_be_https_no_trailing_slash',
    )
    .optional()
    .or(z.literal('').transform(() => undefined)),
  siteName: z.string().max(120).optional(),
})

// Session + CSRF timeout policy. Hard caps enforce the project's
// security gold-standard: max 8h session, max 24h absolute. An
// operator who sets a "1 year session" through the dashboard gets
// Zod-rejected before it ever lands in the DB.
const sessionConfig = z.object({
  /** JWT lifetime per token, in seconds. 1h–8h. */
  jwtTtlSec: z
    .number()
    .int()
    .min(3600, 'min_1h')
    .max(28800, 'max_8h')
    .default(28800),
  /** Soft-renew threshold — middleware re-issues the JWT when this
   *  many seconds remain on the current one. 5min–1h. */
  jwtRenewAfterSec: z
    .number()
    .int()
    .min(300, 'min_5m')
    .max(3600, 'max_1h')
    .default(1800),
  /** Absolute max from `oat` (original auth time) — caps how long a
   *  rolling session can survive past the initial login. Max 24h. */
  jwtAbsoluteMaxSec: z
    .number()
    .int()
    .min(3600, 'min_1h')
    .max(86400, 'max_24h')
    .default(86400),
  /** CSRF token lifetime, seconds. Max 24h. */
  csrfTtlSec: z
    .number()
    .int()
    .min(900, 'min_15m')
    .max(86400, 'max_24h')
    .default(3600),
})

// Self-update preferences. Mirrors the Settings → Updates form.
// `notificationEmail` is optional + nullable so a blank input maps to
// undefined (no email notification) — distinct from a typo'd value
// (which gets rejected by the email refinement).
const updates = z.object({
  autoApplySecurityPatches: z.boolean().default(true),
  // Download (NOT apply) new releases in the background after a check finds
  // one, so a later "Update now" installs in seconds instead of waiting on
  // the download. Verified (sha256 + Ed25519) before caching. Never
  // auto-applies. Default on; operators on metered/locked-down links can
  // turn it off (apply then downloads inline, as before).
  autoDownload: z.boolean().default(true),
  checkFrequencyHours: z.number().int().min(1).max(168).default(12),
  notificationEmail: z
    .string()
    .max(180)
    .email('must_be_email')
    .optional()
    .or(z.literal('').transform(() => undefined)),
})

// Internal state for the install wizard. The middleware install-gate
// reads `completedAt` — null means a fresh deploy, redirect to /install.
// Once set, /install is permanently locked.
const installState = z.object({
  completedAt: z.string().max(40).optional(),
  /** Site URL the operator entered during install. Stored here as a
   *  forensic record; the live siteUrl lives at `site_general`. */
  initialSiteUrl: z.string().max(500).optional(),
})

// Internal state for the Updates background job. NOT operator-editable
// — no form shape, no Settings page surface. The instrumentation.ts
// scheduled job writes `lastNotifiedSha` here so we don't re-email
// the operator about the same release on every poll.
const updatesState = z.object({
  lastNotifiedSha: z.string().max(64).optional(),
  lastNotifiedAt: z.string().max(40).optional(),
  lastCheckedAt: z.string().max(40).optional(),
  // Background pre-stage bookkeeping. The durable system-of-record (across
  // process restarts) for what the prestage runner has downloaded +
  // verified — the in-memory checkLatestRelease cache is per-process / 5-min
  // and can't serve as one. findValidStaged (disk truth) remains the
  // authoritative "is it really staged" signal; these fields drive the
  // scheduler's re-entrancy guard + the UI status line.
  stagedSha: z.string().max(64).optional(),
  stagedSha256: z.string().max(64).optional(),
  stagedVersion: z.string().max(64).optional(),
  stagedPath: z.string().max(1024).optional(),
  stagedAt: z.string().max(40).optional(),
  stagedBytes: z.number().nonnegative().optional(),
  stageState: z
    .enum(['staged', 'downloading', 'failed', 'ineligible'])
    .optional(),
  stageError: z.string().max(500).optional(),
})

// Cloud backup destinations (Google Drive / OneDrive). The refresh token is
// stored as an encrypted envelope (AES-256-GCM via SECRETS_ENCRYPTION_KEY) —
// never plaintext. folderId is resolved lazily on first upload, so it stays
// undefined right after connect. clientFingerprint records which baked-in
// public client minted the token so a future client rotation can prompt a
// reconnect.
const backupCloudConnection = z.object({
  connected: z.boolean().default(false),
  accountEmail: z.string().max(200).optional(),
  folderId: z.string().max(200).optional(),
  refreshToken: encryptedSecretSchema.nullable().optional(),
  clientFingerprint: z.string().max(64).optional(),
})

// Optional passphrase encryption for cloud archives. The passphrase itself is
// stored encrypted-at-rest (for one-click restore) AND known to the operator
// (so a host loss doesn't strand the archive). saltB64 is the non-secret
// scrypt salt, needed to re-derive the age identity on restore. Consumed in
// Phase 2 — defined now to keep the shape stable.
const backupEncryption = z.object({
  passphraseEnabled: z.boolean().default(false),
  passphrase: encryptedSecretSchema.nullable().optional(),
  saltB64: z.string().max(64).optional(),
})

// Operator-facing backup configuration + per-provider connection state. Not
// edited through the generic Settings PATCH form — the Backups page owns
// dedicated connect/disconnect routes that write this key via writeSetting.
const backups = z.object({
  destination: z.enum(['local', 'gdrive', 'onedrive']).default('local'),
  keepLocalCopy: z.boolean().default(true),
  remoteRetention: z.number().int().min(1).max(100).default(7),
  includeEnv: z.boolean().default(false),
  encryption: backupEncryption.default({ passphraseEnabled: false }),
  schedule: z.enum(['off', 'daily', 'weekly']).default('off'),
  scheduleHour: z.number().int().min(0).max(23).default(3),
  scheduleWeekday: z.number().int().min(0).max(6).default(0),
  gdrive: backupCloudConnection.default({ connected: false }),
  onedrive: backupCloudConnection.default({ connected: false }),
})

// Short-lived device-flow pending block, stashed between the connect request
// and the poll completion. The device_code is encrypted at rest; the block is
// cleared on success / denial / expiry.
const backupPending = z.object({
  deviceCode: encryptedSecretSchema,
  userCode: z.string().max(64),
  verificationUrl: z.string().max(300),
  expiresAt: z.string().max(40),
  intervalSec: z.number().int().min(1).max(60),
})

// Internal state for the Backups feature (device-flow pending + scheduler
// bookkeeping). NOT operator-editable — no form shape.
const backupsState = z.object({
  gdrivePending: backupPending.optional(),
  onedrivePending: backupPending.optional(),
  lastScheduledBackupAt: z.string().max(40).optional(),
  lastScheduledResult: z.enum(['ok', 'failed', 'skipped']).optional(),
  lastScheduledError: z.string().max(300).optional(),
  // True between a scheduler-initiated spawn and its terminal audit callback, so
  // the audit-terminal endpoint can record the REAL outcome (a scheduled run's
  // result reflects completion, not just that it was spawned). scheduledInFlightAt
  // stamps the claim time so a flag left stale by a trap-bypassing kill
  // (SIGKILL/OOM) can be detected + ignored instead of mislabelling a later
  // manual backup's outcome as the scheduled result.
  scheduledInFlight: z.boolean().optional(),
  scheduledInFlightAt: z.string().max(40).optional(),
})

// SMTP configuration. Moved from .env.local so operators can configure
// outbound email from the dashboard without SSH'ing the server.
// Mirrors the env-var shape: host/port/secure/user/password/fromAddress/
// fromName. `password` redacted client-side like the HubSpot/Zoho CRM
// credential pattern — never sent back to the form, PATCH preserves
// the stored value when an empty string comes in.
const smtpConfig = z
  .object({
    enabled: z.boolean(),
    host: z.string().max(200).optional(),
    port: z.number().int().min(1).max(65535).default(587),
    // 465 = implicit TLS; 587 = STARTTLS (requireTLS). When `false`
    // and port !== 465 we let nodemailer auto-detect.
    secure: z.boolean().default(false),
    user: z.string().max(180).optional(),
    password: z.string().max(400).optional(),
    fromAddress: z
      .string()
      .max(180)
      .email('must_be_email')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    fromName: z.string().max(120).optional(),
    // Lead-notification recipient — replaces the old `SALES_EMAIL`
    // env var. When a visitor submits a contact / inquiry / brochure
    // form, the operator gets an email here. Falls back to
    // fromAddress when unset (single-mailbox deploys).
    notificationRecipient: z
      .string()
      .max(180)
      .email('must_be_email')
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .refine(
    (d) => !d.enabled || (!!d.host && !!d.fromAddress),
    'host_and_from_required_when_enabled',
  )

// ─── AI Assistant (Gemini) ───
// Operator-provided Gemini key (BYOK), stored encrypted at rest via
// lib/security/secretCipher. The settings PATCH route preserves the
// stored value when an incoming `apiKey` is null/undefined — same
// redaction pattern as SMTP password / HubSpot token. `apiKeyLast4`
// is the only operator-visible record of the saved key ("ends in
// 1234") — derived at write time and stored alongside so the UI
// never has to round-trip ciphertext through decrypt for display.
//
// `voicePreset` feeds into the AI system prompt to keep rewrites in
// the operator's brand voice. Marketing positions this as "in your
// voice, with your site's tone." Custom preset unlocks the free-form
// notes field (capped at 800 chars — long enough for a couple of
// style examples, short enough to keep the prompt under cost budget).
//
// Cross-field refines:
//   - Enabling AI requires a stored apiKey (UI may show a placeholder
//     "set" state when the operator already saved a key; the PATCH
//     route's redaction merge handles this).
//   - Verifying the connection (verifiedAt set by /api/admin/ai/verify)
//     is a soft gate — the surface toggles (inlineEnabled / chatEnabled)
//     can be flipped at any time, but the verify timestamp lets the UI
//     show "needs reverification after key change."
// CREATOR-vs-USER AUTHORITY (read this before editing the AI shape).
//
// The CaveCMS creator (us, shipping the CMS) controls:
//   - Which AI provider(s) are wired in (Gemini only for v1)
//   - The model allowlist below — operators pick from it, never extend
//   - The Zod shape, the cross-field refines, encryption at rest
//   - The tool surface exposed to Gemini (lib/ai/tools.ts), the system
//     prompt scaffolding (lib/ai/prompts/*), the apply pipeline
//   - Backend behaviour: rate limits, proposal expiry, tool budget,
//     audit logging, redaction patterns
//
// The CaveCMS operator (the person who installs CaveCMS on their box)
// controls:
//   - Whether AI is on at all (enabled / inlineEnabled / chatEnabled)
//   - Their own Gemini API key (BYOK)
//   - Which model their site uses for each surface (from our allowlist)
//   - Their brand voice (preset + free-form notes)
//   - Whether to apply or dismiss each proposed change
//
// What the operator does NOT control: anything that affects safety
// (CSRF, optimistic locks, sanitization), the tool surface (so the AI
// can never reach beyond CMS blocks), or the apply pipeline (so every
// AI edit lands through the same audited write path a manual edit
// uses). When tempted to make something configurable, ask: "does the
// operator NEED this knob, or is a sensible creator-decision enough?"
// Configurability is a maintenance + audit + safety surface. Default
// to creator-locked; expose to the operator only with a reason.
//
// Voice presets are deliberately brand-NEUTRAL — CaveCMS is a generic
// CMS, so the shipped presets must work for a bakery, a law firm, a
// fan blog, or a luxury brand alike. Vertical-specific tones live in
// `customVoiceNotes` where the operator writes them in their own words.
//
// Gemini API model IDs verified against
// https://ai.google.dev/gemini-api/docs/models on 2026-05-25. Exact
// strings matter — these get passed verbatim to the @google/genai SDK,
// so an unrecognised value would 400 the verify endpoint and silently
// break inline / chat at runtime. When Google deprecates a preview ID,
// this list updates and the post-migrate gate fails any DB rows still
// pointing at the dead ID (the operator re-picks from the dashboard).
//
// No default. The operator MUST pick before AI features turn on. The
// refines below require both surfaces' model fields to be present when
// the matching surface is enabled — clearer than us silently picking
// a model the operator never approved.
//
// The list itself moved to `lib/cms/aiModelIds.ts` (client-safe) so
// the admin Settings → AI page can read it without dragging this
// server-only registry into the client bundle. Re-exported here for
// any caller still importing from this module.
export { AI_MODEL_IDS }

const aiModelEnum = z.enum(AI_MODEL_IDS)

const aiConfig = z
  .object({
    enabled: z.boolean(),
    provider: z.literal('gemini'),
    // Encrypted envelope of the Gemini API key, or null when not yet
    // configured. The settings PATCH route MUST preserve the stored
    // value when an empty / undefined apiKey comes in — mirrors the
    // SMTP password redaction merge.
    apiKey: encryptedSecretSchema.nullable().optional(),
    // Last 4 plaintext chars of the saved key, for UI display only
    // ("Key ending in …1234"). Industry-standard amount to surface
    // (Stripe / SendGrid pattern). Set at write time alongside apiKey
    // by the settings PATCH route — clients MUST NOT supply this
    // directly (PATCH overrides any client-supplied value). Exact
    // length (4) enforced so a tampered DB cell cannot mislead the
    // operator with a longer or shorter "ends in" display.
    apiKeyLast4: z.string().length(4).optional(),
    // Per-surface model choice. Optional in the schema (the row may
    // exist before the operator picks), but required-when-enabled via
    // the refines below. No fallback default — picking is intentional
    // because models differ in cost, latency, and capability profile.
    models: z
      .object({
        inline: aiModelEnum.optional(),
        chat: aiModelEnum.optional(),
      })
      .optional(),
    inlineEnabled: z.boolean(),
    chatEnabled: z.boolean(),
    // Brand-neutral starting tones. The creator ships the menu; the
    // operator picks one — or chooses 'custom' to describe their own
    // voice in `customVoiceNotes`. No vertical-specific values (e.g.
    // "luxury", "real-estate", "saas") — those are the operator's job
    // to describe in custom mode.
    voicePreset: z.enum([
      'default',
      'editorial',
      'friendly',
      'professional',
      'playful',
      'custom',
    ]),
    customVoiceNotes: z.string().max(800).optional(),
    // ISO 8601 string set by /api/admin/ai/verify when a Gemini ping
    // succeeds with the currently-saved key. Cleared on apiKey change
    // (the PATCH handler wipes it whenever a new apiKey is supplied).
    verifiedAt: z.string().max(40).optional(),
  })
  .superRefine((d, ctx) => {
    // Dominating constraint first — if the operator enabled a surface
    // without enabling the master switch, only THAT error surfaces.
    // Otherwise a single misclick would generate three error bubbles
    // and the UI would have to guess which to highlight first.
    if (!d.enabled && (d.inlineEnabled || d.chatEnabled)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enable_master_switch_first',
        path: ['enabled'],
      })
      return
    }
    // Master switch is on, but the credential row is empty. The
    // settings PATCH route preserves a previously-stored apiKey when
    // the form sends an empty field — so this fires only when the
    // operator truly has no key.
    if (d.enabled && !d.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'api_key_required_when_enabled',
        path: ['apiKey'],
      })
    }
    // No-fallback model selection. A surface can be enabled only when
    // its model is picked — we refuse to silently choose for the
    // operator. Per-field paths so the admin form lights up the right
    // input.
    if (d.inlineEnabled && !d.models?.inline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'inline_model_required_when_inline_enabled',
        path: ['models', 'inline'],
      })
    }
    if (d.chatEnabled && !d.models?.chat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'chat_model_required_when_chat_enabled',
        path: ['models', 'chat'],
      })
    }
  })

// ════════════════════════ SEO Suite ════════════════════════
// Ten narrow keys (one per concern, never one "seo" blob) so a bad
// save on one surface can't roll back an unrelated one — the same
// discipline the security/integration keys use. All but
// `seo_indexing_api` are non-credentialed and token-writable so an AI
// agent can drive SEO through the API. Field-level safety notes inline.

// Title/description templates resolve `%variable%` tokens at render
// time (lib/seo/templates). Bounds are generous — the resolved string
// is what gets truncated for the SERP, not the template. The separator
// is a single site-wide glyph reused by every template's `%sep%`.
const seoTemplatePair = z.object({
  title: z.string().max(220),
  description: z.string().max(360),
})
const seoTitles = z.object({
  // The `%sep%` glyph. Free-text (max 8) rather than an enum so an
  // operator can use any separator their brand prefers; the renderer
  // HTML-escapes it. Default en-dash matches Yoast/Rank Math.
  separator: z.string().max(8).default('–'),
  home: seoTemplatePair,
  page: seoTemplatePair,
  post: seoTemplatePair,
  project: seoTemplatePair,
  blogIndex: seoTemplatePair,
  projectsIndex: seoTemplatePair,
  // NOTE: no `search` / `notFound` templates — there is no /search route,
  // and the 404 page uses static metadata. Adding them here would be dead
  // config the resolver never consumes. (resolve.ts's contentType union
  // is a harmless superset that still names them for callers.)
})

// Crawl/index policy that isn't per-page. `discourageSearchEngines` is
// the global "noindex the whole site" kill-switch (WordPress's
// "Discourage search engines" toggle) — when on, robots.ts serves
// Disallow:/ and every page emits noindex. Loud + reversible.
const seoIndexing = z.object({
  discourageSearchEngines: z.boolean().default(false),
  noindexSearch: z.boolean().default(true),
  noindexPaginated: z.boolean().default(false),
})

// Default Open Graph / Twitter signals. The default OG IMAGE lives at
// `default_seo.ogImage` (don't duplicate it) — this key carries the
// non-image social knobs. Handles are stored with or without the
// leading @ and normalised by the renderer.
const twitterHandle = z
  .string()
  .max(40)
  .regex(/^@?[A-Za-z0-9_]{1,30}$/, 'invalid_handle')
  .optional()
  // A blank input must map to "unset", not a regex-rejected '' → 400.
  .or(z.literal('').transform(() => undefined))
const seoSocial = z.object({
  twitterCard: z.enum(['summary', 'summary_large_image']).default('summary_large_image'),
  twitterSite: twitterHandle,
  twitterCreator: twitterHandle,
  facebookAppId: z.string().max(40).regex(/^\d*$/, 'must_be_digits').optional(),
  ogLocale: z.string().max(12).regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'invalid_locale').default('en_US'),
})

// Structured-data defaults. The Organization entity fields themselves
// live in `organization_json_ld` (reused); this key picks the entity
// TYPE (a personal site is a Person, not an Organization), the default
// article subtype, breadcrumbs, and the WebSite SearchAction (Google
// sitelinks searchbox). Per-page schema overrides live on the entity row.
const seoSchema = z.object({
  entityType: z.enum(['Organization', 'Person']).default('Organization'),
  personName: z.string().max(180).optional(),
  breadcrumbsEnabled: z.boolean().default(true),
  articleType: z.enum(['Article', 'BlogPosting', 'NewsArticle']).default('BlogPosting'),
  websiteSearchAction: z.boolean().default(false),
})

// XML sitemap configuration. The sitemap is a single file capped at the
// 50,000-URL protocol maximum (see app/sitemap.ts MAX_TOTAL_ENTRIES) —
// it never splits, so there is no per-file knob. `excludeNoindex` keeps
// per-page noindex pages out of the sitemap (a noindexed URL in the
// sitemap is a contradictory signal).
const seoSitemap = z.object({
  enabled: z.boolean().default(true),
  includePages: z.boolean().default(true),
  includePosts: z.boolean().default(true),
  includeProjects: z.boolean().default(true),
  includeImages: z.boolean().default(true),
  excludeNoindex: z.boolean().default(true),
})

// Search-engine ownership verification codes. Each value lands in a
// `<meta name="…-verification" content="HERE">` tag in the homepage
// <head>. The charset is locked to token-safe characters so a value
// can never break out of the attribute (no quotes / angle brackets).
const verificationCode = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_\-=.:/]*$/, 'invalid_verification_code')
  .optional()
  .or(z.literal('').transform(() => undefined))
const seoWebmaster = z.object({
  google: verificationCode,
  bing: verificationCode,
  yandex: verificationCode,
  pinterest: verificationCode,
  baidu: verificationCode,
  naver: verificationCode,
})

// IndexNow (Bing/Yandex/Seznam/Naver — one ping, many engines). The
// key is a 8–128 char hex-ish token served at /{key}.txt; the admin UI
// auto-generates it on enable. `engines` selects which endpoints to
// ping (all consume the same key).
const seoIndexnow = z.object({
  enabled: z.boolean().default(false),
  key: z
    .string()
    .regex(/^[a-zA-Z0-9-]{8,128}$/, 'invalid_indexnow_key')
    .optional(),
  engines: z
    .array(z.enum(['indexnow', 'bing', 'yandex', 'seznam', 'naver']))
    .max(5)
    .default(['indexnow']),
  submitOnPublish: z.boolean().default(true),
})

// Google Indexing API service account. CREDENTIALED: the service
// account JSON is AES-256-GCM encrypted at rest (AAD_SEO_INDEXING_API)
// exactly like ai_config.apiKey, gated by step-up reauth on write, and
// never returned to the client. `serviceAccountEmail` is the only
// operator-visible record (display + "added as owner in GSC?" check).
// Officially Google restricts this API to JobPosting/BroadcastEvent
// pages — the UI states that; general indexing flows through sitemap + GSC.
const seoIndexingApi = z.object({
  enabled: z.boolean().default(false),
  serviceAccountJson: encryptedSecretSchema.nullable().optional(),
  serviceAccountEmail: z
    .string()
    .max(200)
    .email('must_be_email')
    .optional()
    .or(z.literal('').transform(() => undefined)),
})

// Operator additions to robots.txt. ADDITIVE ONLY — these lines are
// appended after the managed block; the security invariants (Disallow
// /api, the admin base, never leaking the login path) are always
// emitted by robots.ts regardless of this field. Defence in depth: the
// schema ALSO rejects directives that could re-open the protected set —
// no new `User-agent` group (would escape the managed group's
// Disallows), no `Allow:` that re-permits /admin or /api (robots.txt
// longest-match would override the managed Disallow), no operator-set
// `Sitemap:`/`Host:` (managed separately). So a hostile token/admin can
// widen restrictions but never narrow them, enforced at the input
// boundary AND re-asserted by robots.ts. Bounded to keep the file small.
const robotsExtraRules = z
  .string()
  .max(4000)
  .default('')
  .refine((txt) => {
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      // No new groups — extraRules must stay inside the managed
      // `User-agent: *` group so the managed Disallows always apply.
      if (/^user-agent\s*:/i.test(line)) return false
      // Sitemap + Host are emitted by the managed renderer.
      if (/^sitemap\s*:/i.test(line)) return false
      if (/^host\s*:/i.test(line)) return false
      // Cannot re-allow the protected admin/API surface.
      if (/^allow\s*:\s*\/(admin|api)\b/i.test(line)) return false
    }
    return true
  }, 'robots_extra_rules_must_be_additive')
const seoRobots = z.object({
  extraRules: robotsExtraRules,
})

// Content-analysis engine config (lib/seo/analysis). Thresholds are
// operator-tunable with battle-tested Yoast defaults; the engine reads
// these at analysis time. `locale` selects the rule pack (transition
// words / passive detection / syllable counting).
const seoAnalysis = z.object({
  enabled: z.boolean().default(true),
  locale: z.string().max(10).default('en'),
  seoAnalysisEnabled: z.boolean().default(true),
  readabilityEnabled: z.boolean().default(true),
  keyphraseDensityMin: z.number().min(0).max(10).default(0.5),
  keyphraseDensityMax: z.number().min(0).max(10).default(3),
  minWords: z.number().int().min(0).max(5000).default(300),
  cornerstoneMinWords: z.number().int().min(0).max(10000).default(900),
  fleschTarget: z.number().min(0).max(100).default(60),
  passiveMaxPct: z.number().min(0).max(100).default(10),
  transitionMinPct: z.number().min(0).max(100).default(30),
})
  // Cross-field guards — these bands feed the Phase-2 analysis engine,
  // which assumes min ≤ max. seo_analysis is token-writable, so without
  // these an inverted band could be persisted and break scoring for
  // every page. Enforce the invariant at the write boundary.
  .refine((d) => d.keyphraseDensityMin <= d.keyphraseDensityMax, {
    message: 'keyphrase_density_min_gt_max',
    path: ['keyphraseDensityMin'],
  })
  .refine((d) => d.minWords <= d.cornerstoneMinWords, {
    message: 'min_words_gt_cornerstone_min_words',
    path: ['minWords'],
  })

export const registry = {
  contact_info: {
    schema: contactInfo,
    default: {
      phone: '',
      email: 'info@example.com',
      address: '',
      hours: '',
    } satisfies z.infer<typeof contactInfo>,
  },
  social_links: {
    schema: socialLinks,
    default: [] as z.infer<typeof socialLinks>,
  },
  default_seo: {
    schema: defaultSeo,
    default: {
      title: '',
      description: '',
      ogImage: null,
      ogImagePath: null,
      favicon: null,
    } satisfies z.infer<typeof defaultSeo>,
  },
  footer: {
    schema: footer,
    default: {
      tagline: '',
      // Default dark footer — preserves the historic look. Operator
      // switches it under Settings → Footer to match a light site.
      theme: 'obsidian',
      // Empty footer columns by default — the welcome one-pager
      // doesn't have a /privacy or /terms page populated yet, so
      // pre-seeding the column produces dead links + dilutes the
      // operator's first impression. Operator wires up their own
      // columns under Settings → Footer when they're ready.
      columns: [],
      logo: null,
      logoMaxHeight: 48,
      newsletterHeading: 'Stay informed',
      newsletterBody: 'Updates and announcements. One click to unsubscribe.',
      newsletterCtaLabel: 'Subscribe',
      copyright: '',
      // Empty legalLinks by default. Operator adds Privacy / Terms
      // to the small-print strip when they've published those pages.
      legalLinks: [],
    } satisfies z.infer<typeof footer>,
  },
  site_header: {
    schema: siteHeader,
    default: {
      brandText: 'Your Site',
      logo: null,
      logoMaxHeight: 40,
      theme: 'cream',
      // Empty nav for the one-pager welcome template — the operator
      // wires up their own links (or section anchors) under
      // Settings → Branding after the install. Earlier defaults
      // shipped `Home/Projects/Services/About/Contact` which produced
      // RSC 500s on a fresh install because the system pages exist
      // but the operator hadn't yet customised their content.
      navItems: [],
      // No primaryCta on a fresh install — the welcome one-pager
      // doesn't need a "Get in touch" button until the operator has
      // configured their contact flow.
      primaryCta: null,
    } satisfies z.infer<typeof siteHeader>,
  },
  organization_json_ld: {
    schema: organizationJsonLd,
    default: {
      name: '',
      logo: null,
      sameAs: [],
    } satisfies z.infer<typeof organizationJsonLd>,
  },
  // ─── Security ───
  // Default seeded from env so a fresh deploy with no DB row still
  // resolves to the operator's configured LOGIN_PATH. Live edits
  // override.
  security_login_path: {
    schema: securityLoginPath,
    default: { path: env.LOGIN_PATH } satisfies z.infer<typeof securityLoginPath>,
  },
  security_recaptcha: {
    schema: securityRecaptcha,
    default: {
      enabled: false,
      enabledOnLogin: false,
      version: 'v3',
      minScore: 0.5,
    } satisfies z.infer<typeof securityRecaptcha>,
  },
  security_ip_lists: {
    schema: securityIpLists,
    default: {
      allowlist: { enabled: false, cidrs: [] },
      blocklist: { enabled: false, cidrs: [] },
    } satisfies z.infer<typeof securityIpLists>,
  },
  // Defaults mirror the current hardcoded values in
  // app/api/auth/login/route.ts so flipping the DB-backed reader on
  // with no DB row preserves today's behaviour.
  security_login_thresholds: {
    schema: securityLoginThresholds,
    default: {
      perIpLimit: 3,
      perIpWindowSec: 60,
      perEmailLimit: 5,
      perEmailWindowSec: 300,
    } satisfies z.infer<typeof securityLoginThresholds>,
  },
  security_maintenance: {
    schema: securityMaintenance,
    default: {
      enabled: false,
      message: 'Site under maintenance. Back shortly.',
      bypassIps: [],
    } satisfies z.infer<typeof securityMaintenance>,
  },
  security_suspicious_blocks: {
    schema: securitySuspiciousBlocks,
    default: {
      blockMissingUserAgent: false,
      blockBotUaPatterns: false,
      blockProbePaths: false,
    } satisfies z.infer<typeof securitySuspiciousBlocks>,
  },
  // ─── Integrations ─── (analytics/tracking/widget — non-credentialed)
  integrations_gtm: {
    schema: integrationsGtm,
    default: { enabled: false } satisfies z.infer<typeof integrationsGtm>,
  },
  integrations_ga4: {
    schema: integrationsGa4,
    default: { enabled: false, viaGtm: false } satisfies z.infer<typeof integrationsGa4>,
  },
  integrations_google_ads: {
    schema: integrationsGoogleAds,
    default: { enabled: false } satisfies z.infer<typeof integrationsGoogleAds>,
  },
  integrations_hotjar: {
    schema: integrationsHotjar,
    default: { enabled: false, snippetVersion: 6 } satisfies z.infer<typeof integrationsHotjar>,
  },
  integrations_zoho_salesiq: {
    schema: integrationsZohoSalesIq,
    default: { enabled: false, region: 'com' } satisfies z.infer<typeof integrationsZohoSalesIq>,
  },
  // ─── Integrations ─── (CRM — credentialed; gated by step-up reauth)
  integrations_hubspot: {
    schema: integrationsHubspot,
    default: { enabled: false, trackingEnabled: false } satisfies z.infer<typeof integrationsHubspot>,
  },
  integrations_zoho_crm: {
    schema: integrationsZohoCrm,
    default: { enabled: false, region: 'com', authMode: 'webform' } satisfies z.infer<typeof integrationsZohoCrm>,
  },
  // ─── Mobile CTA bar ───
  mobile_cta: {
    schema: mobileCta,
    default: { enabled: false, buttons: [] } satisfies z.infer<typeof mobileCta>,
  },
  // ─── Session + CSRF timeouts ───
  session_config: {
    schema: sessionConfig,
    default: {
      jwtTtlSec: 28800,
      jwtRenewAfterSec: 1800,
      jwtAbsoluteMaxSec: 86400,
      csrfTtlSec: 3600,
    } satisfies z.infer<typeof sessionConfig>,
  },
  // ─── Site identity ───
  site_general: {
    schema: siteGeneral,
    default: {} satisfies z.infer<typeof siteGeneral>,
  },
  // ─── Theme / brand palette ───
  theme_palette: {
    schema: themePalette,
    default: {
      mode: 'light',
      primary: '#050505',
      secondary: '#6E665A',
      accent: '#C9A961',
      surfaceDark: '#050505',
      surfaceLight: '#F5F1EA',
    } satisfies z.infer<typeof themePalette>,
  },
  // ─── Typography roles (Settings → Typography) ───
  typography_roles: {
    schema: typographyRoles,
    default: {
      display: TYPOGRAPHY_ROLES_DEFAULT.display,
      body: TYPOGRAPHY_ROLES_DEFAULT.body,
    } satisfies z.infer<typeof typographyRoles>,
  },
  // ─── Operator-uploaded custom fonts (managed by /api/admin/fonts) ───
  custom_fonts: {
    schema: customFonts,
    default: [] satisfies z.infer<typeof customFonts>,
  },
  // ─── Activated Google fonts (managed by /api/admin/fonts/google) ───
  // Operator picks from the ~1,934-family catalog; the server fetches the
  // woff2 ONCE and self-hosts it. Visitors never touch Google.
  google_fonts: {
    schema: googleFonts,
    default: [] satisfies z.infer<typeof googleFonts>,
  },
  // ─── Self-update preferences ───
  updates: {
    schema: updates,
    default: {
      autoApplySecurityPatches: true,
      autoDownload: true,
      checkFrequencyHours: 12,
    } satisfies z.infer<typeof updates>,
  },
  // Internal install-wizard state — not operator-editable, no UI.
  install_state: {
    schema: installState,
    default: {} satisfies z.infer<typeof installState>,
  },
  // Internal Updates state — not operator-editable, no Settings page.
  updates_state: {
    schema: updatesState,
    default: {} satisfies z.infer<typeof updatesState>,
  },
  // ─── Backup destinations + schedule ───
  backups: {
    schema: backups,
    default: {
      destination: 'local',
      keepLocalCopy: true,
      remoteRetention: 7,
      includeEnv: false,
      encryption: { passphraseEnabled: false },
      schedule: 'off',
      scheduleHour: 3,
      scheduleWeekday: 0,
      gdrive: { connected: false },
      onedrive: { connected: false },
    } satisfies z.infer<typeof backups>,
  },
  // Internal Backups state — device-flow pending + scheduler bookkeeping.
  backups_state: {
    schema: backupsState,
    default: {} satisfies z.infer<typeof backupsState>,
  },
  // ─── SMTP / outbound email ───
  smtp_config: {
    schema: smtpConfig,
    default: {
      enabled: false,
      port: 587,
      secure: false,
    } satisfies z.infer<typeof smtpConfig>,
  },
  // ─── AI Assistant (Gemini, BYOK) ───
  // Default row carries no model picks — operator MUST select before
  // turning AI on. The refines on the schema enforce this at save time;
  // the row sits with empty `models` until then.
  ai_config: {
    schema: aiConfig,
    default: {
      enabled: false,
      provider: 'gemini',
      inlineEnabled: false,
      chatEnabled: false,
      voicePreset: 'default',
    } satisfies z.infer<typeof aiConfig>,
  },
  // ─── SEO Suite ───
  seo_titles: {
    schema: seoTitles,
    default: {
      separator: '–',
      home: { title: '%sitename%', description: '%sitedesc%' },
      page: { title: '%title% %sep% %sitename%', description: '%excerpt%' },
      post: { title: '%title% %sep% %sitename%', description: '%excerpt%' },
      project: { title: '%title% %sep% %sitename%', description: '%excerpt%' },
      blogIndex: { title: '%title% %sep% %sitename%', description: '%sitedesc%' },
      projectsIndex: { title: '%title% %sep% %sitename%', description: '%sitedesc%' },
    } satisfies z.infer<typeof seoTitles>,
  },
  seo_indexing: {
    schema: seoIndexing,
    default: {
      discourageSearchEngines: false,
      noindexSearch: true,
      noindexPaginated: false,
    } satisfies z.infer<typeof seoIndexing>,
  },
  seo_social: {
    schema: seoSocial,
    default: {
      twitterCard: 'summary_large_image',
      ogLocale: 'en_US',
    } satisfies z.infer<typeof seoSocial>,
  },
  seo_schema: {
    schema: seoSchema,
    default: {
      entityType: 'Organization',
      breadcrumbsEnabled: true,
      articleType: 'BlogPosting',
      websiteSearchAction: false,
    } satisfies z.infer<typeof seoSchema>,
  },
  seo_sitemap: {
    schema: seoSitemap,
    default: {
      enabled: true,
      includePages: true,
      includePosts: true,
      includeProjects: true,
      includeImages: true,
      excludeNoindex: true,
    } satisfies z.infer<typeof seoSitemap>,
  },
  seo_webmaster: {
    schema: seoWebmaster,
    default: {} satisfies z.infer<typeof seoWebmaster>,
  },
  seo_indexnow: {
    schema: seoIndexnow,
    default: {
      enabled: false,
      engines: ['indexnow'],
      submitOnPublish: true,
    } satisfies z.infer<typeof seoIndexnow>,
  },
  seo_indexing_api: {
    schema: seoIndexingApi,
    default: { enabled: false } satisfies z.infer<typeof seoIndexingApi>,
  },
  seo_robots: {
    schema: seoRobots,
    default: { extraRules: '' } satisfies z.infer<typeof seoRobots>,
  },
  seo_analysis: {
    schema: seoAnalysis,
    default: {
      enabled: true,
      locale: 'en',
      seoAnalysisEnabled: true,
      readabilityEnabled: true,
      keyphraseDensityMin: 0.5,
      keyphraseDensityMax: 3,
      minWords: 300,
      cornerstoneMinWords: 900,
      fleschTarget: 60,
      passiveMaxPct: 10,
      transitionMinPct: 30,
    } satisfies z.infer<typeof seoAnalysis>,
  },
} as const

// MOBILE_CTA_ICONS is canonically exported from @/lib/cms/mobileCtaIcons
// so client + server can both consume without server-only contamination.

export type SettingsKey = keyof typeof registry
export type SettingsValue<K extends SettingsKey> = z.infer<
  typeof registry[K]['schema']
>
