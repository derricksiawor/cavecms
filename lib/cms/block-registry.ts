import 'server-only'
import { z } from 'zod'
import { TEXT_MAX } from './limits'
// parseVideoEmbedUrl is unused after the legacy purge — the lx_video
// schema uses its own isValidVideoUrl gate. Kept removed (no import).
import { parseStrictHttpsUrl } from './url-guard'
import { HEX_COLOR_RE } from './designTokens'
import { BLOCK_TONE_ENUMS } from './blockTones'
import { isAllowedEmbedUrl } from './embedHosts'

// ─── Picker-aware colour schema helper ──────────────────────────────
// Block tone/color fields used to accept a strict enum of design-system
// token names ('obsidian', 'ivory', …). The Elementor-parity picker
// (see components/inline-edit/pickers/ColorPicker.tsx) emits EITHER a
// token name OR a raw hex string ('#C9A961' / '#C9A96180'). The
// `colorTokenOrHex` helper widens the schema to the union so the
// picker's two-affordance pattern (globe = bound token, swatch =
// ad-hoc colour) round-trips through Zod validation.
//
// resolveColorValue() in designTokens.ts is the canonical render-time
// resolver — token names emit `var(--color-…)`, hex strings emit raw.
const colorTokenOrHex = <T extends readonly [string, ...string[]]>(
  tokens: T,
) =>
  z.union([
    z.enum(tokens),
    z.string().regex(HEX_COLOR_RE, 'invalid_hex_color'),
  ])

// Font-family and font-weight tokens shared across every typography
// block. These are optional `family`/`weight` props that, when set,
// override the renderer's defaults. Clearing reverts to the block's
// hard-coded baseline (e.g. lx_heading defaults to display + bold).
const fontFamilyToken = z.enum(['display', 'body']).optional()
const fontWeightToken = z
  .enum(['regular', 'medium', 'semibold', 'bold', 'black'])
  .optional()

// Cross-field refine for typography blocks: when both `family` and
// `weight` are set, the chosen weight must be in the family's
// `shippedWeights` list (Body ships up to bold; Display ships through
// black). Without this, a payload with `{family:'body', weight:'black'}`
// would survive validation and the browser would render faux-bold —
// a brand-quality regression. Picker UI greys out the bad combinations
// (FontWeightPicker), but the schema is the authoritative gate.
//
// Implemented as a helper that wraps any z.object so the renderers'
// optional family/weight props get the refine without re-typing it
// per-schema. Imports FONT_FAMILY_TOKENS from designTokens (TS-only,
// safe to import server-side — no DOM access).
import { FONT_FAMILY_TOKENS } from './designTokens'
function refineFamilyWeight<S extends z.ZodObject<z.ZodRawShape>>(schema: S): S {
  return schema.refine(
    (d) => {
      const o = d as { family?: 'display' | 'body'; weight?: 'regular' | 'medium' | 'semibold' | 'bold' | 'black' }
      if (!o.family || !o.weight) return true
      const shipped = FONT_FAMILY_TOKENS[o.family].shippedWeights
      return (shipped as ReadonlyArray<string>).includes(o.weight)
    },
    { message: 'weight_not_shipped_by_family' },
  ) as unknown as S
}

// ─── Icon name schema — for picker-emitted Lucide kebab names ───────
// Constraints:
//   - Kebab-case ASCII only ([a-z][a-z0-9-]*)
//   - Length capped (TEXT_MAX.icon)
//   - Rejects bidi-override + zero-width chars (defence-in-depth even
//     though the regex already excludes them — explicit fail-fast).
// This locks the field to what the IconPicker actually emits + what
// the legacy amenity-key registry uses (also kebab-ASCII), while
// blocking smuggled Unicode that could spoof the icon name in editor
// previews.
const ICON_NAME_RE = /^[a-z][a-z0-9-]{0,59}$/
const iconName = z
  .string()
  .max(TEXT_MAX.icon)
  .regex(ICON_NAME_RE, 'invalid_icon_name')
  .refine(isSafeDisplayText, 'bidi_chars_forbidden')

// Reusable atoms.
//
// MediaRef binds a media row (via media_id) to a string alt — alt is
// REQUIRED at the schema layer because a11y compliance is non-negotiable
// in the master spec §4.1. The DOMPurify sanitizer runs on `body_richtext`
// fields one layer up (see parse.ts) — alt is plain text, no sanitization
// needed.
const MediaRef = z.object({
  media_id: z.number().int().positive(),
  alt: z.string().max(TEXT_MAX.short),
})

// CTA hrefs are rendered raw by the page renderer — not inside body_richtext
// — so DOMPurify never sees them. URI allow-list at the parse boundary is
// the ONLY defense. Matches sanitize.ts ALLOWED_URI_REGEXP plus same-origin
// paths (e.g. /contact). Rejected:
//   - bare '/' or '/<no-second-char>'  (open redirect when relative-resolved)
//   - '//evil.com'  (protocol-relative — the second '/' anchors cross-origin)
//   - '/\evil.com'  (backslash — WHATWG URL spec § 4.4.3 normalises backslash
//                    to forward slash in special-scheme URLs, so /\evil.com
//                    resolves to https://evil.com on the public site)
//   - 'https:foo'   (missing '//' — some browsers treat this as path-absolute
//                    while others treat as same-origin — ambiguous, reject)
//   - 'javascript:', 'data:', 'vbscript:', 'file:', 'ftp:' (scheme not in
//                    the explicit allowlist)
const CTA_HREF_RE = /^(?:https?:\/\/|mailto:|tel:|\/[^/\\])/i

// ─── Display-text safety helpers ────────────────────────────────────
// Reject Unicode bidi-control + zero-width characters in operator-
// controlled display strings. These can be used to visually spoof
// legitimate content (e.g., U+202E RIGHT-TO-LEFT OVERRIDE flips
// "evil.com" to render as "moc.live") OR to hide content from review
// (zero-width characters invisible to the operator but break exact
// match comparisons). Applied at the Zod refine layer for every lx_*
// operator-controlled text field.
const BIDI_OR_ZWS_RE = /[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/
function isSafeDisplayText(s: string): boolean {
  return !BIDI_OR_ZWS_RE.test(s)
}
const safeText = (max: number) =>
  z.string().max(max).refine(isSafeDisplayText, 'bidi_chars_forbidden')
const safeRequiredText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(isSafeDisplayText, 'bidi_chars_forbidden')

// ─── CTA href safety helpers ────────────────────────────────────────
// Reject control characters (U+0000-U+001F, U+007F) + backslash + any
// leading/trailing whitespace. WHATWG URL spec strips TAB/LF/CR from
// hrefs before parsing, so `/<TAB>/evil.com` passes the CTA_HREF_RE
// regex (TAB satisfies `[^/\\]`) but the browser resolves it as
// `//evil.com` → cross-origin redirect. Pre-checking via this refine
// closes that bypass class entirely. Trim equality also rejects
// leading/trailing spaces operators may paste from copied URLs.
const HREF_UNSAFE_CHAR_RE = /[\u0000-\u001F\u007F\\]/
function isSafeCtaHref(s: string): boolean {
  // Step 1 — char-class gate: control chars + DEL + backslash.
  if (HREF_UNSAFE_CHAR_RE.test(s)) return false
  // Step 2 — trim equality rejects leading/trailing whitespace.
  if (s !== s.trim()) return false
  // Step 3 — reject embedded spaces (WHATWG URL parses them as
  // %20-in-host or fails, neither legitimate for an editorial CTA).
  if (s.includes(' ')) return false
  // Step 4 — for http(s) schemes, parse the URL and reject userinfo.
  // `https://attacker@trusted-looking.com` reads as trusted but
  // navigates to attacker. The legacy SocialIcons gate
  // (parseStrictHttpsUrl) already enforces this; CTA hrefs now match.
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      if (u.username || u.password) return false
    } catch {
      return false
    }
  }
  return true
}
// Chain order matters: .regex returns ZodString (still chainable),
// .refine returns ZodEffects (no .regex method). So .regex comes
// BEFORE .refine. Result type infers to `string` either way.
//
// `safeCtaHref` is for required href fields (.min(1)).
// `safeCtaHrefOptional` is for fields wrapped in .optional() at the
// caller — it OMITS .min(1) so the helper schema accepts whatever
// the regex demands (non-empty). Empty string still fails the regex,
// so the only "optional" behaviour comes from the caller's .optional()
// (treats missing/undefined as valid; never accepts '').
const safeCtaHref = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(CTA_HREF_RE, 'href_scheme_not_allowed')
    .refine(isSafeCtaHref, 'href_contains_unsafe_chars')
const safeCtaHrefOptional = (max: number) =>
  z
    .string()
    .max(max)
    .regex(CTA_HREF_RE, 'href_scheme_not_allowed')
    .refine(isSafeCtaHref, 'href_contains_unsafe_chars')

// SocialIcons URL gate. Stricter than CTA_HREF_RE because social
// profile URLs are always external HTTPS - they're never relative
// isValidSocialUrl was the legacy social_icons URL gate — removed
// after the legacy purge. lx_social_icons uses safeCtaHref directly.

// Google Maps embed URL gate. Operators paste from Google Maps
// "Share → Embed a map" (canonical: https://www.google.com/maps/embed?pb=...)
// or the legacy keyless variant (?q=...&output=embed) on either
// www.google.com or maps.google.com. Everything else — including
// google.com (no www), HTTP, or any other host — is rejected.
// Middleware CSP frame-src must include both hosts for the iframe to
// render; the gate here is the input boundary.
// YouTube + Vimeo share-URL validator for lx_video. Accepts the
// canonical share forms the operator pastes:
//   YouTube  — https://www.youtube.com/watch?v=ID, https://youtu.be/ID,
//              https://www.youtube.com/embed/ID
//   Vimeo    — https://vimeo.com/ID, https://player.vimeo.com/video/ID
// Anything else rejects at the write boundary — the renderer never has
// to defend against arbitrary iframe sources. ID format is conservative:
// YouTube 11-char URL-safe base64, Vimeo positive integers.
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/
const VIMEO_ID_RE = /^\d{1,12}$/
function isValidVideoUrl(s: string): boolean {
  const url = parseStrictHttpsUrl(s)
  if (!url) return false
  if (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') {
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v')
      return !!v && YT_ID_RE.test(v)
    }
    if (url.pathname.startsWith('/embed/')) {
      return YT_ID_RE.test(url.pathname.slice('/embed/'.length))
    }
    return false
  }
  if (url.hostname === 'youtu.be') {
    return YT_ID_RE.test(url.pathname.slice(1))
  }
  if (url.hostname === 'vimeo.com') {
    return VIMEO_ID_RE.test(url.pathname.slice(1))
  }
  if (url.hostname === 'player.vimeo.com') {
    return (
      url.pathname.startsWith('/video/') &&
      VIMEO_ID_RE.test(url.pathname.slice('/video/'.length))
    )
  }
  return false
}

export function isValidMapEmbedUrl(s: string): boolean {
  const url = parseStrictHttpsUrl(s)
  if (!url) return false
  // Form 1 — operator pastes from the share dialog. `pb` is an opaque
  // protobuf token. Length/charset already capped by TEXT_MAX.url +
  // parseStrictHttpsUrl's control-char gate.
  if (
    url.hostname === 'www.google.com' &&
    url.pathname === '/maps/embed' &&
    url.searchParams.has('pb')
  ) {
    return true
  }
  // Form 2 — keyless legacy embed. Accept on either Google host.
  if (
    (url.hostname === 'maps.google.com' || url.hostname === 'www.google.com') &&
    url.pathname === '/maps' &&
    url.searchParams.get('output') === 'embed'
  ) {
    return true
  }
  return false
}
// The legacy Cta inline schema was used by legacy `hero`/`cta`
// block_types — both deleted in the legacy purge. lx_action and
// lx_cta_banner build their own CTA objects inline now.


// Block-type registry. Adding a new block:
//  1. add a schema here
//  2. update FIXED_BLOCK_KEYS_PER_PAGE if it's a fixed-slot template block
//  3. update lib/cms/parse.ts RICHTEXT_FIELDS if it carries free-form HTML
//  4. update the renderer
//
// Anything walking blocks (hydrate, collectMediaPaths, audit) is fully
// generic over block_type — only the parser cares about shape.
// Per-instance CRM destination array for the contact_form widget.
// Exported separately so the dispatch path (lib/crm/dispatch.ts) can
// re-validate block.data.crmDestinations at READ time — Zod-validation
// at save is the trust boundary, but a hand-edited content_blocks row
// / restored backup / future-schema-drift could otherwise leak unknown
// keys (notably webformAuthToken) into the dispatcher. Strict shape
// here strips them.
export const contactFormCrmDestinationsSchema = z
  .array(
    z.discriminatedUnion('provider', [
      z.object({
        provider: z.literal('hubspot'),
        formId: z.string().uuid(),
        fieldMap: z.record(z.string().max(60), z.string().max(120))
          .refine((m) => Object.keys(m).length <= 40, 'too_many_field_mappings'),
        listIds: z.array(z.number().int().positive()).max(10).optional(),
      }).strict(),
      z.object({
        provider: z.literal('zoho'),
        module: z.enum(['Leads', 'Contacts', 'Deals']),
        mode: z.enum(['webform', 'oauth']),
        fieldMap: z.record(z.string().max(60), z.string().max(120))
          .refine((m) => Object.keys(m).length <= 40, 'too_many_field_mappings'),
        assignmentRuleId: z.string().max(40).optional(),
      }).strict(),
    ]),
  )
  .max(4)

export const blockSchemas = {
  // Contact form widget. Submission goes to /api/leads/contact unchanged
  // (honeypot + reCAPTCHA + neutral-200 pipeline). The block carries only
  // the COPY around the form fields — heading above the form, optional
  // intro paragraph, submit button label, and the success-panel copy that
  // replaces the form after a successful submit. The fields (name/email/
  // phone/message) are fixed by the lead route's schema; an operator who
  // needs different fields would clone the lead route + add a new block
  // type (Phase 2).
  //
  // .min(1) on `heading` and `submit_label` so inline-edit clearing the
  // field surfaces as 422 → InlineEditable.commit() reverts cleanly. The
  // form is a fixed-slot block on the Contact system page (see
  // FIXED_BLOCK_KEYS_PER_PAGE) — block_key='contact_form' is non-null and
  // the row resists hard delete.
  contact_form: z.object({
    heading: z.string().min(1).max(TEXT_MAX.title),
    intro: z.string().max(TEXT_MAX.body).optional(),
    submit_label: z.string().min(1).max(TEXT_MAX.ctaText),
    success_headline: z.string().max(TEXT_MAX.title).optional(),
    success_body: z.string().max(TEXT_MAX.body).optional(),
    // Optional per-instance CRM destinations. Overrides the
    // integrations_{hubspot,zoho_crm}.formSourceMap.contact default
    // for THIS block instance. Lets the operator wire one page's
    // contact form to a different HubSpot form / Zoho module than
    // the site-wide default (e.g., per-region or per-campaign
    // routing). The block PATCH route validates this against the
    // schema; the form submit handler reads block.data.crmDestinations
    // when present and falls back to the integrations setting
    // otherwise. Cap of 4 prevents pathological multi-CRM fan-out.
    //
    // Discriminated union on provider so a HubSpot destination
    // can never be saved with Zoho fields and vice-versa (Zod's
    // discriminatedUnion validates the discriminator before the
    // branch fields — surfaces a clearer error than an open union).
    // Webform tokens (Zoho xnQsjsdp) are NOT permitted on block.data
    // — they would bypass the step-up reauth gate that protects the
    // integrations_zoho_crm settings row, and the block render path
    // returns raw data JSON to the admin browser. Per-instance webform
    // dispatch borrows the per-source token from
    // integrations_zoho_crm.formSourceMap.contact at dispatch time
    // (see lib/crm/dispatch.ts enrichBlockDest).
    crmDestinations: contactFormCrmDestinationsSchema.optional(),
  }),

  // ════════════════════════════════════════════════════════════════
  // LUXURY REDESIGN — lx_* widget primitives.
  //
  // Black + gold editorial system. Coexists with the legacy widget
  // schemas above during the page-by-page migration starting from
  // /contact. Operator-facing palette hides legacy types via the
  // LEGACY_BLOCK_TYPES gate in blockSeeds.ts; only lx_* widgets show
  // in /slash + ⌘K + InsertBlockHere going forward.
  //
  // Token vocabularies are defined in lib/cms/designTokens.ts; the
  // Zod enums below mirror those literal unions. Adding a brand token
  // requires updating BOTH files (the designTokens picker metadata
  // AND the Zod enum here).
  //
  // Renderers live at components/blocks/Lx*/render.tsx. The dispatcher
  // (components/blocks/index.tsx defineRenderers) ties them together
  // — adding a new lx_* schema requires a matching renderer entry or
  // tsc fails at the BLOCK_RENDERERS map declaration.
  // ════════════════════════════════════════════════════════════════

  // Luxury display heading. Fraunces serif, editorial type scale.
  // `tone` is restricted to obsidian / ivory / champagne — bone +
  // warm-stone are too low-contrast for headings. `animation` opts
  // into the line-reveal stagger; on lone hero headings this is the
  // signature luxury motion, but stacked headings (3+ on one page
  // all animating) feel busy — keep default 'none' and let the
  // operator opt in per instance.
  lx_heading: refineFamilyWeight(
    z.object({
      text: safeRequiredText(1, TEXT_MAX.title),
      level: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']).default('h2'),
      size: z
        .enum(['display-2xl', 'display-xl', 'display-lg', 'display-md', 'display-sm'])
        .default('display-lg'),
      alignment: z.enum(['left', 'center', 'right']).default('left'),
      tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_heading).default('obsidian'),
      italic: z.boolean().default(false),
      // Optional typography overrides. Default = renderer's hard-coded
      // baseline (display family + bold). Operator opts in via the
      // Elementor-parity font pickers in the EditDrawer. Cross-field
      // refine on the wrapper enforces weight ∈ family.shippedWeights.
      family: fontFamilyToken,
      weight: fontWeightToken,
      animation: z
        .enum(['none', 'fade-in', 'slide-up', 'line-reveal'])
        .default('none'),
    }),
  ),

  // Luxury body text. Inter sans, generous leading, max-width tuned
  // for editorial readability. Carries `body_richtext` (sanitized via
  // RICHTEXT_FIELDS in parse.ts — same allowlist as the legacy `text`
  // widget). `maxWidth` controls measure: narrow (45ch) for centered
  // editorial paragraphs, medium (60ch, default), wide (75ch), full
  // (no max). Justified alignment is intentionally excluded — on the
  // web, justified text creates rivers and is an a11y liability.
  lx_text: refineFamilyWeight(
    z.object({
      body_richtext: z.string().max(TEXT_MAX.richtextLong),
      size: z.enum(['body-lg', 'body-md', 'body-sm']).default('body-md'),
      alignment: z.enum(['left', 'center']).default('left'),
      tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_text).default('obsidian'),
      family: fontFamilyToken,
      weight: fontWeightToken,
      maxWidth: z.enum(['narrow', 'medium', 'wide', 'full']).default('medium'),
      animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
    }),
  ),

  // Luxury eyebrow / kicker. Small uppercase tracking-wide label that
  // sits above a hero h1 or section h2. Optional gold-rule prefix
  // (a thin champagne hairline that animates in left-to-right when
  // animation: 'gold-rule' is set). Renders <p> — NOT a heading
  // element — because semantically it's a label.
  lx_eyebrow: z.object({
    text: safeRequiredText(1, TEXT_MAX.caption),
    prefix: z.enum(['rule', 'none']).default('none'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_eyebrow).default('champagne'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
    weight: fontWeightToken,
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Luxury CTA action. Variants: primary-gold (champagne fill on
  // obsidian text), secondary-outline (gold outline on transparent),
  // ghost (no chrome, type only), link-arrow (text + animated arrow).
  // The animation: 'magnetic' opt-in attaches the cursor-follow
  // pointer behaviour for buttons that warrant it (the canonical
  // single hero CTA, not 12 magnetic CTAs on a page).
  lx_action: z.object({
    label: safeRequiredText(1, TEXT_MAX.ctaText),
    href: safeCtaHref(TEXT_MAX.url),
    openInNew: z.boolean().default(false),
    variant: z
      .enum(['primary-gold', 'secondary-outline', 'ghost', 'link-arrow'])
      .default('primary-gold'),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
    animation: z.enum(['none', 'fade-in', 'slide-up', 'magnetic']).default('none'),
  }),

  // Luxury figure (image with optional caption + parallax + overlay).
  // Image required via MediaRef (media_id + alt at the schema layer
  // — a11y compliance is non-negotiable). Ratio enum covers the
  // editorial aspect-ratio set: 21:9 cinematic, 16:9 standard, 4:5
  // editorial portrait, 1:1 square. Corners default 'sharp' — luxury
  // brands lean architectural; rounded photo corners read as casual.
  // goldOverlay adds a soft champagne gradient over the image for
  // brand cohesion on contact / hero placements.
  lx_figure: z.object({
    image: MediaRef,
    ratio: z.enum(['21:9', '16:9', '4:5', '1:1']).default('16:9'),
    fit: z.enum(['cover', 'contain']).default('cover'),
    caption: safeText(TEXT_MAX.short).optional(),
    goldOverlay: z.boolean().default(false),
    corners: z.enum(['sharp', 'soft']).default('sharp'),
    animation: z.enum(['none', 'fade-in', 'slide-up', 'parallax']).default('none'),
  }),

  // Luxury map embed. Google Maps iframe at one of two URL shapes
  // (see isValidMapEmbedUrl above). Visual treatment matches lx_figure:
  // always rounded-2xl (no borders per ~/.claude/CLAUDE.md), optional
  // champagne overlay for brand cohesion, editorial aspect-ratio set.
  // Iframe sandboxed (allow-scripts allow-same-origin allow-popups);
  // referrer policy tight. Title attribute uses caption if present
  // else a generic "Map" label so screen readers always get a name.
  lx_map: z.object({
    embedUrl: z
      .string()
      .min(1)
      .max(TEXT_MAX.url)
      .refine(isValidMapEmbedUrl, 'invalid_map_embed_url'),
    // 'fill' drops the fixed aspect-ratio + the editorial vertical
    // padding and stretches the map to fill its container's height
    // (h-full, with a min-height floor) — for a side-by-side column where
    // the map should match the height of the content beside it rather
    // than read as a squat fixed-ratio strip.
    ratio: z.enum(['21:9', '16:9', '4:5', '1:1', 'fill']).default('16:9'),
    caption: safeText(TEXT_MAX.short).optional(),
    goldOverlay: z.boolean().default(false),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Luxury cover image — full-bleed hero photo, edge-to-edge across
  // the viewport (breaks out of any centred section container via
  // `w-screen` + negative-margin trick). object-fit: cover so the
  // photo fills the frame regardless of aspect mismatch.
  //
  // The block carries its own min-height (no, sm, md, lg, xl, screen)
  // and aspect ratio enum so an operator can dial in cinematic 21:9
  // hero strips OR full-viewport-height immersive covers. Overlay enum
  // tints the photo for foreground-text legibility — pages that lay a
  // heading on top of the hero should pick `darken` or `gradient-bottom`.
  //
  // Animation is opt-in `parallax` (image scales across viewport on
  // scroll) for the marquee hero on a landing page; defaults to
  // 'fade-in' so the entrance reads composed.
  lx_cover_image: z.object({
    image: MediaRef,
    ratio: z
      .enum(['21:9', '16:9', '4:3', '3:2', '4:5', 'auto'])
      .default('21:9'),
    minHeight: z
      .enum(['none', 'sm', 'md', 'lg', 'xl', 'screen'])
      .default('lg'),
    // none = ratio alone drives height; sm=320, md=420, lg=540, xl=680, screen=100vh
    overlay: z
      .enum(['none', 'darken', 'darken-strong', 'gradient-bottom', 'champagne'])
      .default('none'),
    animation: z
      .enum(['none', 'fade-in', 'parallax'])
      .default('fade-in'),
    // Optional text overlay — turns a pure-image cover into a hero
    // with title + eyebrow + body + CTA on top of the photo. All four
    // are optional; renderer skips the overlay layer entirely when
    // every text field is empty AND no cta is set. Alignment controls
    // where the overlay block sits (corner anchoring matches the
    // editorial hero variants on luxury hotel + restaurant sites).
    eyebrow: safeText(TEXT_MAX.caption).default(''),
    title: safeText(TEXT_MAX.title).default(''),
    body: safeText(TEXT_MAX.body).default(''),
    cta: z
      .object({
        label: safeRequiredText(1, TEXT_MAX.ctaText),
        href: safeCtaHref(TEXT_MAX.url),
      })
      .nullable()
      .default(null),
    overlayAlignment: z
      .enum(['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'])
      .default('bottom-left'),
    overlayTone: z.enum(['ivory', 'obsidian']).default('ivory'),
  }),

  // Luxury image pair — two photos in a staggered overlap composition.
  // The signature "layered images" treatment seen on the source site's
  // marketing pages: one photo lifts above the column baseline, the
  // other tucks underneath with a horizontal overlap so the two read
  // as a composed pair rather than a tiled gallery.
  //
  // `layout` controls which side lifts higher (left or right);
  // `overlap` is the horizontal pull-in between the two images
  // (-mr/-ml in the renderer). `ratio` is shared between both images
  // so the composition stays balanced — uneven aspects would tilt the
  // baseline and read as broken. Animation drives the entrance reveal
  // when the section scrolls into view.
  //
  // Both images are required (no nullable / optional fallback) — the
  // block has no meaningful "half-empty" state. A missing media row
  // surfaces the same champagne-glow placeholder lx_figure uses, so
  // operators see "Image missing" rather than a broken layout.
  lx_image_pair: z.object({
    leftImage: MediaRef,
    rightImage: MediaRef,
    layout: z.enum(['lift-left', 'lift-right']).default('lift-left'),
    overlap: z.enum(['sm', 'md', 'lg']).default('md'),
    ratio: z.enum(['3:4', '4:5', '1:1']).default('4:5'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('fade-in'),
  }),

  // lx_rule REMOVED — ~/.claude/CLAUDE.md design preference is
  // explicit: "No borders/border lines." Hairlines (any visible
  // separator line) violate the aesthetic. Visual breaks now come
  // from section padding + gradient-blur depth, not from rules.

  // Luxury vertical spacer. Sizes drawn from the editorial spacing
  // scale (--spacing-section-* in globals.css, mirror of SpacingToken
  // in designTokens.ts). Renders an aria-hidden div with computed
  // height — no semantic content. Use sparingly inside sections;
  // section padding handles most rhythm naturally.
  lx_space: z.object({
    size: z
      .enum([
        'section-xs',
        'section-sm',
        'section-md',
        'section-lg',
        'section-xl',
        'section-2xl',
      ])
      .default('section-md'),
  }),

  // ─── Composite widgets ──────────────────────────────────────────
  // One level above primitives — pre-arranged compositions that solve
  // a specific marketing need (a contact tile, an animated stat, an
  // editorial quote). Operators drop ONE widget instead of composing
  // 3-4 primitives by hand, and the visual treatment stays brand-
  // consistent across instances.
  // ────────────────────────────────────────────────────────────────

  // Luxury channel card. A bordered tile with a small kicker label,
  // an icon, the display value (phone/email/address), an optional
  // supporting description, and an optional action link. Used on the
  // contact page's "Direct channels" column; also generalises to any
  // "ways to reach us" or "where to find us" 3-up section.
  //
  // icon is a Lucide name resolved via iconForAmenity (the shared
  // icon registry). Unknown names fall back to a neutral checkmark
  // — the registry never throws.
  lx_channel_card: z.object({
    // value carries operator-controlled PII (phone, email, address).
    // safeRequiredText rejects bidi-override + zero-width characters
    // that could spoof display content (e.g. U+202E flips visible
    // text). Same gate on label + description for defence in depth.
    // href passes the full CTA href gate (safeCtaHrefOptional adds
    // control-char + whitespace + backslash refine on top of the
    // scheme regex).
    label: safeRequiredText(1, TEXT_MAX.caption),
    value: safeRequiredText(1, TEXT_MAX.caption),
    description: safeText(TEXT_MAX.body).optional(),
    href: safeCtaHrefOptional(TEXT_MAX.url).optional(),
    icon: iconName.optional(),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_channel_card).default('obsidian'),
  }),

  // Luxury animated stat — single number with a label. Count-up
  // animation on viewport entry via the useCountUp hook (which short-
  // circuits to the final value when prefers-reduced-motion is set
  // or duration_ms is 0).
  //
  // `decimals` controls fractional precision. Default 0 = integer
  // count-up (Math.round per tick). decimals=1 fits ratings like
  // 4.5; decimals=2 fits percentages like 12.75%. Bounded to 4 so
  // the rendered string can't explode in length.
  lx_stat: refineFamilyWeight(
    z.object({
      value: z.number().finite(),
      // prefix/suffix concatenate around the count-up number at render
      // time. Even at 8-char max, a U+202E here would flip surrounding
      // glyphs — apply the bidi gate.
      prefix: safeText(8).optional(),
      suffix: safeText(8).optional(),
      label: safeRequiredText(1, TEXT_MAX.caption),
      duration_ms: z.number().int().min(0).max(10000).default(1800),
      decimals: z.number().int().min(0).max(4).default(0),
      alignment: z.enum(['left', 'center', 'right']).default('center'),
      tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_stat).default('obsidian'),
      family: fontFamilyToken,
      weight: fontWeightToken,
    }),
  ),

  // Luxury closing quote / sign-off. Italic Fraunces display copy
  // with a small uppercase attribution beneath. Designed for the
  // editorial closing-thought moment at the bottom of a page —
  // generous vertical space, large quote, attribution as a quiet
  // signature. animation 'line-reveal' is the canonical luxury
  // treatment (each line of the quote staggers up).
  lx_quote: refineFamilyWeight(
    z.object({
      quote: safeRequiredText(1, TEXT_MAX.body),
      attribution: safeText(TEXT_MAX.caption).optional(),
      alignment: z.enum(['left', 'center']).default('center'),
      tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_quote).default('obsidian'),
      family: fontFamilyToken,
      weight: fontWeightToken,
      animation: z
        .enum(['none', 'fade-in', 'slide-up', 'line-reveal'])
        .default('none'),
    }),
  ),

  // ════════════════════════════════════════════════════════════════
  // LUXURY 2.0 — composites added in the legacy-overhaul release.
  // Each replaces a legacy widget; the legacy renderer + schema stay
  // registered for one release as defence in depth (any pre-migration
  // row still renders instead of 500-ing).
  // ════════════════════════════════════════════════════════════════

  // Luxury testimonial — pull-quote + portrait + attribution. The
  // editorial cousin of lx_quote: same restraint, with a portrait
  // square that anchors the human reading the quote. Portrait optional
  // (allows "no portrait" composition that reads as a heavy serif
  // pull-quote with a name line below). attribution_title is preserved
  // distinctly from attribution so e.g. "Esther Loomis" + "Co-founder,
  // Studio Verde" can render as two lines without operator string
  // concatenation.
  lx_testimonial: refineFamilyWeight(
    z.object({
      quote: safeRequiredText(1, TEXT_MAX.body),
      attribution: safeRequiredText(1, TEXT_MAX.caption),
      attribution_title: safeText(TEXT_MAX.caption).optional(),
      portrait: MediaRef.optional(),
      alignment: z.enum(['left', 'center']).default('center'),
      tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_testimonial).default('obsidian'),
      family: fontFamilyToken,
      weight: fontWeightToken,
      animation: z
        .enum(['none', 'fade-in', 'slide-up', 'line-reveal'])
        .default('none'),
    }),
  ),

  // Luxury video — cinematic aspect-ratio wrapper around a lazy-loaded
  // YouTube / Vimeo iframe. Operator pastes a normal share URL; the
  // renderer normalises to the privacy-enhanced embed shape (no
  // tracking until the operator clicks play). Optional poster MediaRef
  // shows a still frame until play; without one we fall back to the
  // provider's own poster.
  //
  // url validation: limited to youtube.com / youtu.be / vimeo.com
  // hostnames. Anything else rejects at the write boundary — the
  // renderer doesn't have to deal with arbitrary script-injection
  // iframe URLs, and the operator gets immediate feedback if they
  // pasted the wrong link.
  lx_video: z.object({
    url: z
      .string()
      .min(1)
      .max(TEXT_MAX.url)
      .refine(isValidVideoUrl, 'invalid_video_url'),
    poster: MediaRef.optional(),
    ratio: z.enum(['21:9', '16:9', '4:5', '1:1']).default('16:9'),
    caption: safeText(TEXT_MAX.short).optional(),
    autoplay: z.boolean().default(false),
    muted: z.boolean().default(true),
    loop: z.boolean().default(false),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_video).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Luxury accordion — FAQ with smooth height-transition motion. The
  // body_richtext flows through the RICHTEXT_FIELDS walker in parse.ts
  // at both write and read boundaries (same sanitisation as legacy
  // accordion). `defaultOpen` is the 0-indexed item to render in the
  // open state on first paint; -1 leaves every item closed (the
  // "operator-driven FAQ" shape). variant: 'accordion' is the standard
  // collapsible/expand UX with chevrons; 'list' renders every body
  // permanently visible (matches the lx_quote-stack reading mode for
  // shorter answer sets).
  lx_accordion: z.object({
    items: z
      .array(
        z.object({
          title: safeRequiredText(1, TEXT_MAX.caption),
          body_richtext: z.string().max(TEXT_MAX.richtextShort),
        }),
      )
      .min(1)
      .max(20),
    defaultOpen: z.number().int().min(-1).max(19).default(0),
    variant: z.enum(['accordion', 'list']).default('accordion'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_accordion).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Luxury tabs — product-page tabbed sections. Each tab's body is
  // richtext so operators can drop in mid-length editorial content
  // (paragraphs, lists, inline links). Tab labels are short — the
  // tracking-eyebrow treatment in the renderer matches lx_eyebrow's
  // visual register. Minimum 2 tabs (a 1-tab "tabs" widget is a
  // text widget); maximum 6 (operator UI gets crowded past that).
  lx_tabs: z.object({
    tabs: z
      .array(
        z.object({
          label: safeRequiredText(1, TEXT_MAX.caption),
          body_richtext: z.string().max(TEXT_MAX.richtextShort),
        }),
      )
      .min(2)
      .max(6),
    defaultIndex: z.number().int().min(0).max(5).default(0),
    alignment: z.enum(['left', 'center']).default('left'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_tabs).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Luxury icon list — vertical feature list (icon + headline + body).
  // The premium cousin of legacy `icon_list` that doesn't try to be a
  // grid of icon-boxes. Each row is the lucide-icon + display headline
  // + body-text shape every premium SaaS landing page uses for the
  // "what you get" section. variant: 'vertical' stacks rows full-width
  // with the icon ABOVE each headline (the editorial default); 'grid'
  // lays those icon-above-headline rows in a 2-or-3-column grid; 'row'
  // places the icon BESIDE the headline (icon-left, text-right) and lays
  // the rows in a 1-or-2-column grid — the "directory / nearby" register
  // (e.g. points-of-interest with a drive-time sub-line).
  lx_icon_list: z.object({
    items: z
      .array(
        z.object({
          icon: iconName,
          headline: safeRequiredText(1, TEXT_MAX.title),
          body: safeText(TEXT_MAX.body).optional(),
        }),
      )
      .min(1)
      .max(12),
    variant: z.enum(['vertical', 'grid', 'row']).default('vertical'),
    // 1 is meaningful for the 'row' variant — a single stacked column of
    // icon-beside-text rows (e.g. a POI rail in a narrow layout column).
    columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
    alignment: z.enum(['left', 'center']).default('left'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_icon_list).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Luxury icon box — icon + headline + body card with optional link.
  // The premium cousin of legacy `icon_box`. Single card; for rows of
  // cards, compose three lx_icon_box widgets inside a threeCols.
  // accent: champagne-fill (default) is the marquee tile treatment;
  // champagne-outline reads quieter; cream-tint sits on dark sections
  // (obsidian/near-black) with high contrast.
  lx_icon_box: z.object({
    icon: iconName,
    headline: safeRequiredText(1, TEXT_MAX.title),
    body: safeText(TEXT_MAX.body).optional(),
    link: z
      .object({
        href: safeCtaHref(TEXT_MAX.url),
        openInNew: z.boolean().default(false),
      })
      .optional(),
    alignment: z.enum(['left', 'center']).default('center'),
    accent: z
      .enum(['champagne-fill', 'champagne-outline', 'cream-tint'])
      .default('champagne-outline'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_icon_box).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // ────────────────────────────────────────────────────────────────
  // Final composites — closes the legacy purge. Every concept the
  // legacy widget set covered now has a premium lx_ home.
  // ────────────────────────────────────────────────────────────────

  // Luxury divider — editorial hairline rule with optional fleuron
  // (a small ornamental diamond at center). Default tone champagne
  // reads as a warm gold line on light surfaces; warm-stone / copper
  // give quieter palettes; obsidian / ivory invert for dark vs light
  // surfaces.
  lx_divider: z.object({
    style: z.enum(['solid', 'dashed', 'dotted', 'fleuron']).default('solid'),
    width: z.enum(['full', 'half', 'quarter', 'short']).default('full'),
    thickness: z.enum(['hairline', '1px', '2px']).default('hairline'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_divider).default('champagne'),
    alignment: z.enum(['left', 'center', 'right']).default('center'),
    animation: z.enum(['none', 'fade-in']).default('none'),
  }),

  // Luxury social icons — a row of brand glyphs. Platform names are
  // enumerated so the renderer resolves to OFFICIAL simple-icons SVGs
  // (per ~/.claude/CLAUDE.md #0.57 — never hand-roll brand marks).
  // Unknown name rejects at the write boundary.
  lx_social_icons: z.object({
    items: z
      .array(
        z.object({
          // Every platform listed MUST have a corresponding official
          // simple-icons SVG bundled at /public/icons/social/<platform>.svg
          // (renderer uses CSS mask-image — a 404 silently renders as
          // a solid colour square). Bundled SVGs were fetched from
          // raw.githubusercontent.com/simple-icons/simple-icons (CC0
          // licensed). Adding a platform = fetch the official SVG from
          // that source, drop it under /public/icons/social/, then add
          // here AND in PLATFORM_LABEL in components/blocks/LxSocialIcons/render.tsx.
          platform: z.enum([
            'instagram',
            'facebook',
            'linkedin',
            'twitter',
            'youtube',
            'tiktok',
            'whatsapp',
            'github',
            'dribbble',
            'behance',
            'pinterest',
            'vimeo',
            'spotify',
            'apple-music',
            'soundcloud',
            'threads',
          ]),
          href: safeCtaHref(TEXT_MAX.url),
        }),
      )
      .min(1)
      .max(8),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
    alignment: z.enum(['left', 'center', 'right']).default('center'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_social_icons).default('warm-stone'),
    animation: z.enum(['none', 'fade-in']).default('none'),
  }),

  // Luxury CTA banner — title + body + primary CTA + optional
  // secondary CTA. Sits on its own section background (operator picks
  // bg via section meta); the renderer applies generous editorial
  // padding so the widget fills the section without composition.
  lx_cta_banner: z.object({
    eyebrow: safeText(TEXT_MAX.caption).optional(),
    title: safeRequiredText(1, TEXT_MAX.title),
    body: safeText(TEXT_MAX.body).optional(),
    primaryCta: z.object({
      label: safeRequiredText(1, TEXT_MAX.ctaText),
      href: safeCtaHref(TEXT_MAX.url),
      openInNew: z.boolean().default(false),
    }),
    secondaryCta: z
      .object({
        label: safeRequiredText(1, TEXT_MAX.ctaText),
        href: safeCtaHref(TEXT_MAX.url),
        openInNew: z.boolean().default(false),
      })
      .optional(),
    alignment: z.enum(['left', 'center']).default('center'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_cta_banner).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Luxury gallery — array of images in a grid. Each image gets the
  // lx_figure treatment (sharp corners, fade-in motion, optional
  // caption). Single-image gallery is valid (showcase page where the
  // operator hasn't picked the next photo yet).
  lx_gallery: z.object({
    images: z
      .array(MediaRef.extend({ caption: safeText(TEXT_MAX.short).optional() }))
      .min(1)
      .max(48),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    ratio: z.enum(['1:1', '4:5', '4:3', '3:2']).default('1:1'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_gallery).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),
  // Data-driven project card grid (0.1.54 — replaces the purged legacy
  // `featured_projects`). There is no per-block selection: the grid
  // auto-renders the projects marked Featured (via projects.featured_order,
  // managed in the Projects admin), in that order, capped at 12 by
  // hydrate, which fills RenderContext.projects + their hero images so the
  // renderer resolves name / tagline / hero photo per card. When no
  // project is Featured the grid renders nothing on the public page (a
  // hint in the editor).
  lx_featured_projects: z.object({
    heading: safeText(TEXT_MAX.title).optional(),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    // No `tone` — the renderer auto-contrasts the ancestor section's
    // surface (light text on dark sections, dark on light), so there's no
    // per-block colour to mismatch the background.
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // ════════════════════════════════════════════════════════════════
  // ELEMENTOR-PARITY BLOCKS — content/marketing widgets that close the
  // gap with Elementor's widget catalogue. Every one is composed from
  // the same primitives (MediaRef, safeText, colorTokenOrHex, iconName)
  // and stores entirely in content_blocks.data JSON — no migrations.
  // ════════════════════════════════════════════════════════════════

  // ── Embla wave ──────────────────────────────────────────────────

  // Image/media carousel (Elementor: Image Carousel + Slides). Embla-
  // driven swipe/drag with optional autoplay + loop. Each slide is a
  // MediaRef + optional caption + optional per-slide link. intervalMs
  // bounded 2–12s so an operator can't set a seizure-fast autoplay.
  lx_carousel: z.object({
    slides: z
      .array(
        z.object({
          image: MediaRef,
          caption: safeText(TEXT_MAX.short).optional(),
          href: safeCtaHrefOptional(TEXT_MAX.url).optional(),
        }),
      )
      .min(1)
      .max(20),
    ratio: z.enum(['21:9', '16:9', '4:3', '4:5', '1:1']).default('16:9'),
    autoplay: z.boolean().default(false),
    intervalMs: z.number().int().min(2000).max(12000).default(5000),
    loop: z.boolean().default(true),
    showArrows: z.boolean().default(true),
    showDots: z.boolean().default(true),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_carousel).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Testimonial carousel (Elementor: Testimonial Carousel). One centered
  // pull-quote per slide. `quote` is in RICHTEXT_FIELDS (parse.ts) so it
  // is DOMPurify'd — harmless on the plain text this field carries.
  lx_testimonial_carousel: z.object({
    items: z
      .array(
        z.object({
          quote: safeRequiredText(1, TEXT_MAX.body),
          attribution: safeRequiredText(1, TEXT_MAX.caption),
          attribution_title: safeText(TEXT_MAX.caption).optional(),
          portrait: MediaRef.optional(),
        }),
      )
      .min(1)
      .max(12),
    autoplay: z.boolean().default(false),
    intervalMs: z.number().int().min(2000).max(12000).default(6000),
    loop: z.boolean().default(true),
    showArrows: z.boolean().default(true),
    showDots: z.boolean().default(true),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_testimonial_carousel).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // ── Repeater-card wave ──────────────────────────────────────────

  // Star rating (Elementor: Star Rating). value supports fractions
  // (4.5); the renderer clips a champagne fill to value/max width.
  lx_star_rating: z.object({
    value: z.number().min(0).max(10),
    max: z.number().int().min(1).max(10).default(5),
    showValue: z.boolean().default(false),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_star_rating).default('champagne'),
    animation: z.enum(['none', 'fade-in']).default('none'),
  }),

  // Pricing table (Elementor: Price Table). price/period are strings so
  // "$49" / "/mo" / "Free" / "Contact" all work. CTA is flat optional
  // fields (label+href) — rendered only when both are present, which
  // sidesteps a nullable-object validation cliff. Compose three in a
  // section's columns for a 3-up.
  lx_pricing_table: z.object({
    planName: safeRequiredText(1, TEXT_MAX.caption),
    price: safeRequiredText(1, TEXT_MAX.caption),
    period: safeText(TEXT_MAX.caption).optional(),
    description: safeText(TEXT_MAX.body).optional(),
    features: z.array(safeText(TEXT_MAX.body)).min(1).max(20),
    ctaLabel: safeText(TEXT_MAX.ctaText).optional(),
    ctaHref: safeCtaHrefOptional(TEXT_MAX.url).optional(),
    ctaOpenInNew: z.boolean().default(false),
    featured: z.boolean().default(false),
    featuredLabel: safeText(TEXT_MAX.caption).optional(),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_pricing_table).default('ivory'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Price list (Elementor: Price List) — menu-style rows with a dotted
  // leader between title and price.
  lx_pricing_list: z.object({
    items: z
      .array(
        z.object({
          title: safeRequiredText(1, TEXT_MAX.caption),
          description: safeText(TEXT_MAX.body).optional(),
          price: safeRequiredText(1, TEXT_MAX.caption),
        }),
      )
      .min(1)
      .max(40),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_pricing_list).default('ivory'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Reviews (Elementor: Reviews) — card grid of author + star rating +
  // text + optional avatar. rating supports fractions.
  lx_reviews: z.object({
    items: z
      .array(
        z.object({
          author: safeRequiredText(1, TEXT_MAX.caption),
          rating: z.number().min(0).max(5),
          text: safeRequiredText(1, TEXT_MAX.body),
          role: safeText(TEXT_MAX.caption).optional(),
          avatar: MediaRef.optional(),
        }),
      )
      .min(1)
      .max(24),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_reviews).default('ivory'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Progress tracker / stepper (Elementor: Progress Tracker). Ordered
  // steps with done / current / upcoming states; vertical or horizontal.
  lx_progress_tracker: z.object({
    steps: z
      .array(
        z.object({
          title: safeRequiredText(1, TEXT_MAX.caption),
          description: safeText(TEXT_MAX.body).optional(),
          state: z.enum(['done', 'current', 'upcoming']).default('upcoming'),
        }),
      )
      .min(1)
      .max(12),
    orientation: z.enum(['vertical', 'horizontal']).default('vertical'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_progress_tracker).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // ── Client motion / interactive wave ────────────────────────────

  // Animated headline (Elementor: Animated Headline). Static prefix +
  // rotating/typed words. Hydration-safe (renderer cycles in useEffect).
  lx_animated_headline: refineFamilyWeight(
    z.object({
      prefix: safeText(TEXT_MAX.title).optional(),
      words: z.array(safeText(TEXT_MAX.caption)).min(1).max(8),
      suffix: safeText(TEXT_MAX.title).optional(),
      effect: z.enum(['rotate', 'fade', 'type']).default('rotate'),
      level: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']).default('h2'),
      size: z
        .enum(['display-2xl', 'display-xl', 'display-lg', 'display-md', 'display-sm'])
        .default('display-lg'),
      alignment: z.enum(['left', 'center', 'right']).default('center'),
      intervalMs: z.number().int().min(1000).max(8000).default(2600),
      tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_animated_headline).default('obsidian'),
      family: fontFamilyToken,
      weight: fontWeightToken,
    }),
  ),

  // Countdown (Elementor: Countdown). target is an ISO datetime string;
  // the renderer ticks every second (hydration-safe snapshot + effect).
  lx_countdown: z.object({
    target: z
      .string()
      .min(1)
      .max(40)
      .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid_datetime'),
    showDays: z.boolean().default(true),
    showHours: z.boolean().default(true),
    showMinutes: z.boolean().default(true),
    showSeconds: z.boolean().default(true),
    expiredText: safeText(TEXT_MAX.caption).optional(),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_countdown).default('obsidian'),
    animation: z.enum(['none', 'fade-in']).default('none'),
  }),

  // Flip box (Elementor: Flip Box). Front + back faces; flips on hover
  // or tap. CTA is flat optional fields. Keys are flattened (frontX /
  // backX) because the FieldShape DSL has no nested-object kind.
  lx_flip_box: z.object({
    frontIcon: iconName.optional(),
    frontImage: MediaRef.optional(),
    frontHeadline: safeRequiredText(1, TEXT_MAX.title),
    frontBody: safeText(TEXT_MAX.body).optional(),
    backHeadline: safeRequiredText(1, TEXT_MAX.title),
    backBody: safeText(TEXT_MAX.body).optional(),
    backCtaLabel: safeText(TEXT_MAX.ctaText).optional(),
    backCtaHref: safeCtaHrefOptional(TEXT_MAX.url).optional(),
    trigger: z.enum(['hover', 'tap']).default('hover'),
    height: z.enum(['sm', 'md', 'lg']).default('md'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_flip_box).default('obsidian'),
    animation: z.enum(['none', 'fade-in']).default('none'),
  }),

  // Image hotspots (Elementor: Hotspot). Markers positioned by x/y
  // percent, each opening an accessible popover.
  lx_hotspot: z.object({
    image: MediaRef,
    markers: z
      .array(
        z.object({
          x: z.number().min(0).max(100),
          y: z.number().min(0).max(100),
          label: safeRequiredText(1, TEXT_MAX.caption),
          body: safeText(TEXT_MAX.body).optional(),
        }),
      )
      .min(1)
      .max(12),
    ratio: z.enum(['21:9', '16:9', '4:3', '1:1', 'auto']).default('16:9'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_hotspot).default('obsidian'),
    animation: z.enum(['none', 'fade-in']).default('none'),
  }),

  // Progress bars / skill meters (Elementor: Progress Bar). Each bar
  // fills on scroll-into-view; role=progressbar for a11y.
  lx_progress: z.object({
    items: z
      .array(
        z.object({
          label: safeRequiredText(1, TEXT_MAX.caption),
          value: z.number().int().min(0).max(100),
        }),
      )
      .min(1)
      .max(20),
    showValue: z.boolean().default(true),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_progress).default('obsidian'),
    // No `animation` field — the block's signature motion is the per-bar
    // fill-on-scroll (IntersectionObserver in the renderer). A second
    // section-entrance animation would double up and fight the ref.
  }),

  // ── Nav / utility wave ──────────────────────────────────────────

  // Menu anchor (Elementor: Menu Anchor) — an invisible in-page jump
  // target. anchorId must be a valid HTML id (letter-leading).
  lx_menu_anchor: z.object({
    anchorId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'invalid_anchor_id'),
  }),

  // Table of contents (Elementor: Table of Contents) — manual anchor
  // list. Each anchor references a block's HTML id (set in Advanced) or
  // an lx_menu_anchor. 'auto' heading-scan is a documented future add.
  lx_toc: z.object({
    title: safeText(TEXT_MAX.caption).optional(),
    items: z
      .array(
        z.object({
          label: safeRequiredText(1, TEXT_MAX.caption),
          anchor: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'invalid_anchor'),
        }),
      )
      .min(1)
      .max(30),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_toc).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Share buttons (Elementor: Share Buttons). Five fixed networks as
  // booleans (render order is fixed). Share intents are built from the
  // current page URL at click time — no operator URL, no injection.
  lx_share: z.object({
    shareX: z.boolean().default(true),
    shareLinkedin: z.boolean().default(true),
    shareFacebook: z.boolean().default(true),
    shareEmail: z.boolean().default(true),
    shareCopy: z.boolean().default(true),
    label: safeText(TEXT_MAX.caption).optional(),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_share).default('warm-stone'),
    animation: z.enum(['none', 'fade-in']).default('none'),
  }),

  // ── Dynamic wave ────────────────────────────────────────────────

  // Posts loop (Elementor: Posts / Loop Grid). Auto-renders the latest
  // published posts — no per-block selection, the same model as
  // lx_featured_projects. hydrate.ts bulk-fetches them; the renderer
  // never queries the DB. No tone (auto-contrasts the ancestor surface).
  // 'by tag/category' is a documented future add (needs a posts-tags
  // migration the schema doesn't have yet).
  lx_posts: z.object({
    heading: safeText(TEXT_MAX.title).optional(),
    limit: z.number().int().min(1).max(12).default(3),
    layout: z.enum(['grid', 'list']).default('grid'),
    columns: z.union([z.literal(2), z.literal(3)]).default(3),
    showExcerpt: z.boolean().default(true),
    showDate: z.boolean().default(true),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('fade-in'),
  }),

  // ── Security wave ───────────────────────────────────────────────

  // Embed (Elementor: HTML / oEmbed). Tier-1: a curated host allowlist
  // (lib/cms/embedHosts.ts), normalised to a sandboxed iframe. The
  // refine rejects any non-allowlisted URL at the write boundary so the
  // renderer never frames an arbitrary source. Each allowlisted host is
  // mirrored in frame-src (lib/security/buildCsp.ts). title is REQUIRED
  // for iframe a11y. Raw-HTML srcdoc is a documented Tier-2 future add.
  lx_embed: z.object({
    embedUrl: z
      .string()
      .min(1)
      .max(TEXT_MAX.url)
      .refine(isAllowedEmbedUrl, 'invalid_embed_url'),
    ratio: z.enum(['21:9', '16:9', '4:3', '1:1', 'auto']).default('16:9'),
    title: safeRequiredText(1, TEXT_MAX.caption),
  }),

  // Code highlight (Elementor: Code Highlight). `code` is PLAIN TEXT —
  // NOT in parse.ts RICHTEXT_FIELDS — escaped + highlighted by Shiki at
  // the server (zero client JS, no injection path). language is a
  // bounded enum so a pathological grammar can't be requested.
  lx_code: z.object({
    code: z.string().min(1).max(8000),
    language: z
      .enum([
        'text', 'ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'bash',
        'python', 'go', 'rust', 'sql', 'yaml', 'markdown', 'php', 'java',
        'ruby', 'c', 'cpp', 'diff',
      ])
      .default('text'),
    showLineNumbers: z.boolean().default(false),
    filename: safeText(TEXT_MAX.caption).optional(),
  }),

  // ── Stretch wave ("even better than Elementor") ─────────────────

  // Marquee — logo / text ticker. Pure-CSS scroll, reduced-motion safe.
  lx_marquee: z.object({
    mode: z.enum(['text', 'logos']).default('text'),
    text: safeText(TEXT_MAX.title).optional(),
    logos: z.array(MediaRef).max(24).default([]),
    speed: z.enum(['slow', 'medium', 'fast']).default('medium'),
    direction: z.enum(['left', 'right']).default('left'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_marquee).default('obsidian'),
  }),

  // Before/after image comparison slider. Range-input driven (keyboard
  // accessible); clip-path reveals the "after" image.
  lx_before_after: z.object({
    before: MediaRef,
    after: MediaRef,
    beforeLabel: safeText(TEXT_MAX.caption).optional(),
    afterLabel: safeText(TEXT_MAX.caption).optional(),
    ratio: z.enum(['16:9', '4:3', '3:2', '1:1']).default('4:3'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_before_after).default('obsidian'),
  }),

  // Comparison / feature matrix. Up to 4 plan columns; each row cell
  // (c1..c4) is a string — "yes"/"no" render as check/dash, else text.
  // Flat cell keys because the FieldShape DSL has no nested-array kind.
  lx_comparison_table: z.object({
    columns: z.array(safeText(TEXT_MAX.caption)).min(2).max(4),
    rows: z
      .array(
        z.object({
          feature: safeRequiredText(1, TEXT_MAX.caption),
          c1: safeText(TEXT_MAX.caption).optional(),
          c2: safeText(TEXT_MAX.caption).optional(),
          c3: safeText(TEXT_MAX.caption).optional(),
          c4: safeText(TEXT_MAX.caption).optional(),
        }),
      )
      .min(1)
      .max(40),
    highlightColumn: z.number().int().min(0).max(3).optional(),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_comparison_table).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // Timeline — dated vertical event sequence on a champagne rail.
  lx_timeline: z.object({
    events: z
      .array(
        z.object({
          date: safeText(TEXT_MAX.caption),
          title: safeRequiredText(1, TEXT_MAX.title),
          body: safeText(TEXT_MAX.body).optional(),
          image: MediaRef.optional(),
        }),
      )
      .min(1)
      .max(24),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_timeline).default('obsidian'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  // ════════════════════════════════════════════════════════════════
  // PROJECT lead-form blocks — the ONLY project-specific block types.
  // A lead form is one irreducible widget (fields + submit + CSRF +
  // project scoping), so it can't be composed from primitives. Every
  // OTHER part of a project page (hero, gallery, floor plans, pricing,
  // amenities, location, timeline, testimonials, facts) is composed
  // from existing primitive blocks by the tree-builder
  // (lib/cms/projectTreeBuilder.ts) — each element its own editable
  // block. These two read the project row from RenderContext.project
  // (project_id, name, brochure_pdf_id) + csrf; they are NOT in the
  // operator palette (created only by the backfill + new-project flow).
  // ════════════════════════════════════════════════════════════════

  // Project inquiry form — always-present lead form to /api/leads/inquiry.
  // project_id + the visible project name come from RenderContext.project
  // at render; preCsrf from RenderContext.csrf. Renderer emits
  // id="inquiry-form" (the hero / sticky-header "Schedule a tour" CTA
  // target). Lifted from `inquiry` verbatim.
  lx_inquiry_form: z.object({
    heading: z.string().max(220).optional(),
    body_richtext: z.string().max(2000).optional(),
  }),

  // Project brochure form — lead-gated PDF download to
  // /api/leads/brochure. The PDF stays canonical on
  // projects.brochure_pdf_id (the lead route reads THAT); the block
  // carries only the gate copy. Renderer reads brochure_pdf_id from
  // RenderContext.project, returns null when absent, emits id="brochure".
  lx_brochure_form: z.object({
    gate_message_richtext: z.string().max(2000).optional(),
  }),
} as const

export type BlockType = keyof typeof blockSchemas
// Per-block-type parsed shape. Default `BlockType` widens to the union of
// every block's data type — fine for places that don't care which kind.
export type BlockData<T extends BlockType = BlockType> = z.infer<
  (typeof blockSchemas)[T]
>

export class UnknownBlockTypeError extends Error {
  // Carries the attacker-controlled `type` in a structured field, NEVER
  // interpolated into the message. withError logs err.message in non-prod
  // and err.name always; the previous `unknown_block_type:${type}` form
  // echoed unbounded user input into the dev log line.
  constructor(public readonly blockType: string) {
    super('unknown_block_type')
    this.name = 'UnknownBlockTypeError'
  }
}

export function parseBlockData(type: string, data: unknown): BlockData {
  const schema = (blockSchemas as Record<string, z.ZodTypeAny>)[type]
  if (!schema) throw new UnknownBlockTypeError(type)
  return schema.parse(data) as BlockData
}

// Fixed slots the page-template guarantees exist. block_key is non-null
// on these rows; DELETE /api/cms/blocks/[id] refuses to remove a row with
// non-null block_key (409 cannot_delete_fixed_block). Order here is the
// initial seed order — runtime order is the position column.
// Luxury 2.0 — system pages are now block-tree-driven (see
// db/seeds/systemPageBlocks.ts). home / about / services no longer
// carry pre-seeded fixed-slot widgets — the operator can clear or
// restructure them like any other page. The contact page keeps
// contact_form as a fixed slot because the lead route expects exactly
// one form widget on that page (POST /api/leads queries by
// block_key='contact_form').
export const FIXED_BLOCK_KEYS_PER_PAGE: Record<string, BlockType[]> = {
  contact: ['contact_form'],
}
