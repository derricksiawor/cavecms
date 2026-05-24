import 'server-only'
import { z } from 'zod'
import { TEXT_MAX } from './limits'
import { parseVideoEmbedUrl } from './videoHostAllowlist'
import { parseStrictHttpsUrl } from './url-guard'
import { HEX_COLOR_RE } from './designTokens'
import { BLOCK_TONE_ENUMS } from './blockTones'

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
// paths, never mailto:, never tel:. Delegates the full safe-https
// gate (backslash/control/whitespace/userinfo/port/hash + parse) to
// `parseStrictHttpsUrl` in url-guard.ts - the same primitive
// videoHostAllowlist uses. NEVER throws.
function isValidSocialUrl(s: string): boolean {
  return parseStrictHttpsUrl(s) !== null
}

// Google Maps embed URL gate. Operators paste from Google Maps
// "Share → Embed a map" (canonical: https://www.google.com/maps/embed?pb=...)
// or the legacy keyless variant (?q=...&output=embed) on either
// www.google.com or maps.google.com. Everything else — including
// google.com (no www), HTTP, or any other host — is rejected.
// Middleware CSP frame-src must include both hosts for the iframe to
// render; the gate here is the input boundary.
function isValidMapEmbedUrl(s: string): boolean {
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
const Cta = z.object({
  text: z.string().min(1).max(TEXT_MAX.ctaText),
  href: safeCtaHref(TEXT_MAX.url),
  openInNew: z.boolean().default(false),
})

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
  hero: z.object({
    title: z.string().min(1).max(TEXT_MAX.title),
    subtitle: z.string().max(TEXT_MAX.short).optional(),
    image: MediaRef,
    cta: Cta.optional(),
  }),
  services_intro: z.object({
    title: z.string().min(1).max(TEXT_MAX.title),
    body_richtext: z.string().max(TEXT_MAX.richtextShort),
    items: z
      .array(
        z.object({
          icon: iconName.optional(),
          title: z.string().max(TEXT_MAX.caption),
          body: z.string().max(TEXT_MAX.itemBody),
        }),
      )
      .max(12),
  }),
  featured_projects: z.object({
    title: z.string().max(TEXT_MAX.title).optional(),
    project_ids: z.array(z.number().int().positive()).max(12),
    layout: z.enum(['grid', 'carousel']).default('grid'),
  }),
  about_history: z.object({
    title: z.string().max(TEXT_MAX.title),
    body_richtext: z.string().max(TEXT_MAX.richtextLong),
    image: MediaRef.optional(),
  }),
  cta: z.object({
    title: z.string().max(TEXT_MAX.title),
    body: z.string().max(TEXT_MAX.body).optional(),
    cta: Cta,
  }),
  text: z.object({
    heading: z.string().max(TEXT_MAX.title).optional(),
    body_richtext: z.string().max(TEXT_MAX.richtextLong),
  }),
  image: z.object({
    image: MediaRef,
    caption: z.string().max(TEXT_MAX.short).optional(),
    alignment: z.enum(['left', 'center', 'right']).default('center'),
  }),
  gallery: z.object({
    images: z
      .array(MediaRef.extend({ caption: z.string().max(TEXT_MAX.short).optional() }))
      .min(1)
      .max(48),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  }),
  quote: z.object({
    quote: z.string().max(TEXT_MAX.body),
    attribution: z.string().max(TEXT_MAX.caption).optional(),
    attribution_title: z.string().max(TEXT_MAX.caption).optional(),
  }),
  // Chunk F — Elementor-parity foundation widgets. Heading is the
  // standalone semantic heading widget (h1..h6). Default level is h2
  // to prevent SEO H1 collisions with the page metadata's own H1.
  // Justified alignment ships per Elementor parity (researcher confirmed
  // `start | center | end | justify` is canonical). Width/font/weight
  // are BWC-curated knobs — Elementor exposes `typography` as a global
  // control group; we narrow to a select to keep the operator UI quiet.
  heading: z.object({
    // NOTE: text uses .min(1) so an operator who clears the field via
    // inline edit gets a 422 → InlineEditable.commit() reverts the edit
    // with a clear toast. The seed payload provides "New heading" so
    // initial creation passes. Empty heading elements are an a11y/SEO
    // regression (screen readers announce "heading, blank") — fail
    // closed at the write boundary.
    text: z.string().min(1).max(TEXT_MAX.title),
    level: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']).default('h2'),
    alignment: z.enum(['left', 'center', 'right', 'justify']).default('left'),
    weight: z.enum(['regular', 'semibold', 'bold']).default('semibold'),
    font: z.enum(['sans', 'serif']).default('sans'),
  }),
  // Standalone CTA button. The href reuses CTA_HREF_RE for the same
  // scheme allowlist the embedded Cta uses (http/https/mailto/tel/
  // same-origin-paths). Size scale matches Elementor's 5 named presets;
  // BWC swaps semantic colours (info/success/danger) for stylistic
  // variants (primary/secondary/ghost) — see Button render comment.
  button: z.object({
    // .min(1) — an empty-text button is a zero-width click target with
    // no a11y label. Inline edit reverts cleanly on 422.
    text: z.string().min(1).max(TEXT_MAX.ctaText),
    href: z
      .string()
      .min(1)
      .max(TEXT_MAX.url)
      .regex(CTA_HREF_RE, 'href_scheme_not_allowed'),
    openInNew: z.boolean().default(false),
    variant: z.enum(['primary', 'secondary', 'ghost']).default('primary'),
    size: z.enum(['xs', 'sm', 'md', 'lg', 'xl']).default('md'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
  }),
  // Horizontal rule. Width keys: full / half / quarter / short — short
  // (w-16) replaces Elementor's degenerate `fit-content` value (an <hr>
  // has no intrinsic content so fit-content would render at 0px).
  divider: z.object({
    style: z.enum(['solid', 'dashed', 'dotted', 'double']).default('solid'),
    width: z.enum(['full', 'half', 'quarter', 'short']).default('full'),
    thickness: z
      .enum(['hairline', '1px', '2px', '4px'])
      .default('1px'),
    color: z.enum(['copper', 'warm-stone', 'near-black']).default('warm-stone'),
    alignment: z.enum(['left', 'center', 'right']).default('center'),
  }),
  // Vertical whitespace. Tier scale aligns with lib/cms/spacingTokens
  // SPACING_TIERS (minus 'none' — see Spacer render comment).
  spacer: z.object({
    height: z.enum(['xs', 'sm', 'md', 'lg', 'xl', '2xl']).default('md'),
  }),
  // Icon + headline + body, optionally clickable as a single link target.
  // Matches Elementor's parity: no separate CTA — the whole box is the
  // link. The optional `link` sub-object reuses CTA_HREF_RE.
  icon_box: z.object({
    // Both fields require non-empty values — an empty icon falls back to
    // a checkmark with no operator signal; an empty headline renders as
    // an invisible <h3>. Fail closed at the write boundary.
    icon: iconName,
    headline: z.string().min(1).max(TEXT_MAX.title),
    body: z.string().max(TEXT_MAX.body).optional(),
    link: z
      .object({
        href: z
          .string()
          .min(1)
          .max(TEXT_MAX.url)
          .regex(CTA_HREF_RE, 'href_scheme_not_allowed'),
        openInNew: z.boolean().default(false),
      })
      .optional(),
    alignment: z.enum(['left', 'center']).default('center'),
    accent: z
      .enum(['copper-filled', 'copper-outline', 'cream-tint'])
      .default('copper-outline'),
    // Headline + body text colour. Default 'near-black' preserves the
    // legacy treatment for icon_box widgets that sit on cream / ivory
    // surfaces. On obsidian / dark sections, set tone='ivory' so the
    // copy stays high-contrast — warm-stone body text on obsidian
    // reads as low-contrast/unreadable.
    tone: z.enum(BLOCK_TONE_ENUMS.icon_box).default('near-black'),
  }),
  // Expandable item list. body_richtext flows through the RICHTEXT_FIELDS
  // walker in parse.ts at both write and read boundaries.
  //
  // `variant` selects between the classic collapsed/expandable accordion
  // (default) and a "list" variant that renders every item visible at
  // once, separated by horizontal divider lines and stripped of the
  // chevron + interactive <details>/<summary>. The list variant is the
  // BWC-Contact-style FAQ shape — operators flip between the two
  // without changing their item data. See components/blocks/Accordion/
  // render.tsx for the visual treatment of each branch.
  accordion: z.object({
    items: z
      .array(
        z.object({
          // Title required — empty <summary> labels leave only the
          // chevron with no a11y / visible click affordance.
          title: z.string().min(1).max(TEXT_MAX.caption),
          body_richtext: z.string().max(TEXT_MAX.richtextShort),
        }),
      )
      .min(1)
      .max(20),
    // max(19) matches items.max(20) - 1. Out-of-range values would also
    // be caught by the render-time clamp, but rejecting at the write
    // boundary gives operators immediate "your default index is past
    // the last item" feedback instead of silent "no item open".
    default_open_index: z.number().int().min(0).max(19).optional(),
    allow_multiple: z.boolean().default(false),
    variant: z.enum(['accordion', 'list']).default('accordion'),
  }),
  // Icon + label list. No per-item link (operators use Icon Box for
  // clickable composition).
  icon_list: z.object({
    items: z
      .array(
        z.object({
          // Both required — empty rows are degenerate (no icon to look
          // up, no label to read).
          icon: iconName,
          label: z.string().min(1).max(TEXT_MAX.caption),
        }),
      )
      .min(1)
      .max(24),
    layout: z.enum(['vertical', 'grid_2', 'grid_3']).default('vertical'),
    style: z.enum(['copper-circle', 'copper-inline']).default('copper-inline'),
  }),
  // Tabbed content. body_richtext flows through RICHTEXT_FIELDS sanitizer.
  // default_tab_index is render-time clamped — a stale persisted index
  // falls back to 0 instead of pointing at a tabpanel that no longer
  // exists.
  tabs: z.object({
    items: z
      .array(
        z.object({
          // Tab label required — empty tabs render an unlabeled button
          // in the tablist with no a11y name.
          label: z.string().min(1).max(TEXT_MAX.caption),
          body_richtext: z.string().max(TEXT_MAX.richtextShort),
        }),
      )
      .min(1)
      .max(12),
    // max(11) matches items.max(12) - 1.
    default_tab_index: z.number().int().min(0).max(11).optional(),
  }),
  // ─── Chunk G — Elementor-parity rich widgets ─────────────────────
  // Appended alphabetically as a block so a future merge with another
  // chunk's additive registry edits drops in mechanically. Each schema
  // owns its operator-edited shape; renderer-side defaults / clamps
  // are spelled out next to the field that needs them.
  //
  // Inline-edit notes:
  //   - alert.title → `inlineEditableFields.ts` registers as 'plain'
  //   - testimonial.quote → registers as 'plain'. Also automatically
  //     sanitized by RICHTEXT_FIELDS in parse.ts (the field name 'quote'
  //     is already on that allowlist - defense-in-depth on input).
  //   - body_richtext (alert) is in RICHTEXT_FIELDS too - no parse.ts
  //     edit needed.

  // Status banner. Variant drives the icon + accent; copper-only palette
  // (no Bootstrap candy reds/greens) per research. `dismissible=true`
  // promotes the renderer to a client component that persists dismissal
  // in localStorage keyed on `bwc:alert:${blockId}:${contentHash}` -
  // see AlertDismissible.tsx for the exact scheme. The blockId pins
  // dismissal to a specific block row (no cross-block collisions); the
  // content hash invalidates dismissal whenever the operator edits the
  // alert text/variant (a republish without content change does NOT
  // invalidate - intended, the same alert keeps its dismissal).
  alert: z.object({
    variant: z.enum(['info', 'success', 'warning', 'error']).default('info'),
    // .min(1) - an empty title with a dismiss "x" reads as a stray
    // close button to assistive tech. Force a label.
    title: z.string().min(1).max(TEXT_MAX.caption),
    body_richtext: z.string().max(TEXT_MAX.richtextShort).default(''),
    dismissible: z.boolean().default(false),
  }),
  // Row of brand-mark icons. Platform enum is the EXACT allowlist of
  // brand SVGs we ship under public/icons/social/ - introducing a new
  // platform requires adding the official simple-icons SVG too
  // (project standards #0.57: never hand-roll a brand mark). URL goes through
  // isValidSocialUrl above which rejects everything except https
  // without userinfo / control chars.
  social_icons: z.object({
    items: z
      .array(
        z.object({
          platform: z.enum([
            'instagram',
            'facebook',
            'x',
            'linkedin',
            'youtube',
            'tiktok',
            'whatsapp',
          ]),
          url: z
            .string()
            .min(1)
            .max(TEXT_MAX.url)
            .refine(isValidSocialUrl, 'invalid_social_url'),
          // Operators sometimes want a same-tab link (e.g. a footer
          // row that includes an internal share). Default true
          // preserves the dominant pattern (external profile -> new
          // tab) without forcing every legacy row through a
          // migration: existing rows without the field get true via
          // Zod's `.default(true)` on parse.
          new_window: z.boolean().default(true),
        }),
      )
      .min(1)
      // max(7) matches the platform enum size - operator can't
      // configure a platform we don't ship a brand mark for. Allow
      // duplicates (someone may want two Instagram profiles with
      // different labels) - we don't enforce uniqueness here.
      .max(7),
    shape: z.enum(['circle', 'square', 'naked']).default('circle'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
  }),
  // Display-only rating. Render rounds to nearest 0.5 for half-star
  // visual; the stored value preserves operator input so "4.7 (412
  // reviews)" doesn't drift to 4.5 in the DB just because the visual
  // shows 4.5 stars.
  star_rating: z.object({
    value: z.number().min(0).max(5),
    label: z.string().max(TEXT_MAX.caption).optional(),
    review_count: z.number().int().min(0).optional(),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
  }),
  // Animated number tiles. Shared schema between TWO picker entries:
  // Counter (seeds 1 item + layout='solo') and Stats Row (seeds 3
  // items + layout='3up'). Layout='solo' is THIS schema's "Counter"
  // mode — single centred tile, no grid.
  //
  // duration_ms is operator-tunable per item. Bounded at 10s; longer
  // animations feel broken (visitor scrolls past mid-climb).
  stats_row: z.object({
    items: z
      .array(
        z.object({
          // No .min on value - operator may legitimately use 0
          // (e.g. "0 listing fees"). Non-finite values blocked
          // by Zod's .number() default (NaN/Infinity rejected).
          value: z.number().finite(),
          prefix: z.string().max(8).optional(),
          suffix: z.string().max(8).optional(),
          // duration_ms bounded so the easing function (easeOutExpo
          // in useCountUp) doesn't divide-by-near-zero. 0ms is legal -
          // the hook short-circuits to the final value on the first
          // RAF tick.
          duration_ms: z.number().int().min(0).max(10000).default(1800),
          // Label required - a number tile with no caption is just a
          // floating digit, no a11y context, no SEO value.
          label: z.string().min(1).max(TEXT_MAX.caption),
          helper_text: z.string().max(TEXT_MAX.caption).optional(),
        }),
      )
      .min(1)
      // max(6) matches '4up' layout + small overage tolerance for
      // operators who configured 5-tile layouts via the items array
      // before deciding on the grid breakpoint. Render clamps the
      // visible grid to the layout's column count.
      .max(6),
    layout: z.enum(['solo', '2up', '3up', '4up']).default('3up'),
  }),
  // Quote card with attribution + optional headshot + optional
  // project link. Richer than the plain `quote` widget: photo /
  // role / project all surface relationships that matter for luxury
  // real-estate trust signals.
  //
  // Note: the `quote` field reuses the same name as the plain Quote
  // widget on purpose - the RICHTEXT_FIELDS set in parse.ts catches
  // both via the same key (defense-in-depth sanitization on a
  // plain-text field never hurts).
  testimonial: z.object({
    quote: z.string().min(1).max(TEXT_MAX.body),
    attribution: z.string().max(TEXT_MAX.caption).optional(),
    role: z.string().max(TEXT_MAX.caption).optional(),
    image: MediaRef.optional(),
    project_id: z.number().int().positive().optional(),
    alignment: z.enum(['left', 'center']).default('left'),
  }),
  // YouTube / Vimeo embed. URL is gated by parseVideoEmbedUrl
  // (lib/cms/videoHostAllowlist.ts) - the operator's raw input is
  // checked against an exact host allowlist + path grammar + id regex.
  // The renderer then BUILDS the iframe src from the parsed
  // { kind, id } form (via buildEmbedSrc) - the operator URL never
  // reaches the iframe. Sandbox in the renderer omits
  // allow-top-navigation per the master spec.
  video_embed: z.object({
    url: z
      .string()
      .min(1)
      .max(TEXT_MAX.url)
      .refine((u) => parseVideoEmbedUrl(u) !== null, 'invalid_video_url'),
    aspect_ratio: z.enum(['16:9', '4:3', '1:1', '21:9']).default('16:9'),
    caption: z.string().max(TEXT_MAX.short).optional(),
  }),
  // Editorial kicker / eyebrow label. The small uppercase tracking-wide
  // accent line that sits above a hero h1, above a section h2, or as
  // a tiny LABEL on top of a card. Not a heading element semantically
  // — emits a <p> so screen readers don't announce "heading" for what
  // is visually a label. Three color tokens map to the BWC palette
  // (copper accent, warm-stone muted, near-black solid).
  eyebrow: z.object({
    // .min(1) — empty eyebrow is a zero-content paragraph; inline edit
    // reverts cleanly on 422.
    text: z.string().min(1).max(TEXT_MAX.caption),
    color: z.enum(['copper', 'warm-stone', 'near-black']).default('copper'),
    alignment: z.enum(['left', 'center', 'right']).default('left'),
  }),
  // Channel tile — small bordered card with a kicker label, body
  // paragraph, and optional action link. The 3-up shape that appears
  // in the Contact page's channels grid (Email / Phone / Address) but
  // generalises to any "ways to reach us / things we offer" 3-column
  // section. Address-shaped cards omit `action` (no clickable
  // destination); Email / Phone cards include mailto: / tel: action.
  // Inline-editable: label is the primary scalar; body + action edit
  // via the EditDrawer.
  channel_card: z.object({
    label: z.string().min(1).max(TEXT_MAX.caption),
    body: z.string().min(1).max(TEXT_MAX.body),
    action: z
      .object({
        text: z.string().min(1).max(TEXT_MAX.ctaText),
        href: z
          .string()
          .min(1)
          .max(TEXT_MAX.url)
          .regex(CTA_HREF_RE, 'href_scheme_not_allowed'),
        openInNew: z.boolean().default(false),
      })
      .optional(),
  }),
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
    ratio: z.enum(['21:9', '16:9', '4:5', '1:1']).default('16:9'),
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
export const FIXED_BLOCK_KEYS_PER_PAGE: Record<string, BlockType[]> = {
  home: ['hero', 'featured_projects', 'services_intro', 'cta'],
  about: ['hero', 'about_history'],
  services: ['hero', 'services_intro'],
  // Luxury redesign: contact's editorial hero is no longer a 'hero'
  // block — it's composed from lx_eyebrow + lx_heading + lx_text in
  // section 1. The contact_form remains a fixed slot (the lead route
  // expects exactly one form on the page).
  contact: ['contact_form'],
}
