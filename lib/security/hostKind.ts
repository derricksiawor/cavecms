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

const LOOPBACK_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i
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

/**
 * Classify a Host header. Strips any port suffix before matching.
 * Returns 'public' when no host is supplied — the conservative default
 * keeps production-domain installs unaffected if the header is unset.
 */
export function classifyHost(host: string | null | undefined): HostKind {
  if (!host) return 'public'
  const hostname = host.split(':')[0]?.toLowerCase().trim() ?? ''
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
