// Classify a request's `Host` header into routability tiers so the
// CSP + HSTS layer can decide whether to emit `upgrade-insecure-requests`
// and `Strict-Transport-Security`.
//
// Why this matters (cf. ~/.claude/CLAUDE.md #0.19): Safari uniquely
// honours both directives on `localhost` / `127.0.0.1` / LAN-IP dev
// servers — Chrome ignores both on loopback per RFC 6761. With
// upgrade-insecure-requests the browser rewrites every `http://localhost:<port>/*`
// asset request to `https://` mid-flight; with HSTS the host stays
// pinned to HTTPS for two years inside `~/Library/Cookies/HSTS.plist`.
// Either one renders the page unstyled when there is no TLS listener.
//
// The CLI's laptop / cpanel / manual install surfaces run with
// NODE_ENV=production but serve from localhost (or the operator's
// LAN). Gating on isProd alone leaves those installs broken in
// Safari. Adding the host check fixes them without weakening
// production-domain installs.

export type HostKind = 'loopback' | 'lan' | 'public'

// `0.0.0.0` (the "all interfaces" address, never a real site host) and the
// IPv6 unspecified `::` / `[::]` count as loopback for our purposes — a Site
// URL or Host pointed at any of these can never be reached from the outside.
const LOOPBACK_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1?|\[::1?\])$/i
// Private-use ranges from RFC 1918 + RFC 6598 + link-local + mDNS. A
// release served from one of these is reachable only on the LAN; HSTS
// pinning it to HTTPS would lock out every device on the network
// after the first visit.
const RFC1918_10  = /^10(?:\.\d{1,3}){3}$/
const RFC1918_172 = /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/
const RFC1918_192 = /^192\.168(?:\.\d{1,3}){2}$/
const CGNAT       = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/
const LINK_LOCAL  = /^169\.254(?:\.\d{1,3}){2}$/
const MDNS        = /\.local\.?$/i

// Strip a trailing `:port` to get the bare hostname, WITHOUT mangling IPv6.
// `host.split(':')[0]` is wrong for IPv6: `[::1]:3040` → `[` and `::1` → ``.
// Rules: bracketed IPv6 (`[::1]` / `[::1]:port`) → keep through the `]`; bare
// host with a single `:digits` suffix → strip it; bare IPv6 (multiple colons,
// no brackets, e.g. `::1` / `2001:db8::1`) → leave as-is.
function bareHostname(host: string): string {
  const h = host.trim()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return (end >= 0 ? h.slice(0, end + 1) : h).toLowerCase()
  }
  const first = h.indexOf(':')
  if (first === -1) return h.toLowerCase()
  // Multiple colons with no brackets → bare IPv6 (no port). One colon → host:port.
  return (first === h.lastIndexOf(':') ? h.slice(0, first) : h).toLowerCase()
}

/**
 * Classify a Host header. Strips any port suffix before matching.
 * Returns 'public' when no host is supplied — the conservative default
 * keeps production-domain installs unaffected if the header is unset.
 */
export function classifyHost(host: string | null | undefined): HostKind {
  if (!host) return 'public'
  const hostname = bareHostname(host)
  if (!hostname) return 'public'
  if (LOOPBACK_RE.test(hostname)) return 'loopback'
  if (
    RFC1918_10.test(hostname) ||
    RFC1918_172.test(hostname) ||
    RFC1918_192.test(hostname) ||
    CGNAT.test(hostname) ||
    LINK_LOCAL.test(hostname) ||
    MDNS.test(hostname)
  ) {
    return 'lan'
  }
  return 'public'
}

/** True for hosts where HSTS + upgrade-insecure-requests must be
 *  suppressed even in production (laptop / LAN installs). */
export function isUnroutableForHsts(host: string | null | undefined): boolean {
  const kind = classifyHost(host)
  return kind !== 'public'
}

/**
 * True when a full URL points at a loopback host (`localhost`, `127.0.0.0/8`,
 * `::1`, `0.0.0.0`). Used to reject a misconfigured Site URL — a public install
 * pointed at loopback can't be reached for health checks, sitemap, or emails.
 * `new URL(url).hostname` normalises the host (brackets kept for IPv6), so this
 * sidesteps the raw-Host-header parsing quirks. Returns false on a non-URL.
 */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    return classifyHost(new URL(url).hostname) === 'loopback'
  } catch {
    return false
  }
}
