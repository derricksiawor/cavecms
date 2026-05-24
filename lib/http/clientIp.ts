import { isIP } from 'node:net'

// Resolve the client IP from request headers.
//
// DEPLOYMENT ASSUMPTION (per Plan 09 setup.sh + install-nginx.sh):
// The site runs on a single droplet behind nginx. nginx is
// configured with `proxy_set_header X-Real-IP $remote_addr` so
// every upstream request carries the verified client IP in
// `x-real-ip` and the socket address is always loopback. We
// INTENTIONALLY do not consult `x-forwarded-for` because:
//   1. With nginx setting X-Real-IP, XFF is redundant.
//   2. Without nginx (or with a misconfigured proxy), XFF can be
//      spoofed by the client. Trusting it would let an attacker
//      attribute their requests to any IP they want, defeating
//      rate-limiting and confusing audit logs.
// If this site is ever fronted by Cloudflare or another CDN, the
// edge MUST also set X-Real-IP (Cloudflare: enable the Transform
// Rule that copies CF-Connecting-IP into X-Real-IP, OR change this
// function to read CF-Connecting-IP directly).
//
// Returns null when no trusted IP can be determined — callers
// typically fall back to '0.0.0.0' for rate-limit bucketing or
// NULL for audit_log.ip.
export function clientIpFromHeaders(
  h: Record<string, string | undefined>,
  socketRemoteAddress: string,
): string | null {
  if (socketRemoteAddress === '127.0.0.1' || socketRemoteAddress === '::1') {
    const candidate = h['x-real-ip']
    if (candidate && isIP(candidate)) return candidate
    return null
  }
  return isIP(socketRemoteAddress) ? socketRemoteAddress : null
}
