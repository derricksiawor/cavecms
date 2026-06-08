import 'server-only'
import { z } from 'zod'
import { TEXT_MAX } from './limits'
// CTA href safety (allow-list regex + unsafe-char gate + the
// required/optional zod helpers) lives in ./safeHref so the client
// value-layer (blockMeta.ts) can reuse the SAME validation without
// pulling this server-only registry into the browser bundle.
import { safeCtaHref, safeCtaHrefOptional } from './safeHref'
// parseVideoEmbedUrl is unused after the legacy purge — the lx_video
// schema uses its own isValidVideoUrl gate. Kept removed (no import).
import { parseStrictHttpsUrl } from './url-guard'
import { HEX_COLOR_RE, CSS_TYPO_VALUE_RE } from './designTokens'
import { GradientSchema } from './gradient'
import { BLOCK_TONE_ENUMS } from './blockTones'
import { isAllowedEmbedUrl } from './embedHosts'
import { SLUG_RE } from './slug'
import { HONEYPOT_FIELD } from '@/lib/leads/honeypot'

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
//
// `family` accepts EITHER a global role token ('display' | 'body', which
// tracks Settings → Typography) OR a direct catalog font key
// ('cormorant-garamond', …) — the per-element override (Elementor's
// model). Role tokens and catalog keys share one value space and never
// collide (no catalog font is named display/body).
const fontFamilyToken = z
  .string()
  // Cap before the refine so an oversized value is rejected cheaply (longest
  // catalog key is ~19 chars); mirrors how iconName caps before its regex.
  .max(64)
  .refine(
    // Role token OR any valid font-key slug. Custom fonts live in a
    // runtime `custom_fonts` setting, so a static schema can't check a
    // value against the bundled catalog — it must accept any well-formed
    // slug. The render path emits `var(--font-cat-<key>)`; the var is
    // only defined for active fonts, so an unknown slug fails closed to
    // the inherited face. Bundled keys are valid slugs → no regression.
    (v) => v === 'display' || v === 'body' || isFontKeySlug(v),
    { message: 'unknown_font_family' },
  )
  .optional()
const fontWeightToken = z
  // thin/light accepted at the write boundary for brand-exact type ramps via
  // MCP/API; the builder weight picker omits them (operator-UI preference).
  .enum(['thin', 'light', 'regular', 'medium', 'semibold', 'bold', 'black'])
  .optional()

// Optional EXACT typographic overrides for prose blocks (heading / text).
// The size enum + family/weight tokens cover the common cases; these let
// an agent/operator match a brand's type ramp to the pixel (e.g. a 56px /
// 1.1 line-height / -0.025em hero) the same way `backgroundColor` lets a
// section match an exact hex. Accepts a SAFE subset only:
//   - a unitless number for line-height ("1.1", "1.625")
//   - a single length ("56px", "3.5rem", "-0.025em", "1.5vw")
//   - a 3-arg clamp of lengths/viewport units for responsive type
//     ("clamp(2.25rem, 5vw, 3.5rem)")
// The strict regex rejects semicolons, url(), expression(), braces, calc —
// so the value can never break out of the inline style it renders into.
// Inline style beats the size/leading/tracking utility classes, so a set
// override wins; unset = the renderer's class-derived baseline.
const cssTypoValue = z.string().trim().min(1).max(48).regex(CSS_TYPO_VALUE_RE)

// Cross-field refine for typography blocks: when both `family` and
// `weight` are set, the chosen weight must be one the family can actually
// render — a role's curated `shippedWeights`, or a catalog font's variable
// wght range. Without this, a payload like `{family:'cormorant-garamond',
// weight:'black'}` (Cormorant tops out at 700) would survive validation
// and the browser would render faux-bold — a brand-quality regression.
// The picker greys out bad combinations (FontWeightPicker); the schema is
// the authoritative gate. shippedWeightTokensFor handles both role + catalog.
import { shippedWeightTokensFor } from './designTokens'
import { isFontKeySlug } from '@/lib/typography/catalog'
function refineFamilyWeight<S extends z.ZodObject<z.ZodRawShape>>(schema: S): S {
  return schema.refine(
    (d) => {
      const o = d as {
        // family is a loose slug (role token OR catalog/custom-font key) —
        // not just 'display' | 'body' — because the typography catalog allows
        // any activated font key per element.
        family?: string
        weight?: 'thin' | 'light' | 'regular' | 'medium' | 'semibold' | 'bold' | 'black'
      }
      if (!o.family || !o.weight) return true
      const allowed = shippedWeightTokensFor(o.family)
      return !allowed || allowed.includes(o.weight)
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

// Form select option — { label (shown), value (submitted = the "meta"/tag id) }.
// A bare string is accepted (legacy string[] options) and normalised to
// { label, value:same }; a blank value falls back to the label.
const formSelectOption = z
  .union([
    safeText(80),
    z.object({ label: safeText(80), value: safeText(80).optional() }),
  ])
  .transform((o) =>
    typeof o === 'string'
      ? { label: o, value: o }
      : {
          label: o.label,
          value: o.value && o.value.length > 0 ? o.value : o.label,
        },
  )

// ─── Form after-submit actions (Elementor "Actions After Submit" parity) ──
// On a successful lx_form submit the lead is ALWAYS saved + the team notified;
// `actions[]` are the EXTRA, operator-configured steps. Discriminated on `kind`
// so new action types (redirect, crm) slot in later without migrating rows.
const deliverFileAction = z
  .object({
    kind: z.literal('deliver_file'),
    // The gated file (a media row — typically a PDF lead magnet). Reuses
    // MediaRef so the MediaPicker drawer field + media_references bookkeeping
    // work unchanged; the alt doubles as the file's human label.
    file: MediaRef,
    // email   → a signed, expiring download link is emailed to the submitter.
    // instant → the success screen shows a Download button (same signed link).
    // manual  → no auto-delivery; lead saved + team notified (the legacy
    //           brochure flow), now an explicit operator choice, not the only path.
    mode: z.enum(['email', 'instant', 'manual']).default('email'),
    emailSubject: safeText(160).optional(),
    emailBody: safeText(TEXT_MAX.body).optional(),
  })
// NOT .strict(): the drawer's object_array repeater tags each action with a
// client-only `__id` (React/reorder key) that rides along in the save payload.
// Every other block schema strips unknown keys via Zod's default — a .strict()
// here uniquely 400'd the PATCH (err_kind:zod) so the action never persisted.
// Strip-don't-reject matches the codebase and keeps the saved action clean.
const formAction = z.discriminatedUnion('kind', [deliverFileAction])
// Max after-submit actions per form — shared so the writer (the lx_form
// `actions` field) and the read-path re-validator below can't drift.
const MAX_FORM_ACTIONS = 8
// Exported so the lead route can re-validate a form's after-submit actions
// loaded from content_blocks (defence in depth — re-parses the SAME non-strict
// shape, see the note above for why it's intentionally NOT strict, and re-applies
// the .max() bound the writer enforces so a hand-edited row can't be unbounded).
export const lxFormActionsSchema = z.array(formAction).max(MAX_FORM_ACTIONS)

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
      // Exact typographic overrides (optional) — pixel-match a brand's
      // type ramp. Override the size-enum / leading-tight / tracking-tight
      // baseline when set. fontSize accepts a length or a responsive
      // clamp(); lineHeight a unitless number or length; letterSpacing a
      // length (e.g. "-0.025em").
      fontSize: cssTypoValue.optional(),
      lineHeight: cssTypoValue.optional(),
      letterSpacing: cssTypoValue.optional(),
      // Responsive per-breakpoint overrides (E17) — tablet (≤1024px) and
      // mobile (≤640px) sizes, emitted as a scoped <style>. Override the
      // base size at that breakpoint only.
      fontSizeTablet: cssTypoValue.optional(),
      fontSizeMobile: cssTypoValue.optional(),
      lineHeightTablet: cssTypoValue.optional(),
      lineHeightMobile: cssTypoValue.optional(),
      // Gradient TEXT (optional) — paints the heading with a gradient via
      // background-clip:text. Overrides the tone colour when set.
      textGradient: GradientSchema.optional(),
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
      // Exact typographic overrides (optional) — match a brand's body ramp
      // precisely. Override the size-enum baseline when set.
      fontSize: cssTypoValue.optional(),
      lineHeight: cssTypoValue.optional(),
      letterSpacing: cssTypoValue.optional(),
      // Responsive per-breakpoint overrides (E17).
      fontSizeTablet: cssTypoValue.optional(),
      fontSizeMobile: cssTypoValue.optional(),
      lineHeightTablet: cssTypoValue.optional(),
      lineHeightMobile: cssTypoValue.optional(),
      // Gradient TEXT (optional) — overrides the tone colour when set.
      textGradient: GradientSchema.optional(),
      animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
    }),
  ),

  // Luxury eyebrow / kicker. Small uppercase tracking-wide label that
  // sits above a hero h1 or section h2. Optional gold-rule prefix
  // (a thin champagne hairline that animates in left-to-right when
  // animation: 'gold-rule' is set). Renders <p> — NOT a heading
  // element — because semantically it's a label.
  lx_eyebrow: refineFamilyWeight(
    z.object({
      text: safeRequiredText(1, TEXT_MAX.caption),
      prefix: z.enum(['rule', 'none']).default('none'),
      // 'badge' = the pill treatment (tinted rounded chip, uppercase).
      // 'plain' = a quiet inline label — NO pill, text in the tone colour,
      // rendered as typed (no forced uppercase). For editorial section
      // kickers (e.g. a muted "The problem" above a left-aligned headline).
      variant: z.enum(['badge', 'plain']).default('badge'),
      tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_eyebrow).default('champagne'),
      alignment: z.enum(['left', 'center', 'right']).default('left'),
      family: fontFamilyToken,
      weight: fontWeightToken,
      // Gradient TEXT (optional) — overrides the tone colour when set.
      textGradient: GradientSchema.optional(),
      animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
    }),
  ),

  // Luxury CTA action. Variants: primary-gold (champagne fill on
  // obsidian text), secondary-outline (gold outline on transparent),
  // ghost (no chrome, type only), link-arrow (text + animated arrow).
  // The animation: 'magnetic' opt-in attaches the cursor-follow
  // pointer behaviour for buttons that warrant it (the canonical
  // single hero CTA, not 12 magnetic CTAs on a page).
  // Composable form (Elementor Form parity) — operator-defined fields that
  // POST to the lead pipeline. Each field has a slug name, label, type,
  // required flag, placeholder, and (for select) options. One field can be
  // flagged the email/name/phone for the lead row; everything is packed
  // into the lead message + emailed to the notification recipient.
  lx_form: z.object({
    heading: safeText(TEXT_MAX.title).optional(),
    intro: safeText(TEXT_MAX.body).optional(),
    fields: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
          label: safeRequiredText(1, TEXT_MAX.caption),
          type: z.enum(['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'hidden']).default('text'),
          required: z.boolean().default(false),
          placeholder: safeText(120).optional(),
          // Dropdown options — each a { label (shown), value (submitted = the
          // "meta"/tag id) } pair. Bare strings accepted for back-compat.
          options: z.array(formSelectOption).max(30).optional(),
          // Column width on the rendered form — lets fields sit side-by-side.
          width: z.enum(['full', 'half', 'third']).default('full'),
          // For a `select` field: where options come from. 'static' = the
          // operator's `options`; 'tags' / 'categories' = pulled live from the
          // taxonomy (label = term name, value = slug). Ignored by non-selects.
          optionsSource: z.enum(['static', 'tags', 'categories']).default('static'),
          // Map this field to the lead's name / email / phone column.
          role: z.enum(['none', 'name', 'email', 'phone']).default('none'),
          // For a `hidden` field: the fixed value submitted with the form (a
          // CRM tag id, a campaign/source code, a project id). Never shown to
          // the visitor; flows into the lead + CRM map like any other field.
          defaultValue: safeText(200).optional(),
        }),
      )
      .min(1)
      .max(20)
      // A visible field named exactly like the honeypot (`company_url`) would
      // overwrite the hidden anti-bot input in the submitted FormData, so a
      // real visitor's value trips honeypotTripped() and the lead is silently
      // dropped behind a fake success screen. Reserve the name at the write
      // boundary. Also enforce name-uniqueness so two fields can't clobber
      // each other in FormData.
      .superRefine((fields, ctx) => {
        const seen = new Set<string>()
        fields.forEach((f, i) => {
          if (f.name === HONEYPOT_FIELD) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"${HONEYPOT_FIELD}" is a reserved field name`,
              path: [i, 'name'],
            })
          }
          if (seen.has(f.name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Duplicate field name "${f.name}"`,
              path: [i, 'name'],
            })
          }
          seen.add(f.name)
        })
      }),
    submitLabel: safeRequiredText(1, TEXT_MAX.ctaText).default('Submit'),
    successHeadline: safeText(TEXT_MAX.title).optional(),
    successBody: safeText(TEXT_MAX.body).optional(),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_text).default('obsidian'),
    // After-submit pipeline (see formAction above). Empty for legacy lx_form
    // instances; default [] keeps them parsing unchanged.
    actions: z.array(formAction).max(MAX_FORM_ACTIONS).default([]),
    // Per-instance CRM routing — reuses the contact_form destinations shape.
    // Surfaced in the drawer's CRM tab; dispatched by /api/leads/form with the
    // field-map keyed by THIS form's own field names.
    crmDestinations: contactFormCrmDestinationsSchema.optional(),
  }),

  // Standalone icon (Elementor Icon widget parity) — a single lucide glyph
  // at any size/colour, optionally in a circle/square chip, rotatable,
  // linkable. The composable primitive for icon-led cards (vs lx_icon_box
  // which bundles icon+heading+body).
  lx_icon: z.object({
    icon: iconName,
    size: z.number().int().min(8).max(240).default(48),
    color: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_icon).default('champagne'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
    rotate: z.number().int().min(0).max(360).default(0),
    shape: z.enum(['none', 'circle', 'square']).default('none'),
    shapeColor: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_icon).optional(),
    link: z
      .object({ href: safeCtaHref(TEXT_MAX.url), openInNew: z.boolean().default(false) })
      .optional(),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
  }),

  lx_action: refineFamilyWeight(
    z.object({
      label: safeRequiredText(1, TEXT_MAX.ctaText),
      href: safeCtaHref(TEXT_MAX.url),
      openInNew: z.boolean().default(false),
      variant: z
        .enum(['primary-gold', 'secondary-outline', 'ghost', 'link-arrow'])
        .default('primary-gold'),
      size: z.enum(['sm', 'md', 'lg']).default('md'),
      alignment: z.enum(['left', 'center', 'right']).default('left'),
      // Per-element font override (role token OR catalog/custom-font key) +
      // weight. Validated against the family's shipped weights by
      // refineFamilyWeight.
      family: fontFamilyToken,
      weight: fontWeightToken,
      // Gradient FILL (optional) — paints the button with a gradient
      // background. Overrides the variant's solid fill when set; the label
      // colour still comes from the variant (set a contrasting variant).
      // Ignored for the 'link-arrow' variant (it's text, not a pill).
      backgroundGradient: GradientSchema.optional(),
      // Optional gradient on the button LABEL text (background-clip:text).
      textGradient: GradientSchema.optional(),
      // Exact corner radius in px (0 = square, larger = softer). UNSET = the
      // default full pill (rounded-full). Set e.g. 14 for a rounded-rectangle
      // button. Ignored for 'link-arrow' (text, no pill).
      radius: z.number().int().min(0).max(64).optional(),
      // Solid fill colour (token or #hex) for the button — overrides the
      // variant's fill (e.g. a white button: fillColor '#ffffff' on the
      // primary variant, which already has dark label text). A gradient fill
      // wins over this when both are set.
      fillColor: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_heading).optional(),
      // Hover-state overrides (Elementor parity) — bg, label colour, scale,
      // and transition duration on hover. Rendered via CSS custom properties
      // + the `cms-hover` utility so :hover styling works from inline data.
      hoverFillColor: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_heading).optional(),
      hoverTextColor: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_heading).optional(),
      hoverScale: z.number().int().min(80).max(140).optional(),
      transitionMs: z.number().int().min(50).max(1200).optional(),
      // Per-corner radius (px) — overrides the single `radius` for that corner.
      radiusTopLeft: z.number().int().min(0).max(64).optional(),
      radiusTopRight: z.number().int().min(0).max(64).optional(),
      radiusBottomRight: z.number().int().min(0).max(64).optional(),
      radiusBottomLeft: z.number().int().min(0).max(64).optional(),
      animation: z.enum(['none', 'fade-in', 'slide-up', 'magnetic']).default('none'),
    }),
  ),

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
    // E13 — Elementor Image parity:
    // optional link (whole figure clickable); lightbox (click → full-image
    // overlay; ignored when a link is set); hover-zoom; crop focus.
    link: z
      .object({ href: safeCtaHref(TEXT_MAX.url), openInNew: z.boolean().default(false) })
      .optional(),
    lightbox: z.boolean().default(false),
    hoverZoom: z.boolean().default(false),
    // Ambient Ken Burns drift — a slow continuous camera move on the image
    // (independent of hoverZoom). Respects prefers-reduced-motion.
    kenBurns: z
      .enum(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'zoom-pan'])
      .default('none'),
    objectPosition: z
      .enum(['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'])
      .optional(),
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
      // Layout of the number relative to its label. 'vertical' (default,
      // current) stacks the number above the label; 'horizontal' puts
      // them on one line — useful for a compact bed/bath/sqft facts row.
      orientation: z.enum(['vertical', 'horizontal']).default('vertical'),
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
          // Optional command/code shown as a mini terminal strip inside the
          // card (with a copy button) — for "install command" feature cards.
          // Escaped at render; no rich markup.
          code: z.string().max(400).optional(),
        }),
      )
      .min(1)
      .max(12),
    // Render each item on a filled, rounded CARD surface (for a 2-col
    // feature-card grid). Pairs with variant:'grid'.
    card: z.boolean().default(false),
    // 'checklist' = a compact stack of small-icon-beside-text rows (the
    // ceymail "✓ feature" list register): no glow, tight rows, the icon
    // tinted by `iconColor`. 'row' is the larger icon-beside-text card.
    variant: z.enum(['vertical', 'grid', 'row', 'checklist']).default('vertical'),
    // 1 is meaningful for the 'row' variant — a single stacked column of
    // icon-beside-text rows (e.g. a POI rail in a narrow layout column).
    columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3),
    alignment: z.enum(['left', 'center']).default('left'),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_icon_list).default('obsidian'),
    // Optional icon colour (token or #hex). When set, the icon uses this
    // colour and the champagne glow is dropped — e.g. green checks for a
    // feature checklist. Unset = the signature champagne glow treatment.
    iconColor: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_icon_list).optional(),
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
    // Optional text OR icon centred on the rule (Elementor divider parity)
    // — e.g. an "OR" separator or a small glyph between two rules.
    label: safeText(TEXT_MAX.caption).optional(),
    labelIcon: iconName.optional(),
    // Exact overrides (max flexibility): thickness in px (overrides the
    // enum) and width as a % (overrides the width preset).
    thicknessPx: z.number().int().min(1).max(16).optional(),
    widthPercent: z.number().int().min(5).max(100).optional(),
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

  // Posts loop (Elementor: Posts / Loop Grid). Two modes:
  //
  //   • 'recent' (DEFAULT — back-compat): the original teaser behaviour.
  //     Auto-renders the latest published posts, capped by `limit` (1..12),
  //     no pagination. hydrate.ts bulk-fetches them into RenderContext.posts;
  //     the renderer slices + never queries the DB. This is what every
  //     existing instance (e.g. the home-page teaser) keeps doing — `mode`
  //     defaults to 'recent', so deserialising an old payload is a no-op.
  //
  //   • 'loop': the paginated blog archive used on the `/blog` system page.
  //     Reads the current page from the URL `?page=` (threaded via
  //     renderCmsPage → RenderContext.postsLoop) and renders a KEYSET-
  //     paginated slice (published_at DESC, id DESC) with accessible
  //     prev/next. Filterable by a single `category`/`tag` slug (injected
  //     on archive pages; unset on a plain /blog). `postsPerPage` overrides
  //     the page size; when unset the renderer falls back to
  //     blog_settings.postsPerPage. hydrate.ts fetches the correct
  //     filtered+paginated bounded slice into RenderContext.postsLoop, so
  //     the renderer STAYS a pure synchronous view (required: lx_posts also
  //     renders inside the client editor canvas, where an async server
  //     component would throw — same constraint as lx_code).
  //
  // ════════════════════════════════════════════════════════════════
  // Posts widget (Elementor Pro: Posts / Loop Grid + JetBlog parity).
  // The premium, opinionated subset: 5 layout TEMPLATES × 7 query
  // SOURCES × 3 pagination modes, every choice theme-token-styled and
  // bounded at scale (#0.251). No tone field — every template auto-
  // contrasts the ancestor section surface.
  //
  // ── BACK-COMPAT (#8) ──────────────────────────────────────────────
  // The legacy schema had `mode: recent|loop` + `layout: grid|list`.
  // Every stored instance (home-page teaser = mode:'recent'; /blog
  // index = mode:'loop') must keep working with ZERO migration. A
  // top-level `z.preprocess` rewrites a legacy payload into the new
  // `source`/`template` vocabulary BEFORE the object schema parses:
  //   • mode:'recent'  → source:'latest'   (self-contained newest list)
  //   • mode:'loop'    → source:'current'  (inherit the archive query)
  //   • layout:'grid'  → template:'grid'
  //   • layout:'list'  → template:'list'
  // The legacy `mode`/`layout`/`limit` fields STAY in the schema (so an
  // un-migrated payload still validates + the editor can still read the
  // old controls), but the renderer + hydrate read the NEW fields, which
  // the preprocess always populates. A payload that already carries
  // `source`/`template` (new instances) passes through untouched — the
  // preprocess only fills a new field when it is absent.
  //
  // `category`/`tag`/`author`/`manualPostIds` are the source operands;
  // each is validated so a malformed value can never reach the
  // parameterised query. Slugs use the canonical SLUG_RE; ids are
  // positive ints; manual ids are capped (graceful "N / max").
  // ════════════════════════════════════════════════════════════════
  lx_posts: z.preprocess(
    (raw) => {
      // Defensive: only object payloads get the back-compat fill. A
      // non-object falls straight through to Zod's "expected object"
      // error (same as before).
      if (raw === null || typeof raw !== 'object') return raw
      const o = { ...(raw as Record<string, unknown>) }
      // source ← mode (only when source is absent — new payloads win).
      if (o.source === undefined && o.mode !== undefined) {
        o.source = o.mode === 'loop' ? 'current' : 'latest'
      }
      // template ← layout (grid|list both map 1:1; magazine/cards/carousel
      // never existed in the legacy `layout`, so no collision).
      if (o.template === undefined && o.layout !== undefined) {
        o.template = o.layout === 'list' ? 'list' : 'grid'
      }
      return o
    },
    z.object({
      // ── Template (the 5 layouts) ────────────────────────────────────
      template: z
        .enum(['grid', 'cards', 'list', 'magazine', 'carousel'])
        .default('grid'),

      // ── Source (the "add to any page" query model) ──────────────────
      source: z
        .enum(['current', 'latest', 'category', 'tag', 'author', 'manual', 'related'])
        .default('latest'),

      heading: safeText(TEXT_MAX.title).optional(),

      // ── Source operands ─────────────────────────────────────────────
      // category / tag — a single term slug (source:'category'|'tag').
      // Canonical slug shape → safe parameter for the taxonomy join.
      category: z.string().min(1).max(120).regex(SLUG_RE, 'invalid_category_slug').optional(),
      tag: z.string().min(1).max(120).regex(SLUG_RE, 'invalid_tag_slug').optional(),
      // authorId — source:'author'. Positive int (users.id).
      authorId: z.number().int().positive().optional(),
      // manualPostIds — source:'manual'. Operator hand-picks posts; capped
      // at 24 (graceful "N / 24" in the picker). Positive int post ids,
      // de-dup + cap enforced here so a hand-edited payload can't blow the
      // IN(...) list.
      manualPostIds: z
        .array(z.number().int().positive())
        .max(24)
        .optional(),

      // ── Count / ordering ────────────────────────────────────────────
      // limit — the self-contained-source card count (latest/category/tag/
      // author/manual/related). Bounded 1..24. (Renamed-in-spirit from the
      // legacy `limit` which was 1..12 recent-only; widened to 24 to match
      // manual's cap. Legacy payloads carry limit≤12 → still valid.)
      limit: z.number().int().min(1).max(24).default(6),
      // postsPerPage — source:'current' (paginated archive) page size
      // override. When omitted the loop uses blog_settings.postsPerPage.
      postsPerPage: z.number().int().min(1).max(50).optional(),
      // offset — skip the first N matches (so a magazine lead + a grid below
      // don't duplicate). Bounded; applies to the self-contained sources.
      offset: z.number().int().min(0).max(100).default(0),
      orderBy: z
        .enum(['date', 'modified', 'title', 'reading-time', 'random'])
        .default('date'),
      orderDir: z.enum(['desc', 'asc']).default('desc'),
      // excludeCurrent — on a post-detail placement, drop the post being
      // viewed from the list (always true for source:'related'; opt-in
      // elsewhere). No-op on pages that aren't a post.
      excludeCurrent: z.boolean().default(false),

      // ── Columns (widened 1..4; back-compat: legacy 2|3 still valid) ──
      columns: z
        .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
        .default(3),

      // ── Card content toggles (default from blog_settings at hydrate) ─
      showImage: z.boolean().default(true),
      showExcerpt: z.boolean().default(true),
      showDate: z.boolean().default(true),
      showAuthor: z.boolean().default(false),
      showCategory: z.boolean().default(true),
      showReadingTime: z.boolean().default(false),
      showReadMore: z.boolean().default(false),
      readMoreLabel: safeText(40).optional(),
      // titleClamp / excerptClamp — line-clamp ceilings so a long title or
      // excerpt can't break the card grid. 0 = no clamp.
      titleClamp: z.number().int().min(0).max(4).default(2),
      excerptClamp: z.number().int().min(0).max(6).default(3),

      // ── Styling PRESETS (theme-token-bound, never raw hex/px) ───────
      cardStyle: z.enum(['flat', 'soft', 'elevated']).default('soft'),
      spacing: z.enum(['tight', 'comfortable', 'airy']).default('comfortable'),
      imageAspect: z.enum(['16:9', '4:3', '3:2', '1:1', '4:5']).default('16:9'),

      // ── Pagination ──────────────────────────────────────────────────
      // none (homepage strips), numbered (crawlable ?page=, SEO-friendly),
      // load-more (AJAX-append next page). Only the 'current' source +
      // grid/cards/list templates honour pagination; magazine/carousel
      // ignore it (always 'none' effective). Default resolved at hydrate
      // per template when left at 'auto'.
      pagination: z.enum(['auto', 'none', 'numbered', 'load-more']).default('auto'),

      // ── Carousel-only knobs (ignored by the other templates) ────────
      autoplay: z.boolean().default(false),
      intervalMs: z.number().int().min(2000).max(12000).default(5000),
      carouselLoop: z.boolean().default(true),
      showArrows: z.boolean().default(true),
      showDots: z.boolean().default(true),

      // ── Legacy fields kept for back-compat (renderer ignores them) ──
      // The preprocess maps these into source/template; they remain in the
      // schema so an un-migrated stored payload still validates and the
      // pre-existing seeds (db/seeds/systemPageBlocks.ts, blockSeeds.ts)
      // keep parsing. New instances never set them.
      mode: z.enum(['recent', 'loop']).optional(),
      layout: z.enum(['grid', 'list']).optional(),

      animation: z.enum(['none', 'fade-in', 'slide-up']).default('fade-in'),
    }),
  ),

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
    // One-click "Copy" affordance in the code-block header (default on).
    // Set false for display-only snippets.
    copyable: z.boolean().default(true),
  }),

  // Rich text (markdown). The home of a full post body on the block
  // engine (spec §4.6): `markdown` is the markdown SOURCE, stored as
  // PLAIN TEXT — deliberately NOT in parse.ts RICHTEXT_FIELDS, exactly
  // like `lx_code.code`. It is rendered server-side AND in the editor
  // canvas via `renderMarkdownSync` (lib/cms/markdown-shared.ts), whose
  // rehype-sanitize allowlist is the SOLE XSS trust boundary. That
  // allowlist permits the full block-level set markdown produces
  // (h2-h4, ul/ol/li, blockquote, pre/code, img, hr, p, strong, em, a)
  // — which a single `lx_text` block CANNOT hold, because the lx_text
  // `body_richtext` DOMPurify allowlist (sanitize-shared.ts) is
  // inline+lists only (p/br/strong/em/a/ul/ol/li, NO headings /
  // blockquote / pre / img / hr). So migrating a markdown post body
  // into one lx_text block would silently strip headings, code blocks,
  // blockquotes, images and rules — data loss. lx_richtext preserves
  // them. `safeText` applies the bidi/zero-width gate (display-spoof
  // defence) but no HTML stripping — the markdown is plain text until
  // the renderer transforms it. Reusable on pages too, not just posts.
  lx_richtext: z.object({
    // Long-form markdown SOURCE — length-capped only, NOT display-gated
    // (no bidi/ZWS refine). Post bodies legitimately contain ZWJ emoji
    // (e.g. 👨‍👩‍👧 = U+200D) and bidi-embedded RTL text; the render-time
    // sanitizer (renderMarkdownSync) is the trust boundary, matching how
    // body_md is validated at the posts write boundary (length cap only). A
    // display-gate here would permanently strand i18n/emoji posts on the
    // legacy fallback during backfill.
    markdown: z.string().max(TEXT_MAX.bodyMarkdown),
    tone: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_richtext).default('obsidian'),
    maxWidth: z.enum(['narrow', 'medium', 'wide', 'full']).default('wide'),
    animation: z.enum(['none', 'fade-in', 'slide-up']).default('none'),
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
    // Accent (token or #hex) for the ✓ checks, the highlighted column's
    // header text, and its tint band. Default champagne; set to the brand
    // accent (e.g. a green #00e68a) to match a brand's compare table.
    accent: colorTokenOrHex(BLOCK_TONE_ENUMS.lx_comparison_table).default('champagne'),
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
    // Form presentation (absent === current: cream panel card, bordered
    // inputs). Passed straight through to InquirySection, which honours
    // them. card_surface 'transparent' drops the card so the form can be
    // aligned with the brochure form; field_style 'filled' swaps the
    // bordered inputs for a tinted fill.
    card_surface: z.enum(['panel', 'transparent']).optional(),
    field_style: z.enum(['bordered', 'filled']).optional(),
    // Section background, drawn from the brand theme palette. Drives the
    // WHOLE section's tone (surface + headings + body + accents + card +
    // inputs) so a dark tone stays legible. Absent === 'cream' (the
    // current light look, now brand-linked). See lib/cms/sectionTone.
    background: z.enum(['cream', 'obsidian', 'ivory', 'champagne', 'bone']).optional(),
  }),

  // Project brochure form — lead-gated PDF download to
  // /api/leads/brochure. The PDF stays canonical on
  // projects.brochure_pdf_id (the lead route reads THAT); the block
  // carries only the gate copy. Renderer reads brochure_pdf_id from
  // RenderContext.project, returns null when absent, emits id="brochure".
  lx_brochure_form: z.object({
    gate_message_richtext: z.string().max(2000).optional(),
    // Form presentation (absent === current: no card surface, bordered
    // inputs). Threaded into BrochureSection by the block renderer.
    // card_surface 'panel' wraps the form in a cream card matching the
    // inquiry form; field_style 'filled' swaps the bordered inputs.
    card_surface: z.enum(['panel', 'transparent']).optional(),
    field_style: z.enum(['bordered', 'filled']).optional(),
    // Section background from the brand theme palette (see lx_inquiry_form
    // + lib/cms/sectionTone). Absent === 'cream'.
    background: z.enum(['cream', 'obsidian', 'ivory', 'champagne', 'bone']).optional(),
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
