import { NextResponse, type NextRequest } from 'next/server'
import { verifySessionJwt } from '@/lib/auth/jwt'
import { SESSION_COOKIE } from '@/lib/auth/cookies'
import { SLUG_MAX, SLUG_MIN, SLUG_RE } from '@/lib/cms/slug'
import { RESERVED } from '@/lib/cms/page-slug'
import { cidrListMatch, clientIpFromRequest } from '@/lib/security/ipMatch'
import { classifySuspicious } from '@/lib/security/suspiciousRequest'
import { buildCsp, type IntegrationsCspFlags } from '@/lib/security/buildCsp'

// Middleware runs on the default Edge runtime. All imports above are
// Edge-compatible:
//   - next/server is Edge-native
//   - jose (used by verifySessionJwt) ships an Edge build with no Node
//     dependencies
//   - SESSION_COOKIE is a string constant
//   - lib/cms/slug + lib/cms/page-slug are pure regex/Set constants
//   - lib/security/ipMatch + suspiciousRequest are pure regex/byte
//     helpers — no node:net, no node:crypto
// The nonce generator below uses Web Crypto API
// (`crypto.getRandomValues` + `btoa`), both globally available in Edge
// + Node 22+. No `node:crypto`, no `runtime: 'nodejs'`, no
// `experimental.nodeMiddleware` flag — runs on the default Edge runtime
// in the same shape Next supports out of the box.
//
// LOGIN_PATH RESOLUTION
// The admin-editable LOGIN_PATH lives in DB settings (with env
// fallback). Middleware can't call Drizzle from Edge, so it fetches a
// pre-computed config over loopback from /api/internal/security-config.
// The config is cached module-level for SECURITY_CACHE_TTL_MS so
// per-request loopback work stays bounded. On fetch failure the
// previous good value is reused — a transient DB hiccup cannot make
// the live login path unreachable.

export const config = {
  matcher: ['/((?!_next/static|_next/image|uploads/|favicon\\.ico).*)'],
}

// Bootstrap fallback only — used when the security-config fetch fails
// AND we have no cached value yet (cold start during outage). Reading
// process.env.LOGIN_PATH after env.ts has parsed is safe — boot would
// have refused on an invalid value.
const ENV_LOGIN_PATH_LOWER = (process.env['LOGIN_PATH'] ?? '').toLowerCase()

interface SecurityConfig {
  loginPath: string
  ipAllowlist: { enabled: boolean; cidrs: string[] }
  ipBlocklist: { enabled: boolean; cidrs: string[] }
  maintenance: { enabled: boolean; message: string; bypassIps: string[] }
  suspicious: {
    blockMissingUserAgent: boolean
    blockBotUaPatterns: boolean
    blockProbePaths: boolean
  }
  integrations?: IntegrationsCspFlags
  disableIpAllowlist: boolean
}

const SECURITY_CACHE_TTL_MS = 3000

interface ConfigCache {
  ts: number
  data: SecurityConfig | null
}

// Pinned to globalThis so HMR doesn't reset the cache between requests
// in dev (the rate-limit module uses the same trick).
declare global {
  var __bwcSecurityCfg: ConfigCache | undefined
}

// Cold-start bootstrap when neither cache nor a successful fetch are
// available. We can't reach the DB from Edge, so the only inputs we
// have are env-derived. Returns a config that:
//   - keeps suspicious / blocklist / allowlist / maintenance OFF
//     (we don't know the operator's lists)
//   - honours the SECURITY_DISABLE_* break-glass envs the same way
//     the live config would
//   - resolves loginPath to env.LOGIN_PATH (the bootstrap fallback)
// Net effect: during a cold-start outage, the site is reachable
// without spurious 404s, but allow/blocklists aren't enforced until
// the DB is back. This is the only safe behaviour given the
// constraints — defaulting to "deny" would lock everyone out.
function bootstrapSecurityConfig(): SecurityConfig {
  return {
    loginPath: ENV_LOGIN_PATH_LOWER,
    ipAllowlist: { enabled: false, cidrs: [] },
    ipBlocklist: { enabled: false, cidrs: [] },
    maintenance: { enabled: false, message: '', bypassIps: [] },
    suspicious: {
      blockMissingUserAgent: false,
      blockBotUaPatterns: false,
      blockProbePaths: false,
    },
    integrations: {
      gtm: false, ga4: false, googleAds: false, hotjar: false,
      zohoSalesIqRegion: null, hubspotTracking: false,
    },
    disableIpAllowlist:
      process.env['SECURITY_DISABLE_IP_ALLOWLIST'] === '1' ||
      process.env['SECURITY_DISABLE_IP_ALLOWLIST']?.toLowerCase() === 'true',
  }
}

async function getSecurityConfig(_req: NextRequest): Promise<SecurityConfig | null> {
  const cached = globalThis.__bwcSecurityCfg
  if (cached && Date.now() - cached.ts < SECURITY_CACHE_TTL_MS) return cached.data
  const secret = process.env['INTERNAL_REVALIDATE_SECRET'] ?? ''
  // Empty secret would always 401 — short-circuit so we don't burn a
  // round-trip on every middleware call before the operator finishes
  // env setup. Returns last-known good or bootstrap fallback.
  if (!secret) {
    const fallback = cached?.data ?? bootstrapSecurityConfig()
    globalThis.__bwcSecurityCfg = { ts: Date.now(), data: fallback }
    return fallback
  }
  // Loopback target — NOT the public origin. Using `req.nextUrl.origin`
  // would resolve to the public HTTPS hostname, hit nginx, and 403 at
  // the `/api/internal/` loopback gate (scripts/nginx/bwc.conf.template
  // restricts that location to 127.0.0.1 / ::1). Every middleware call
  // would silently fail-open. Drive the URL straight to the local Node
  // listener instead, matching the pattern in scripts/cron-purge.ts.
  // Forward the public Host header so any downstream host-aware logic
  // sees the originating hostname.
  const port = process.env['PORT'] ?? '3040'
  const url = `http://127.0.0.1:${port}/api/internal/security-config`
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${secret}`,
        // Loopback Host explicitly — the internal endpoint requires
        // the Host header to be loopback so a future infra change
        // (port exposed, nginx drift) can't turn a leaked bearer into
        // a remote-disclose primitive. fetch() defaults Host to the
        // URL's host (127.0.0.1:PORT) but setting it explicitly here
        // documents the contract.
        host: `127.0.0.1:${port}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) {
      // Bump ts so we don't hammer a failing endpoint, but PRESERVE
      // the last-known-good data so a transient DB hiccup doesn't
      // strand the live LOGIN_PATH or relax security to defaults.
      // On cold start with no cached data, fall back to bootstrap
      // (env-derived) config — site stays reachable, gates open
      // until DB recovers. Documented trade-off.
      const fallback = cached?.data ?? bootstrapSecurityConfig()
      globalThis.__bwcSecurityCfg = { ts: Date.now(), data: fallback }
      return fallback
    }
    const data = (await res.json()) as SecurityConfig
    globalThis.__bwcSecurityCfg = { ts: Date.now(), data }
    return data
  } catch {
    const fallback = cached?.data ?? bootstrapSecurityConfig()
    globalThis.__bwcSecurityCfg = { ts: Date.now(), data: fallback }
    return fallback
  }
}

// 16 random bytes → 24-char base64 string. CSP3 § 6.6.3.1 requires a
// nonce of at least 128 bits of entropy; 16 bytes = 128 bits exactly.
function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

const isProd = process.env.NODE_ENV === 'production'

function adminPath(p: string): boolean {
  return p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin/') || p.startsWith('/api/cms/')
}

async function authGate(req: NextRequest): Promise<NextResponse | null> {
  const p = req.nextUrl.pathname
  const needsAuth = adminPath(p) || p === '/api/auth/logout'
  if (!needsAuth) return null
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const ok = token ? await verifySessionJwt(token).then(() => true).catch(() => false) : false
  if (ok) return null
  if (p.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const url = req.nextUrl.clone()
  url.pathname = '/'
  const r = NextResponse.redirect(url, 307)
  r.headers.set('cache-control', 'private, no-store')
  return r
}

// 404 with no body — the operator-facing "this URL doesn't exist".
// Used for: suspicious-request matches, IP-allowlist failures on
// /admin/*. We DELIBERATELY don't 403 the allowlist case so the
// existence of the gate isn't observable (a 403 confirms /admin
// exists at that origin).
function notFoundResponse(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: { 'cache-control': 'private, no-store' },
  })
}

// 403 used ONLY for explicit blocklist matches — operator has
// affirmatively said "this IP should be blocked, anywhere on the
// site". Different signal from 404 (allowlist) so the operator can
// distinguish the two in logs / their own monitoring.
function forbiddenResponse(): NextResponse {
  return new NextResponse(null, {
    status: 403,
    headers: { 'cache-control': 'private, no-store' },
  })
}

function maintenanceResponse(message: string): NextResponse {
  // Plain text + 503 so search engines treat it as temporary and
  // crawlers back off without dropping the site from the index.
  // `Retry-After: 120` per RFC 7231 §7.1.3 — a soft signal that the
  // outage is short.
  return new NextResponse(message, {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '120',
    },
  })
}

const SINGLE_SEGMENT_RE = /^\/([^/]+)$/

function refuseInternalPageRoute(pathname: string): NextResponse | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname).toLowerCase()
  } catch {
    return new NextResponse(null, { status: 400 })
  }
  if (decoded === '/_page' || decoded.startsWith('/_page/')) {
    return new NextResponse(null, { status: 404 })
  }
  return null
}

function maybeRewriteToPageRoute(pathname: string, loginPathLower: string): string | null {
  const m = SINGLE_SEGMENT_RE.exec(pathname)
  if (!m) return null
  const captured = m[1]!
  if (captured.length < SLUG_MIN || captured.length > SLUG_MAX) return null
  if (captured.startsWith('.')) return null
  const lowered = captured.toLowerCase()
  if (RESERVED.has(lowered)) return null
  if (loginPathLower && lowered === loginPathLower) return null
  if (!SLUG_RE.test(captured)) return null
  return `/_page/${captured}`
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname

  // Loopback security-config endpoint: bypass everything else so
  // the middleware doesn't fetch itself in a recursive loop. Auth on
  // that route is bearer-based — middleware adds no value here.
  if (pathname === '/api/internal/security-config' || pathname.startsWith('/api/internal/')) {
    return NextResponse.next()
  }

  // Pull live security config (cached). Failures fall back to the
  // last known good (or null + bootstrap defaults). When null, the
  // suspicious / blocklist / allowlist / maintenance gates all
  // short-circuit as "no enforcement" — fail-open so a transient DB
  // hiccup doesn't shutter the site.
  const cfg = await getSecurityConfig(req)

  // Resolve the saver IP once — used by blocklist, maintenance bypass,
  // and any future per-IP logic. clientIpFromRequest returns '0.0.0.0'
  // when no trusted x-real-ip is present, which falls through all
  // CIDR checks unless the operator explicitly lists '0.0.0.0/0'
  // (which would be operator error caught at PATCH time).
  const ip = clientIpFromRequest(req)

  // 1. Suspicious-request classifier. 404 on match so the bot doesn't
  //    learn which rule fired. Patterns live in code; toggles in DB.
  if (cfg?.suspicious) {
    const matched = classifySuspicious(req, cfg.suspicious)
    if (matched) return notFoundResponse()
  }

  // 2. Explicit IP blocklist. 403 (distinct from 404 above) so the
  //    operator's own monitoring can tell them apart.
  if (cfg?.ipBlocklist?.enabled && cfg.ipBlocklist.cidrs.length > 0) {
    if (cidrListMatch(ip, cfg.ipBlocklist.cidrs)) return forbiddenResponse()
  }

  // 3. /admin/* IP allowlist. 404 (NOT 403) so the gate's existence
  //    isn't observable from outside the allowlist. SECURITY_DISABLE_
  //    IP_ALLOWLIST env (read by the internal endpoint, surfaced via
  //    cfg.disableIpAllowlist) short-circuits — break-glass after a
  //    botched allowlist save.
  if (
    cfg?.ipAllowlist?.enabled &&
    cfg.ipAllowlist.cidrs.length > 0 &&
    !cfg.disableIpAllowlist &&
    adminPath(pathname)
  ) {
    if (!cidrListMatch(ip, cfg.ipAllowlist.cidrs)) return notFoundResponse()
  }

  // 4. Existing auth gate — /admin/*, /api/admin/*, /api/cms/*,
  //    /api/auth/logout. Unauthed pages → 307 /, APIs → 401.
  const denied = await authGate(req)
  if (denied) return denied

  // 5. Maintenance mode. Applied to PUBLIC paths AND public POST
  //    endpoints (lead intake / contact form) — otherwise an operator
  //    expecting "no traffic during maintenance" would still see lead
  //    inserts and emails firing. Carved out:
  //      - /admin, /api/admin, /api/cms (already auth-gated)
  //      - /api/internal (loopback only)
  //      - /api/auth (logout etc — operators may still be active)
  //      - /_next (asset serving for the maintenance page itself)
  //    Operator's bypassIps lets them keep browsing the live site.
  if (
    cfg?.maintenance?.enabled &&
    !adminPath(pathname) &&
    !pathname.startsWith('/api/admin/') &&
    !pathname.startsWith('/api/internal/') &&
    !pathname.startsWith('/api/auth/') &&
    !pathname.startsWith('/_next/') &&
    !cidrListMatch(ip, cfg.maintenance.bypassIps)
  ) {
    return maintenanceResponse(cfg.maintenance.message)
  }

  // 6. Block 1: refuse direct /_page requests.
  const internalDenied = refuseInternalPageRoute(pathname)
  if (internalDenied) return internalDenied

  // Resolve LOGIN_PATH — DB-backed value via cfg, else env bootstrap.
  // Lowercased once; used to skip the CMS-rewrite for the configured
  // admin login segment.
  const loginPathLower = (cfg?.loginPath ?? ENV_LOGIN_PATH_LOWER).toLowerCase()

  const nonce = generateNonce()
  const reqHeaders = new Headers(req.headers)
  reqHeaders.set('x-csp-nonce', nonce)
  reqHeaders.set('x-pathname', pathname)

  // 7. Block 2: single-segment rewrite to /_page/{slug}, unless the
  //    segment matches the resolved LOGIN_PATH (then let the dynamic
  //    /(auth)/[loginPath] route serve it).
  const rewriteTarget = maybeRewriteToPageRoute(pathname, loginPathLower)
  let res: NextResponse
  if (rewriteTarget) {
    const url = req.nextUrl.clone()
    url.pathname = rewriteTarget
    res = NextResponse.rewrite(url, { request: { headers: reqHeaders } })
  } else {
    res = NextResponse.next({ request: { headers: reqHeaders } })
  }

  res.headers.set('Content-Security-Policy', buildCsp(nonce, isProd, cfg?.integrations))

  if (pathname.startsWith('/newsletter/confirm/') || pathname === '/unsubscribe') {
    res.headers.set('X-Robots-Tag', 'noindex, nofollow')
  }
  if (
    !pathname.startsWith('/api/') &&
    req.nextUrl.searchParams.has('preview')
  ) {
    res.headers.set('X-Robots-Tag', 'noindex, nofollow')
    res.headers.set('Referrer-Policy', 'no-referrer')
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  }
  return res
}
