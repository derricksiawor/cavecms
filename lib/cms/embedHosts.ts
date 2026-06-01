import { parseStrictHttpsUrl } from './url-guard'

// lx_embed Tier-1 oEmbed allowlist. The operator pastes a normal share
// URL; we accept ONLY a curated set of well-known embed hosts and
// normalise each to its canonical iframe-embeddable src. Anything else
// returns null → the schema refine rejects it at the write boundary, so
// the renderer never has to defend against an arbitrary iframe source.
//
// EVERY host produced here MUST also be present in frame-src
// (lib/security/buildCsp.ts) or the iframe loads blank. Keep the two in
// lockstep. Raw-HTML srcdoc embeds are deliberately NOT supported (a
// documented Tier-2 future add) — the entire sanitize boundary exists
// to prevent inlined operator HTML.

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/
const VIMEO_ID_RE = /^\d{1,12}$/
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{1,40}$/
const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist'])
const SLUG_RE = /^[A-Za-z0-9._-]{1,80}$/

/** Returns a canonical, frame-src-allowlisted iframe src for a supported
 *  embed URL, or null when the URL isn't on the allowlist. */
export function toEmbedSrc(input: string): string | null {
  const url = parseStrictHttpsUrl(input)
  if (!url) return null
  const host = url.hostname
  const path = url.pathname

  // ─── YouTube → privacy-enhanced nocookie embed ───
  if (host === 'www.youtube.com' || host === 'youtube.com') {
    if (path === '/watch') {
      const v = url.searchParams.get('v')
      return v && YT_ID_RE.test(v) ? `https://www.youtube-nocookie.com/embed/${v}` : null
    }
    if (path.startsWith('/embed/')) {
      const id = path.slice('/embed/'.length)
      return YT_ID_RE.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
    }
    return null
  }
  if (host === 'youtu.be') {
    const id = path.slice(1)
    return YT_ID_RE.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null
  }

  // ─── Vimeo ───
  if (host === 'vimeo.com') {
    const id = path.slice(1)
    return VIMEO_ID_RE.test(id) ? `https://player.vimeo.com/video/${id}` : null
  }
  if (host === 'player.vimeo.com') {
    return path.startsWith('/video/') && VIMEO_ID_RE.test(path.slice('/video/'.length))
      ? `https://player.vimeo.com/video/${path.slice('/video/'.length)}`
      : null
  }

  // ─── Spotify ───
  if (host === 'open.spotify.com') {
    const parts = path.split('/').filter(Boolean) // [type, id]
    const [type, id] = parts
    if (parts.length === 2 && SPOTIFY_TYPES.has(type!) && SPOTIFY_ID_RE.test(id!)) {
      return `https://open.spotify.com/embed/${type}/${id}`
    }
    return null
  }

  // ─── CodePen → /embed/ ───
  if (host === 'codepen.io') {
    const parts = path.split('/').filter(Boolean) // [user, 'pen'|'embed', id]
    if (parts.length === 3 && (parts[1] === 'pen' || parts[1] === 'embed') && SLUG_RE.test(parts[0]!) && SLUG_RE.test(parts[2]!)) {
      return `https://codepen.io/${parts[0]}/embed/${parts[2]}`
    }
    return null
  }

  // ─── SoundCloud player (operator pastes the embed player URL) ───
  // Rebuild from the PARSED url's components (already past the control-
  // char / backslash / userinfo / port gate) rather than echoing the
  // raw input, so the canonical-src invariant holds for every branch.
  if (host === 'w.soundcloud.com' && (path === '/player' || path === '/player/')) {
    return `https://w.soundcloud.com/player${url.search}`
  }

  // ─── CodeSandbox → /embed/ ───
  if (host === 'codesandbox.io') {
    const parts = path.split('/').filter(Boolean) // ['s'|'embed', id]
    if (parts.length >= 2 && (parts[0] === 's' || parts[0] === 'embed') && SLUG_RE.test(parts[1]!)) {
      return `https://codesandbox.io/embed/${parts[1]}`
    }
    return null
  }

  return null
}

export function isAllowedEmbedUrl(input: string): boolean {
  return toEmbedSrc(input) !== null
}
