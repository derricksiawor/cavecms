// Suspicious-request classifier. Three independent categories the
// operator can toggle from /admin/settings/security:
//
//   missingUserAgent — request has no User-Agent header (or a blank
//                      one). Browsers always send one; legitimate
//                      automation almost always sets one. Empty UAs
//                      are nearly 100% scrapers / probes.
//
//   botUaPatterns    — common attack-tool / mass-scanner User-Agents:
//                      sqlmap, nikto, masscan, nuclei, etc. NOT
//                      googlebot / bingbot / known-good crawlers.
//
//   probePaths       — paths that don't exist in this app but appear
//                      in attack scans: /wp-admin, /.env, /.git/,
//                      *.php (we ship NO php), phpmyadmin, etc.
//                      Saves log noise + makes the request return
//                      404 before hitting any handler.
//
// Patterns live in CODE not in settings — regex-DoS surface +
// operator-typo risk if a pattern matches /admin. Operator-facing
// surface is three booleans.
//
// All matchers are O(string length) — middleware-hot-path safe.

const BOT_UA_PATTERNS: readonly RegExp[] = [
  /sqlmap/i,
  /nikto/i,
  /nuclei/i,
  /\bmasscan\b/i,
  /\bzgrab\b/i,
  /acunetix/i,
  /netsparker/i,
  /\bnessus\b/i,
  /\bnmap\b/i,
  /wpscan/i,
  /dirbuster/i,
  /\bgobuster\b/i,
  /\bffuf\b/i,
  /python-requests/i, // unsigned default UA; legitimate clients set their own
  /Go-http-client/i,
  /curl\/7\.[0-9]+\.0$/i, // bare curl with default UA on a public surface
]

const PROBE_PATH_PATTERNS: readonly RegExp[] = [
  /\.php(\?|$|\/)/i,
  /\.aspx?(\?|$|\/)/i,
  /\.jsp(\?|$|\/)/i,
  /\.cgi(\?|$|\/)/i,
  /\.git(\/|$)/i,
  /\.env(\?|$|\/)/i,
  /\.ds_store(\?|$|\/)/i,
  /\.svn(\/|$)/i,
  /\.htaccess(\?|$|\/)/i,
  /\/wp-(admin|login|content|includes|json|config)/i,
  /\/phpmyadmin/i,
  /\/cgi-bin/i,
  /\/xmlrpc(\.php)?/i,
  /\/vendor\/phpunit/i,
  /\/webdav/i,
  /\/autodiscover\.xml/i,
  /\/owa\//i,
  /\/manager\/html/i, // Tomcat manager
]

interface BlockToggles {
  blockMissingUserAgent: boolean
  blockBotUaPatterns: boolean
  blockProbePaths: boolean
}

// Path exemptions from the missingUA + botUA gates. Monitoring tools
// (Pingdom, UptimeRobot, internal cron) commonly use raw
// python-requests / Go-http-client UAs against these endpoints —
// blocking them silently breaks observability. Probe-path patterns
// still apply (these endpoints don't match the probe patterns
// anyway).
const UA_GATE_EXEMPT_PATHS = new Set([
  '/healthz',
  '/sitemap.xml',
  '/robots.txt',
  '/favicon.ico',
])

// Returns a short label naming the rule that fired, or null when
// nothing matches. Label is for server-side logs only — middleware
// returns a bare 404 to the client so the bot doesn't learn what
// fired.
export function classifySuspicious(
  req: { headers: { get(name: string): string | null }; nextUrl?: { pathname: string }; url?: string },
  toggles: BlockToggles,
): string | null {
  // Path source: NextRequest exposes nextUrl.pathname; plain Request
  // requires URL parse. Either works for middleware (NextRequest) or
  // route handlers (Request).
  const pathname =
    req.nextUrl?.pathname ?? (() => {
      try {
        return new URL(req.url ?? '').pathname
      } catch {
        return ''
      }
    })()

  if (toggles.blockProbePaths && pathname) {
    for (const re of PROBE_PATH_PATTERNS) {
      if (re.test(pathname)) return 'probe_path'
    }
  }

  const uaGateExempt = UA_GATE_EXEMPT_PATHS.has(pathname)
  const ua = (req.headers.get('user-agent') ?? '').trim()
  if (!uaGateExempt && toggles.blockMissingUserAgent && ua.length === 0) {
    return 'missing_user_agent'
  }
  if (!uaGateExempt && toggles.blockBotUaPatterns && ua) {
    for (const re of BOT_UA_PATTERNS) {
      if (re.test(ua)) return 'bot_user_agent'
    }
  }

  return null
}
