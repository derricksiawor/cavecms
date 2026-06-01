import { NextResponse, type NextRequest } from 'next/server'
import { verifySessionJwt } from '@/lib/auth/jwt'
import { SESSION_COOKIE } from '@/lib/auth/cookies'
import { isBearerApiToken, tokenAllowedPath } from '@/lib/auth/apiTokenScope'
import { SLUG_MAX, SLUG_MIN, SLUG_RE } from '@/lib/cms/slug'
import { RESERVED } from '@/lib/cms/page-slug'
import { escapeHtml } from '@/lib/security/escapeHtml'
import { cidrListMatch, clientIpFromRequest } from '@/lib/security/ipMatch'
import { classifySuspicious } from '@/lib/security/suspiciousRequest'
import { buildCsp, type IntegrationsCspFlags } from '@/lib/security/buildCsp'
import { isUnroutableForHsts } from '@/lib/security/hostKind'

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
  /** True once an admin user has been created via the install wizard.
   *  False on a fresh deploy → middleware redirects to /install. */
  installed: boolean
}

const SECURITY_CACHE_TTL_MS = 3000

interface ConfigCache {
  ts: number
  data: SecurityConfig | null
}

// Pinned to globalThis so HMR doesn't reset the cache between requests
// in dev (the rate-limit module uses the same trick).
declare global {
  var __cavecmsSecurityCfg: ConfigCache | undefined
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
    // Bootstrap conservatively as `installed: true` — an existing
    // production site momentarily failing security-config fetch
    // (DB hiccup, internal route cold-compile) must NOT show the
    // install wizard to live visitors. The real install_state row
    // is the canonical signal; missing config is a sign of an
    // existing install where we just can't read it right now.
    // The downside: a fresh deploy whose security-config fetch
    // fails (e.g. INTERNAL_REVALIDATE_SECRET unset) would NOT
    // redirect to /install on the bootstrap path. That's still
    // the right trade — fresh deploys quickly succeed at the
    // first cfg fetch, and /install + the wizard endpoints remain
    // reachable directly if the operator types the URL.
    installed: true,
  }
}

async function getSecurityConfig(_req: NextRequest, forceFresh = false): Promise<SecurityConfig | null> {
  const cached = globalThis.__cavecmsSecurityCfg
  if (!forceFresh && cached && Date.now() - cached.ts < SECURITY_CACHE_TTL_MS) return cached.data
  const secret = process.env['INTERNAL_REVALIDATE_SECRET'] ?? ''
  // Empty secret would always 401 — short-circuit so we don't burn a
  // round-trip on every middleware call before the operator finishes
  // env setup. Returns last-known good or bootstrap fallback.
  if (!secret) {
    const fallback = cached?.data ?? bootstrapSecurityConfig()
    globalThis.__cavecmsSecurityCfg = { ts: Date.now(), data: fallback }
    return fallback
  }
  // Loopback target — NOT the public origin. Using `req.nextUrl.origin`
  // would resolve to the public HTTPS hostname, hit nginx, and 403 at
  // the `/api/internal/` loopback gate (scripts/nginx/cavecms.conf.template
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
      globalThis.__cavecmsSecurityCfg = { ts: Date.now(), data: fallback }
      return fallback
    }
    const data = (await res.json()) as SecurityConfig
    globalThis.__cavecmsSecurityCfg = { ts: Date.now(), data }
    return data
  } catch {
    const fallback = cached?.data ?? bootstrapSecurityConfig()
    globalThis.__cavecmsSecurityCfg = { ts: Date.now(), data: fallback }
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

// `tokenAllowedPath` (the surfaces a bearer token may reach) lives in the
// edge-safe lib/auth/apiTokenScope module so middleware AND _loadAuthState
// share one definition. The cap is enforced in BOTH places: here at the
// edge, and structurally in _loadAuthState (which refuses to mint a token
// session for any other path). The settings route adds a further per-KEY
// content/branding allowlist. Edge can't hit MySQL to verify the token, so
// an allowed path with a bogus bearer is simply forwarded to a route
// handler that 401s after the DB check.

async function authGate(req: NextRequest): Promise<NextResponse | null> {
  const p = req.nextUrl.pathname
  const needsAuth = adminPath(p) || p === '/api/auth/logout'
  if (!needsAuth) return null
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const ok = token ? await verifySessionJwt(token).then(() => true).catch(() => false) : false
  if (ok) return null
  // No valid session cookie. If the request carries an API-token bearer
  // header AND targets a token-allowed surface, forward it to the route
  // handler for DB-backed verification (Edge can't reach MySQL here).
  // Any other path with a bearer — or no bearer at all — falls through to
  // the 401 / redirect below.
  const authz = req.headers.get('authorization')
  if (isBearerApiToken(authz) && tokenAllowedPath(p)) {
    return null
  }
  if (p.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  // Build the redirect from the FORWARDED host, not req.nextUrl — behind a
  // reverse proxy req.nextUrl carries the BOUND listener address (e.g.
  // `https://localhost:8201`), which would leak into the Location header and
  // send the browser to an unreachable loopback URL. Same fix the /install
  // redirect + page rewrites below apply.
  const fwdHost = req.headers.get('host') ?? req.nextUrl.host
  const fwdProto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(/:$/, '')
  const url = new URL(`${fwdProto}://${fwdHost}/`)
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

// HTML entity escape for the operator-configurable maintenance message.
// The message field is operator-edited via /admin/settings/security — a
// hostile operator isn't the threat model here, but the SAME field is
// surfaced on the public 503 to every visitor, so a careless paste of
// HTML-like text (`<3 BWC`) would otherwise render or break the page.
// escapeHtml is centralised in lib/security/escapeHtml.ts so every
// HTML-body surface (maintenance, newsletter confirm/unsubscribe,
// future error pages) shares the same primitive. See the import at
// the top of this file.

function maintenanceResponse(message: string): NextResponse {
  // Generic branded HTML 503. The page is served to the END VISITOR of
  // whichever site is running CaveCMS — it must NOT carry the
  // operator's tenant brand (no "CaveCMS", no logo) and
  // must NOT advertise CaveCMS either (visitors hitting a momentary
  // 503 should not be marketed at). Just two lines on cream with a
  // copper ambient glow, mirroring the visual language of
  // `components/HomePageEmptyState.tsx` without the tenant eyebrow.
  //
  // The operator-configurable `message` (settings → security →
  // maintenance) becomes the subtitle when set; otherwise the generic
  // "Please check back in a moment." renders. The headline is always
  // the same generic line.
  //
  // Self-contained: inline styles, system fonts, no JS, no external
  // requests. The 503 is served from middleware before Next.js's
  // asset pipeline runs, so the page can't depend on any /_next/*
  // asset (which would itself be re-routed through the maintenance
  // gate on hosts where the matcher caught it).
  //
  // Status stays 503 + `Retry-After: 120` per RFC 7231 §7.1.3 — search
  // engines back off without dropping the site from the index. SEO
  // behaviour is identical to the previous plain-text response;
  // visitors get a styled page instead.
  const subtitle =
    typeof message === 'string' && message.trim().length > 0
      ? escapeHtml(message.trim())
      : 'Please check back in a moment.'
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Updating…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>
:root{color-scheme:light}
*{margin:0;padding:0;box-sizing:border-box}
html,body{min-height:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  background:#FAF7F2;color:#0E0D0C;
  min-height:100vh;display:flex;align-items:center;justify-content:flex-start;
  padding:clamp(1.5rem,5vw,3rem);
  position:relative;overflow:hidden;
}
.glow{position:fixed;pointer-events:none;border-radius:50%;filter:blur(140px);z-index:0}
.g1{top:-8rem;left:10%;width:520px;height:520px;background:rgba(229,201,168,.4)}
.g2{bottom:-10rem;right:5%;width:480px;height:480px;background:rgba(204,165,122,.3)}
main{position:relative;z-index:1;max-width:42rem}
h1{
  font-family:ui-serif,Georgia,"Times New Roman",serif;
  font-size:clamp(2.25rem,6vw,4.5rem);
  font-weight:700;line-height:1.05;letter-spacing:-.02em;color:#0E0D0C;
}
p{
  margin-top:1.25rem;max-width:32rem;
  font-size:clamp(1rem,1.6vw,1.125rem);
  font-weight:500;line-height:1.6;color:#6F6B66;
}
@media (prefers-color-scheme:dark){
  body{background:#0E0D0C;color:#FAF7F2}
  h1{color:#FAF7F2}
  p{color:#A8A39C}
  .g1{background:rgba(184,115,51,.18)}
  .g2{background:rgba(184,115,51,.12)}
}
@media (prefers-reduced-motion:no-preference){
  main>*{opacity:0;transform:translateY(8px);animation:rise .6s ease-out forwards}
  main>h1{animation-delay:80ms}
  main>p{animation-delay:240ms}
  @keyframes rise{to{opacity:1;transform:none}}
}
</style>
</head>
<body>
<div class="glow g1" aria-hidden="true"></div>
<div class="glow g2" aria-hidden="true"></div>
<main>
<h1>This website is being updated.</h1>
<p>${subtitle}</p>
</main>
</body>
</html>`
  return new NextResponse(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '120',
    },
  })
}

const SINGLE_SEGMENT_RE = /^\/([^/]+)$/

// Internal render-route prefix. A visitor hits `/agents`; middleware
// rewrites to `/cms-render/agents` which dispatches to
// `app/cms-render/[slug]/page.tsx`. The bare slug stays in the URL bar
// — the rewrite target is internal.
const CMS_RENDER_PREFIX = '/cms-render'

// Marker request-header set on our OWN internal rewrite. See the long
// note on refuseInternalPageRoute for why this exists.
const CMS_RENDER_MARKER = 'x-cavecms-render'

// Refuse DIRECT external hits to `/cms-render/*` so the internal
// render route can't be probed at a non-canonical URL. CRITICAL
// subtlety (cost us a multi-release chase): in Next.js 15.5 standalone,
// `NextResponse.rewrite()` to a path that the middleware matcher also
// matches causes middleware to RE-EXECUTE on the rewritten path. So
// when `/agents` rewrites to `/cms-render/agents`, this guard runs a
// SECOND time against `/cms-render/agents` — and a naive
// `startsWith('/cms-render/')` refuse would 404 the app's own internal
// rewrite, producing an empty-body 404 for every CMS page (Safari then
// content-sniffs the bodyless 404 as a binary download). The fix:
// distinguish the internal re-entry from a genuine external hit via a
// marker header that ONLY our rewrite sets. External clients that spoof
// the header reach the same PUBLIC content they'd get at the canonical
// slug, so there's no escalation — the guard's job is hiding the
// internal prefix from honest probing, which it still does.
function refuseInternalPageRoute(req: NextRequest): NextResponse | null {
  const pathname = req.nextUrl.pathname
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname).toLowerCase()
  } catch {
    return new NextResponse(null, { status: 400 })
  }
  const isInternalPrefix =
    decoded === CMS_RENDER_PREFIX || decoded.startsWith(`${CMS_RENDER_PREFIX}/`)
  if (isInternalPrefix && req.headers.get(CMS_RENDER_MARKER) !== '1') {
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
  return `${CMS_RENDER_PREFIX}/${captured}`
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
  //
  // The `cavecms_just_installed=1` cookie is set by
  // /api/install/complete (Node runtime, can't reach this Edge
  // globalThis Map). When we see it, force a fresh security-config
  // fetch so the operator's first "Visit your site" click after the
  // wizard sees `installed: true` + the freshly-saved custom
  // LOGIN_PATH, instead of the pre-wizard cached snapshot.
  const justInstalled = req.cookies.get('cavecms_just_installed')?.value === '1'
  const cfg = await getSecurityConfig(req, justInstalled)

  // ─── First-boot install gate (WordPress-style) ────────────────
  //
  // Fresh deploy with no admin user → redirect EVERYTHING to /install
  // except the wizard itself, its endpoints, Next.js internals, and
  // /healthz (uptime monitors).
  //
  // We don't fail-open here: when the config read itself fails (cfg
  // === null) the most-likely cause IS a fresh deploy (no DB yet),
  // so the safe default is to assume not-installed and route to
  // /install rather than serving the half-broken default site.
  const installed = cfg?.installed === true
  // Static-asset bypass: requests whose path ends in a file extension
  // (`/icons/paintbrush.svg`, `/templates/foo.png`, `/window.svg`) must
  // be served from /public, NOT redirected to /install. Without this,
  // the wizard's own assets (paintbrush + sparkle SVGs in the Wordmark)
  // 307 to /install and the browser renders the broken-image glyph.
  const looksLikeStaticAsset = /\.[a-z0-9]{1,8}$/i.test(pathname)
  if (
    !installed &&
    !pathname.startsWith('/install') &&
    !pathname.startsWith('/api/install') &&
    !pathname.startsWith('/_next/') &&
    !pathname.startsWith('/uploads/') &&
    !looksLikeStaticAsset &&
    pathname !== '/healthz' &&
    pathname !== '/favicon.ico'
  ) {
    // `new URL('/install', req.url)` resolves against req.url's
    // host — which, behind a reverse proxy, is the loopback upstream
    // (HOSTNAME=127.0.0.1 in start-standalone.mjs, NOT the public
    // hostname). That leaked `https://127.0.0.1:PORT/install` into
    // the Location header. Build the redirect from the forwarded
    // Host header instead so the browser is sent back to the URL it
    // actually typed.
    const fwdHost = req.headers.get('host') ?? req.nextUrl.host
    const fwdProto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(/:$/, '')
    const installUrl = new URL(`${fwdProto}://${fwdHost}/install`)
    return NextResponse.redirect(installUrl, 307)
  }
  // If already installed, /install is permanently 404 — not a
  // redirect. A 307/308 to /admin would leak the admin path to any
  // crawler probing /install on a CaveCMS install. Hidden-admin
  // policy applies here too.
  if (installed && pathname.startsWith('/install')) {
    return notFoundResponse()
  }

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
  //    EXEMPTION: API-token bearer requests to token-allowed surfaces skip
  //    this gate. The allowlist exists to restrict the BROWSER admin to known
  //    IPs; programmatic clients (AI assistants, CI) legitimately call from
  //    arbitrary cloud IPs and have their own credential (a DB-verified,
  //    revocable, role-capped token checked downstream). Without this, every
  //    token request from outside the allowlist would 404. The token is still
  //    verified in the route handler, so a bogus bearer gains nothing beyond
  //    reaching a 401.
  if (
    cfg?.ipAllowlist?.enabled &&
    cfg.ipAllowlist.cidrs.length > 0 &&
    !cfg.disableIpAllowlist &&
    adminPath(pathname) &&
    !(isBearerApiToken(req.headers.get('authorization')) && tokenAllowedPath(pathname))
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
  //      - /healthz (deploy verification path — the in-app updater's
  //         step 6 polls this while maintenance is on, and a 503 here
  //         would make the orchestrator think the new build is unhealthy
  //         and trigger an unwarranted rollback. Healthz returns
  //         minimal {status} json regardless of maintenance state.)
  //    Operator's bypassIps lets them keep browsing the live site.
  if (
    cfg?.maintenance?.enabled &&
    !adminPath(pathname) &&
    !pathname.startsWith('/api/admin/') &&
    !pathname.startsWith('/api/internal/') &&
    !pathname.startsWith('/api/auth/') &&
    !pathname.startsWith('/_next/') &&
    pathname !== '/healthz' &&
    !cidrListMatch(ip, cfg.maintenance.bypassIps)
  ) {
    return maintenanceResponse(cfg.maintenance.message)
  }

  // 6. Block 1: refuse direct external hits to the internal
  //    /cms-render/* prefix (the guard allows our own rewrite re-entry
  //    via the marker header — see refuseInternalPageRoute).
  const internalDenied = refuseInternalPageRoute(req)
  if (internalDenied) return internalDenied

  // Resolve LOGIN_PATH — DB-backed value via cfg, else env bootstrap.
  // Lowercased once; used to skip the CMS-rewrite for the configured
  // admin login segment.
  const loginPathLower = (cfg?.loginPath ?? ENV_LOGIN_PATH_LOWER).toLowerCase()

  const nonce = generateNonce()
  const reqHeaders = new Headers(req.headers)
  reqHeaders.set('x-csp-nonce', nonce)
  reqHeaders.set('x-pathname', pathname)
  // Strip any client-supplied marker so an external request can't
  // pre-set it; only the rewrite below is allowed to add it.
  reqHeaders.delete(CMS_RENDER_MARKER)

  // 7. Block 2: single-segment rewrite to /_page/{slug}, unless the
  //    segment matches the resolved LOGIN_PATH (then let the dynamic
  //    /(auth)/[loginPath] route serve it).
  const rewriteTarget = maybeRewriteToPageRoute(pathname, loginPathLower)
  let res: NextResponse
  if (rewriteTarget) {
    const url = req.nextUrl.clone()
    url.pathname = rewriteTarget
    // ── Same-origin rewrite override (CRITICAL behind reverse proxy) ──
    // `req.nextUrl` carries the BOUND listener address (e.g.
    // `https://localhost:8201`) as host, not the public hostname the
    // request came in on (`test.derricksiawor.com`). When the rewrite
    // URL is stringified into the `x-middleware-rewrite` header,
    // resolve-routes.js in the router-server passes the value through
    // `getRelativeURL(value, initUrl)`. initUrl is built from the
    // request's actual Host header (when next.config's
    // `experimental.trustHostHeader=true` is set — already wired in
    // next.config.ts). If the rewrite URL's origin doesn't match
    // initUrl's origin, getRelativeURL returns an absolute URL,
    // `parsedUrl.protocol` ends up set, and Next's router-server
    // triggers an INTERNAL HTTP proxy against the rewrite target — but
    // X-Forwarded-Proto=https makes the target `https://`, while the
    // Node listener speaks plain HTTP. Result: every CMS-slug page
    // 500s with `EPROTO ssl3_get_record:wrong version number`.
    //
    // Fix: explicitly set hostname/port/protocol on the rewrite URL to
    // match the incoming request's Host + X-Forwarded-Proto BEFORE
    // calling NextResponse.rewrite. The resulting `x-middleware-rewrite`
    // header carries the same origin as initUrl, getRelativeURL strips
    // to a relative path, parsedUrl has no protocol, no proxy fires,
    // and the page renders normally.
    //
    // Verified on the live test install 2026-05-27 — without this
    // override, /dining /rooms /story /reservations all 500'd; with
    // it, all 200.
    const hostHeader = req.headers.get('host')
    if (hostHeader) {
      const [hostPart, portPart] = hostHeader.split(':')
      url.hostname = hostPart!
      url.port = portPart ?? ''
    }
    const forwardedProto = req.headers.get('x-forwarded-proto')
    if (forwardedProto === 'http' || forwardedProto === 'https') {
      url.protocol = `${forwardedProto}:`
    }
    // Mark the forwarded request so refuseInternalPageRoute allows the
    // re-entry. Next 15.5 standalone re-runs middleware on the rewritten
    // /cms-render/* path (which the matcher matches); without this
    // marker the guard would 404 our own rewrite — the empty-body 404
    // that broke every CMS page.
    reqHeaders.set(CMS_RENDER_MARKER, '1')
    res = NextResponse.rewrite(url, { request: { headers: reqHeaders } })
  } else {
    res = NextResponse.next({ request: { headers: reqHeaders } })
  }

  // Skip HSTS + upgrade-insecure-requests on loopback / LAN hosts even
  // in production — laptop / cpanel / private-network installs run with
  // NODE_ENV=production but serve over plain HTTP. Safari uniquely
  // honours both directives on such hosts (cf. ~/.claude/CLAUDE.md
  // #0.19): upgrade-insecure-requests rewrites every asset to https://
  // mid-flight, and HSTS pins the host to HTTPS for two years.
  // Either one renders the page unstyled and unusable. The host check
  // is per-request so a single binary can serve both public-domain
  // installs (HSTS on, upgrade on) and laptop installs (both off)
  // without operator configuration.
  const unroutable = isUnroutableForHsts(req.headers.get('host'))
  res.headers.set(
    'Content-Security-Policy',
    buildCsp(nonce, isProd, cfg?.integrations, unroutable),
  )
  if (isProd && !unroutable) {
    res.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    )
  }

  // Single-shot cache-bust cookie from /api/install/complete — once
  // we've consumed it for the force-fresh fetch above, expire it so
  // subsequent requests use the normal cached path.
  if (justInstalled) {
    res.headers.append(
      'set-cookie',
      'cavecms_just_installed=; Path=/; Max-Age=0; SameSite=Lax',
    )
  }

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
