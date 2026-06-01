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
    // Laptop / bare-node surface: there is NO reverse proxy to set
    // `x-real-ip`, yet the operator genuinely IS local (single-host
    // install). Resolving the loopback address lets the anti-lockout
    // features — maintenance mode + the IP allow/block lists — actually
    // be enabled from the dashboard; on the `0.0.0.0` sentinel their
    // guards (lib/security/patchGuards.ts) refuse, so those features are
    // permanently dead on a laptop install otherwise.
    //
    // Gated on the laptop surface ONLY (CAVECMS_RESTART_MODE === 'laptop',
    // written into env.production by the CLI for that surface). On
    // vps / pm2 / cpanel the install is proxied and still REQUIRES a real
    // `x-real-ip` — the production trust model (don't trust spoofable
    // `x-forwarded-for`) is unchanged there.
    //
    // CAVEAT: a laptop install later exposed publicly WITHOUT forwarding
    // `X-Real-IP` (e.g. a raw tunnel) would resolve every caller to
    // 127.0.0.1 — so a public laptop install MUST forward X-Real-IP, the
    // same requirement as any proxied surface.
    if (process.env.CAVECMS_RESTART_MODE === 'laptop') return '127.0.0.1'
    return null
  }
  return isIP(socketRemoteAddress) ? socketRemoteAddress : null
}
