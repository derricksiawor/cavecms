// Shared CTA-href safety layer. Extracted from block-registry.ts so the
// lightweight value-layer (blockMeta.ts — imported into the client
// EditDrawer) can validate operator-controlled hrefs WITHOUT pulling the
// entire block registry into the client bundle, and so there is a SINGLE
// source of truth for the allow-list regex + unsafe-char gate (no drift
// between the widget schemas and the column card-link schema).
//
// Pure zod + regex. No `server-only`, no DB types — safe on both server
// and client.

import { z } from 'zod'

// Allowed CTA href schemes. Permits:
//   - https:// , http://   (absolute external)
//   - mailto: , tel:       (contact)
//   - /path                (same-origin absolute path; the `[^/\\]`
//                           after the leading slash rejects `//evil.com`
//                           and `/\evil.com` protocol-relative escapes)
// Rejects (by omission): javascript:, data:, vbscript:, file:, ftp:,
// scheme-relative `//host`, and the ambiguous `https:foo` (missing //).
export const CTA_HREF_RE = /^(?:https?:\/\/|mailto:|tel:|\/[^/\\])/i

// Reject control characters (U+0000-U+001F, U+007F) + backslash + any
// leading/trailing whitespace. WHATWG URL spec strips TAB/LF/CR from
// hrefs before parsing, so `/<TAB>/evil.com` passes the CTA_HREF_RE
// regex (TAB satisfies `[^/\\]`) but the browser resolves it as
// `//evil.com` → cross-origin redirect. Pre-checking via this refine
// closes that bypass class entirely. Trim equality also rejects
// leading/trailing spaces operators may paste from copied URLs.
// Built via `new RegExp` so the control-char range is expressed with
// ASCII \uXXXX escapes (no literal control bytes in source).
const HREF_UNSAFE_CHAR_RE = new RegExp('[\\u0000-\\u001F\\u007F\\\\]')

export function isSafeCtaHref(s: string): boolean {
  // Step 1 — char-class gate: control chars + DEL + backslash.
  if (HREF_UNSAFE_CHAR_RE.test(s)) return false
  // Step 2 — trim equality rejects leading/trailing whitespace.
  if (s !== s.trim()) return false
  // Step 3 — reject embedded spaces (WHATWG URL parses them as
  // %20-in-host or fails, neither legitimate for an editorial CTA).
  if (s.includes(' ')) return false
  // Step 4 — for http(s) schemes, parse the URL and reject userinfo.
  // `https://attacker@trusted-looking.com` reads as trusted but
  // navigates to attacker.
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
export const safeCtaHref = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(CTA_HREF_RE, 'href_scheme_not_allowed')
    .refine(isSafeCtaHref, 'href_contains_unsafe_chars')

export const safeCtaHrefOptional = (max: number) =>
  z
    .string()
    .max(max)
    .regex(CTA_HREF_RE, 'href_scheme_not_allowed')
    .refine(isSafeCtaHref, 'href_contains_unsafe_chars')
