import { TEXT_MAX } from './limits'

// Shared URL trust-boundary primitives. Every URL field at the
// CMS write boundary (VideoEmbed's url, SocialIcons items[].url,
// plus any future external-URL widget) MUST funnel through here so
// a single hardening update (e.g. adding a new control-char range)
// applies uniformly.
//
// The gate enforces:
//   - non-empty, bounded length (TEXT_MAX.url - matches the storage
//     column cap so we never accept a string we can't persist)
//   - no leading/trailing whitespace (operators paste; they never
//     legitimately submit whitespace-padded URLs)
//   - no backslash (WHATWG special-scheme parsers convert `\` to `/`
//     mid-host, smuggling past a naive host check)
//   - no control chars (0x00-0x1F + 0x7F) - silently stripped by
//     the parser, so a sanitizer that runs BEFORE parsing sees a
//     different string than the parser does
//   - parses as a WHATWG URL
//   - https scheme only (rejects http:, javascript:, data:, file:,
//     blob:, vbscript:, mailto:, tel:, ftp:, ws:/wss:)
//   - no userinfo (rejects "https://evil.com@target.host/..." smuggle)
//   - no explicit port (so `host` matches `hostname` for host equality)
//   - no hash fragment (anti-injection on downstream renderers that
//     might naively concatenate)
//
// Callers add host/path/grammar checks on top of the parsed URL.

export const MAX_URL_LENGTH = TEXT_MAX.url

/**
 * Returns true if the input contains a backslash or any C0 control
 * char or DEL. The source file contains no embedded control bytes -
 * we scan via charCodeAt to keep diffs/git-blame clean.
 */
export function hasForbiddenUrlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x5c) return true // backslash
    if (c < 0x20) return true // C0 control chars (NUL/TAB/CR/LF/etc.)
    if (c === 0x7f) return true // DEL
  }
  return false
}

/**
 * Returns the parsed WHATWG URL if the input passes the full safe-
 * https gate (see module-header comment for the policy). Returns
 * null for ANY rejection. NEVER throws.
 *
 * Callers should add their own host / path / id-grammar checks on
 * the returned URL. The WHATWG normalisation guarantees `parsed.host`
 * is lowercased and IDN-encoded to Punycode (so `parsed.host ===
 * 'www.youtube.com'` rejects xn--... homoglyphs by exact equality).
 */
export function parseStrictHttpsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return null
  if (hasForbiddenUrlChar(raw)) return null
  if (raw !== raw.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.port !== '') return null
  if (parsed.hash !== '') return null
  return parsed
}
