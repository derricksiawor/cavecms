import { parseStrictHttpsUrl } from './url-guard'

// Single source of truth for the VideoEmbed widget's host policy.
//
// Operators paste a video URL into the drawer. Anything not produced by
// `parseVideoEmbedUrl` is rejected at the Zod boundary BEFORE the URL
// reaches the renderer or the database. The renderer reconstructs the
// embed URL from the structured `{ kind, id }` output - it never echoes
// operator-supplied origin/path/query, so a future host bypass cannot
// turn into stored XSS or an iframe SSRF.
//
// The general "is this a safe https URL" gate lives in `url-guard.ts`
// (shared with SocialIcons URL validation). THIS file adds the
// VideoEmbed-specific host allowlist and per-host id grammar.
//
// Adversarial cases the gate must defeat (tests/unit/videoHostAllowlist.test.ts):
//   - protocol-relative ("//evil.com/embed/foo")
//   - bare path ("/embed/foo")
//   - non-https schemes (javascript:, data:, file:, http:)
//   - userinfo smuggle ("https://evil.com@youtube.com/...")
//   - IDN/Punycode homoglyph (xn--yutube-...)
//   - backslash in URL (special-scheme parser converts to /)
//   - percent-encoded slashes
//   - subdomain collisions ("evil-youtube.com", "youtube.com.evil.com")
//   - control chars (NUL/CR/LF/TAB/DEL - silently stripped by parser)
//   - trailing-dot FQDN ("www.youtube.com./embed/...")
//   - empty/whitespace/oversize

export type VideoEmbedKind = 'youtube' | 'vimeo'

export interface ParsedVideoEmbed {
  kind: VideoEmbedKind
  /** Opaque per-host video id. Renderer reconstructs the embed URL
   *  from `kind` + `id` - operator origin/path/query never reach
   *  the iframe `src`. */
  id: string
}

const YOUTUBE_HOST = 'www.youtube.com'
const VIMEO_HOST = 'player.vimeo.com'

// YouTube: 11 alphanum/_- per /watch?v= and /embed/ convention.
// Vimeo: 6-12 digits (numeric ids only on player.vimeo.com).
// Both derived from official docs. Conservative caps - a longer "id"
// is a malformed path or a smuggling attempt.
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/
const VIMEO_ID_RE = /^[0-9]{6,12}$/

/**
 * Returns `{ kind, id }` if the input is an https://www.youtube.com/embed/...
 * or https://player.vimeo.com/video/... URL whose id matches the host's
 * canonical id grammar. Returns `null` for ANY other input.
 *
 * NEVER throws. NEVER allocates a fallback. Callers must check for null
 * and reject the input upstream (Zod boundary in block-registry.ts).
 */
export function parseVideoEmbedUrl(raw: unknown): ParsedVideoEmbed | null {
  const parsed = parseStrictHttpsUrl(raw)
  if (!parsed) return null

  // Host equality is the trust gate. WHATWG normalises IDN to
  // Punycode in `host`, so xn--... homoglyphs read as exact strings
  // here. A matching subdomain ("foo.youtube.com") fails this strict
  // equality - by design. Trailing-dot FQDN ("www.youtube.com.") is
  // a different string than YOUTUBE_HOST and is rejected via the
  // same exact-equality check.
  if (parsed.host === YOUTUBE_HOST) {
    const m = parsed.pathname.match(/^\/embed\/([^/]+)$/)
    if (!m) return null
    const id = m[1] ?? ''
    if (!YOUTUBE_ID_RE.test(id)) return null
    return { kind: 'youtube', id }
  }

  if (parsed.host === VIMEO_HOST) {
    const m = parsed.pathname.match(/^\/video\/([^/]+)$/)
    if (!m) return null
    const id = m[1] ?? ''
    if (!VIMEO_ID_RE.test(id)) return null
    return { kind: 'vimeo', id }
  }

  return null
}

/**
 * Build the embed URL the iframe `src` will use. Derived solely from
 * `kind` + `id` - the operator's original URL is never echoed back.
 *
 * Caller is responsible for passing the result through to an iframe
 * with the correct sandbox (`allow-scripts allow-same-origin allow-popups`
 * - NEVER `allow-top-navigation`).
 */
export function buildEmbedSrc(parsed: ParsedVideoEmbed): string {
  if (parsed.kind === 'youtube') {
    // youtube-nocookie reduces tracking surface. modestbranding + rel=0
    // suppress YT promo overlays which look out of place on a luxury
    // site.
    return `https://www.youtube-nocookie.com/embed/${parsed.id}?modestbranding=1&rel=0`
  }
  // Vimeo: byline/title/portrait off for the same reason.
  return `https://player.vimeo.com/video/${parsed.id}?byline=0&title=0&portrait=0`
}
