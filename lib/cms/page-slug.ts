import { SLUG_MAX, SLUG_MIN, SLUG_RE } from './slug'

// EXPORTED — middleware (§2.1 Block 2) and lib/env.ts (LOGIN_PATH
// refinement) import this same constant so the reserved set has a
// single source of truth.
//
// Hand-curated low-risk entries plus the filesystem-scan additions
// (`scripts/postbuild-check-slug-collisions.ts` walks app/ at depth 1
// to catch slugs colliding with routes that landed AFTER this list was
// authored — defence in depth).
//
// NOTE: 'about', 'services', 'home' are NOT in this set. They are
// seeded rows with `system=1` whose slug rename is refused by §4.3
// (system_slug_locked); the slot stays locked without occupying a
// reserved entry. To replace those pages wholesale, soft-delete the
// system row then create a new page with the same slug (the new
// page is NOT system=1, freely renameable).
//
// 'contact' IS reserved — diverges from spec §2.2 because PR-2 keeps
// `app/contact/page.tsx` as a static route to preserve the lead-
// capture <ContactForm /> below the CMS-rendered blocks (operator
// decision during PR-2 implementation). Reserving 'contact' here
// prevents the middleware rewrite from intercepting `/contact` so
// the static route owns the URL; it also prevents PR-3 page-create
// from minting a NEW page with slug='contact'. The existing
// `system=1` 'contact' row remains in DB and its CMS-managed blocks
// render via `renderCmsPage('contact')` from
// `app/_shared/cmsPage.tsx` inside the static route.
export const RESERVED: ReadonlySet<string> = new Set([
  'admin',
  'api',
  '_next',
  '_vercel',
  '_page',
  '_shared',
  'static',
  'public',
  'uploads',
  'sitemap.xml',
  'robots.txt',
  'healthz',
  'projects',
  'blog',
  'contact',
  'privacy',
  'terms',
  'newsletter',
  'unsubscribe',
  'manifest.json',
  'manifest.webmanifest',
  'favicon.ico',
  'og-image.png',
  'apple-touch-icon.png',
  'browserconfig.xml',
  'opensearch.xml',
  'ads.txt',
  'security.txt',
  '.well-known',
])

// Granular internal reason codes — recorded ONLY in server-side logs.
// NEVER echoed to clients (see publicSlugErrorCode below). Splitting
// public response codes into two (`slug_invalid` + `slug_in_use`)
// closes the iterative-probing enumeration vector for the NFKC / ASCII
// / reserved boundaries.
export type ValidateReason =
  | 'slug_invalid_format'
  | 'slug_too_short'
  | 'slug_too_long'
  | 'slug_reserved'
  | 'slug_non_ascii'
  | 'slug_must_be_normalized'
  | 'slug_has_whitespace'

export type ValidatePageSlugResult =
  | { ok: true }
  | { ok: false; reason: ValidateReason }

export function validatePageSlug(
  input: string,
  loginPath: string,
): ValidatePageSlugResult {
  // 0. Whitespace — distinct reason code covering leading, trailing,
  //    AND internal whitespace (tab, NBSP, etc via \s). Catches the
  //    common paste-from-Word/Notion case where the input is
  //    "foo bar" — without an internal-whitespace branch it would
  //    fail step 2 with `slug_non_ascii` (technically true since
  //    SPACE is below 0x21, but misleading from an operator-UX view).
  if (/\s/.test(input)) {
    return { ok: false, reason: 'slug_has_whitespace' }
  }
  // 1. NFKC normalise — reject anything that's not already in canonical
  //    form. Defends against confusable-Unicode (fullwidth Latin etc.)
  //    that look identical to ASCII slugs once rendered.
  const normalized = input.normalize('NFKC')
  if (normalized !== input) {
    return { ok: false, reason: 'slug_must_be_normalized' }
  }
  // 2. ASCII-only printable range — defence against confusable
  //    codepoints AND against silent collation drift if pages.slug
  //    ever loses its utf8mb4_bin collation.
  if (!/^[\x21-\x7e]+$/.test(input)) {
    return { ok: false, reason: 'slug_non_ascii' }
  }
  // 3. Length.
  if (input.length < SLUG_MIN) {
    return { ok: false, reason: 'slug_too_short' }
  }
  if (input.length > SLUG_MAX) {
    return { ok: false, reason: 'slug_too_long' }
  }
  // 4. Regex — canonical SLUG_RE.
  if (!SLUG_RE.test(input)) {
    return { ok: false, reason: 'slug_invalid_format' }
  }
  // 5. Reserved set + dotfile / underscore prefix. Input is already
  //    constrained to lowercase + digit + hyphen by SLUG_RE so no
  //    lowercase fold needed.
  if (RESERVED.has(input)) {
    return { ok: false, reason: 'slug_reserved' }
  }
  if (loginPath && input === loginPath.toLowerCase()) {
    return { ok: false, reason: 'slug_reserved' }
  }
  if (input.startsWith('.') || input.startsWith('_')) {
    return { ok: false, reason: 'slug_reserved' }
  }
  return { ok: true }
}

// PUBLIC error-code mapper — collapses every granular `ValidateReason`
// into one of two public codes. API handlers route a validation
// failure through this before sending the response body so the
// granular reason never reaches the wire. UNIQUE-collision (the
// caller's separate slug_in_use case) is emitted by the route handler
// directly, not by this helper.
export function publicSlugErrorCode(
  _reason: ValidateReason,
): 'slug_invalid' {
  return 'slug_invalid'
}
