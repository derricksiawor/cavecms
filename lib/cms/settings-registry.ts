import 'server-only'
import { z } from 'zod'
import { env } from '@/lib/env'
import { RESERVED } from '@/lib/cms/page-slug'
import { parseCidr } from '@/lib/security/ipMatch'
import { MOBILE_CTA_ICONS } from '@/lib/cms/mobileCtaIcons'

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
//   - tel:+233241234567 (digits, plus, dashes, spaces, parens)
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
  // Optional path served by next/image — null when no global OG image
  // is configured (per-entity fallbacks live in projects.og_image_id /
  // posts.og_image_id). Either a same-origin path (starts with /) or
  // an https URL.
  ogImagePath: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine(
      (u) => u == null || /^(?:https?:\/\/|\/[^/])/i.test(u),
      'must_be_https_or_same_origin_path',
    ),
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

const footer = z.object({
  tagline: z.string().max(220),
  columns: z
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
  // Optional footer logo override. When null, the footer falls back
  // to the header logo (or brand text). Lets the operator use a
  // lighter wordmark on the dark footer if the dark logo doesn't read
  // on cream.
  logo: mediaRef.nullable().optional(),
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

const siteHeader = z.object({
  // Brand text shown next to (or in place of) the logo.
  brandText: z.string().max(120),
  // Optional uploaded logo. When null, the header falls back to brandText.
  logo: mediaRef.nullable(),
  // Visual theme — see headerTheme above.
  theme: headerTheme,
  // Primary navigation links shown in the top bar. Capped at 6 per
  // operator request — keeps the bar from wrapping and forces editorial
  // discipline.
  navItems: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        href: siteLink,
      }),
    )
    .max(6),
  // Single primary call-to-action button. Either field empty → the
  // public renderer hides the button entirely.
  primaryCta: ctaRef,
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
  // logoUrl accepts same-origin path (default '/brand/logo.svg') or
  // an https URL. organizationLd() rewrites same-origin paths to
  // absolute by prefixing SITE_ORIGIN at emit time.
  logoUrl: z
    .string()
    .max(500)
    .refine(
      (u) => /^(?:https?:\/\/|\/[^/])/i.test(u),
      'must_be_https_or_same_origin_path',
    ),
  foundingDate: z.string().max(40).optional(),
  sameAs: z.array(HttpsUrl).max(20).optional(),
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
      title: 'Best World Properties',
      description: '',
      ogImagePath: null,
    } satisfies z.infer<typeof defaultSeo>,
  },
  footer: {
    schema: footer,
    default: {
      tagline: '',
      // A single "Legal" column rendered in the 3rd grid slot, directly
      // beside the "Stay informed" newsletter block. Privacy + Terms
      // also appear in the small-print strip at the bottom (legalLinks
      // below) — the column placement makes them visible higher in
      // the footer for visitors who never scroll into the fine print,
      // which is the public-trust + GDPR/DPA standard pattern.
      columns: [
        {
          label: 'Legal',
          links: [
            { text: 'Privacy Policy', href: '/privacy' },
            { text: 'Terms of Service', href: '/terms' },
          ],
        },
      ],
      logo: null,
      newsletterHeading: 'Stay informed',
      newsletterBody: 'Quarterly updates on new launches and project milestones. One click to unsubscribe.',
      newsletterCtaLabel: 'Subscribe',
      copyright: '',
      legalLinks: [
        { text: 'Privacy', href: '/privacy' },
        { text: 'Terms', href: '/terms' },
      ],
    } satisfies z.infer<typeof footer>,
  },
  site_header: {
    schema: siteHeader,
    default: {
      brandText: 'Best World Properties',
      logo: null,
      theme: 'cream',
      navItems: [
        { label: 'Home', href: '/' },
        { label: 'Projects', href: '/projects' },
        { label: 'Services', href: '/services' },
        { label: 'About', href: '/about' },
        { label: 'Contact', href: '/contact' },
      ],
      primaryCta: { text: 'Schedule a tour', href: '/contact' },
    } satisfies z.infer<typeof siteHeader>,
  },
  organization_json_ld: {
    schema: organizationJsonLd,
    default: {
      name: 'Best World Properties',
      logoUrl: '/brand/logo.svg',
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
} as const

// MOBILE_CTA_ICONS is canonically exported from @/lib/cms/mobileCtaIcons
// so client + server can both consume without server-only contamination.

export type SettingsKey = keyof typeof registry
export type SettingsValue<K extends SettingsKey> = z.infer<
  typeof registry[K]['schema']
>
