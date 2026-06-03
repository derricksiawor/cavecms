import { timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import { getSetting } from '@/lib/cms/getSettings'
import { getResolvedLoginPath } from '@/lib/security/getResolvedLoginPath'
import { isInstalled } from '@/lib/install/installState'

// Internal middleware-feeding endpoint. Middleware runs on the Edge
// runtime and CANNOT call Drizzle/MariaDB directly. It hits this
// route over loopback per-request (cached module-level for ~3s) to
// learn the live security configuration: resolved login path, IP
// allow/blocklists, maintenance mode, suspicious-request toggles.
//
// Auth model is identical to /api/internal/revalidate-tags:
//   - Bearer INTERNAL_REVALIDATE_SECRET (b64token charset).
//   - Constant-time padded comparison defeats length-probing.
//   - nginx allow-loopback-only block in front (defence in depth).
//
// Why share the secret with revalidate-tags: both are
// loopback-only operational endpoints; an attacker who has either
// secret already has shell on the box. Keeping them on one secret
// reduces rotation surface without weakening either.
//
// The response body INTENTIONALLY does not include reCAPTCHA secrets,
// login thresholds, or the verify-recaptcha hash table — middleware
// has no use for those. Minimising the payload shrinks the loopback
// surface AND makes a hypothetical bearer leak less catastrophic.

export const dynamic = 'force-dynamic'

const BEARER_RE = /^Bearer ([A-Za-z0-9+/=._~-]+)$/

// Loopback-only at the application layer. Primary defence is the
// nginx `^~ /api/internal/` allow-127.0.0.1/::1 block; this Host
// header check is defence in depth so a future infra change (port
// exposed for debugging, nginx config drift, Cloudflare Worker added
// upstream) doesn't turn a single bearer leak into a remote-disclose
// primitive. Loopback callers (middleware, cron) set Host explicitly
// to 127.0.0.1:PORT in the fetch call.
//
// RUNTIME ASSUMPTION: Node's HTTP server normalises HTTP/2
// `:authority` into the `host` header so reading `req.headers.get('host')`
// covers both. If this route ever moves to a different runtime (Edge,
// Workers) that exposes `:authority` separately, ALSO check that
// pseudo-header explicitly before trusting the request as loopback.
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)(?::\d+)?$/

function authorized(req: Request): boolean {
  // Hostname check FIRST — short-circuits before any crypto work for
  // the dominant rejected case.
  const host = (req.headers.get('host') ?? '').toLowerCase()
  // In dev, the user's machine hostname may surface — accept loopback
  // hosts only. Production traffic via nginx always rewrites Host to
  // the public hostname; loopback callers set Host explicitly to
  // 127.0.0.1:PORT in the fetch call.
  if (!LOOPBACK_HOST_RE.test(host)) return false

  const auth = req.headers.get('authorization') ?? ''
  const m = BEARER_RE.exec(auth)
  const expected = Buffer.from(env.INTERNAL_REVALIDATE_SECRET, 'utf8')
  const raw = m && m[1] ? m[1] : ''
  const presented = Buffer.from(raw, 'utf8')
  const padded = Buffer.alloc(expected.length)
  presented.copy(padded, 0, 0, Math.min(presented.length, expected.length))
  const eq = timingSafeEqual(padded, expected)
  return presented.length === expected.length && eq
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  // Read everything in parallel; all reads are independent and each
  // is cached + tag-revalidated via getSetting(). Integration toggles
  // are included so middleware can extend the CSP per provider; only
  // the enable booleans + SalesIQ region cross the loopback (no
  // creds, no IDs — those aren't middleware's business).
  const [
    loginPath,
    ipLists,
    maintenance,
    suspicious,
    gtm,
    ga4,
    googleAds,
    hotjar,
    salesiq,
    hubspot,
    installed,
    indexnow,
  ] = await Promise.all([
    getResolvedLoginPath(),
    getSetting('security_ip_lists'),
    getSetting('security_maintenance'),
    getSetting('security_suspicious_blocks'),
    getSetting('integrations_gtm'),
    getSetting('integrations_ga4'),
    getSetting('integrations_google_ads'),
    getSetting('integrations_hotjar'),
    getSetting('integrations_zoho_salesiq'),
    getSetting('integrations_hubspot'),
    // Install state — middleware uses this to redirect fresh deploys
    // to /install instead of serving a half-broken site.
    isInstalled(),
    // IndexNow key — middleware serves the `/{key}.txt` verification
    // file at the edge (it can't read the DB). Only the key string
    // crosses loopback, and only when IndexNow is enabled.
    getSetting('seo_indexnow'),
  ])

  return jsonResponse(
    {
      loginPath: loginPath.toLowerCase(),
      installed,
      ipAllowlist: ipLists.allowlist,
      ipBlocklist: ipLists.blocklist,
      maintenance: {
        enabled: maintenance.enabled,
        message: maintenance.message,
        bypassIps: maintenance.bypassIps,
      },
      suspicious: {
        blockMissingUserAgent: suspicious.blockMissingUserAgent,
        blockBotUaPatterns: suspicious.blockBotUaPatterns,
        blockProbePaths: suspicious.blockProbePaths,
      },
      integrations: {
        gtm: gtm.enabled,
        ga4: ga4.enabled,
        googleAds: googleAds.enabled,
        hotjar: hotjar.enabled,
        zohoSalesIqRegion: salesiq.enabled ? salesiq.region : null,
        hubspotTracking: hubspot.enabled && hubspot.trackingEnabled,
      },
      // Break-glass flags exposed so middleware short-circuits the
      // allowlist check without needing to read process.env itself
      // (it could, but keeping env access on the Node side keeps
      // the Edge bundle dependency-free).
      disableIpAllowlist: env.SECURITY_DISABLE_IP_ALLOWLIST,
      // null unless IndexNow is enabled AND a key is generated. The
      // schema validates the key charset, so middleware can safely build
      // the `/{key}.txt` path from it without re-sanitising.
      indexNowKey: indexnow.enabled && indexnow.key ? indexnow.key : null,
    },
    200,
  )
}
