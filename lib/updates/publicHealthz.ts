import 'server-only'

// Derive the install's PUBLIC healthz URL from the operator's CONFIGURED site
// URL (settings.site_general.siteUrl, via getSiteOrigin), for the cPanel
// surface only.
//
// Why the public URL at all: on cPanel/Passenger the app runs on a private Unix
// socket, so an orchestrator (update OR restore) can't probe 127.0.0.1:$PORT.
// Pinning curl `--resolve` to 127.0.0.1 doesn't work either — LiteSpeed returns
// its default cPanel 404 for a loopback connection carrying the site's SNI
// (confirmed on a live box). So the probe must hit the real public host, which
// LiteSpeed routes correctly by Host.
//
// Why the CONFIGURED url, NOT the request: the orchestrator attaches a bearer
// token (HEALTHZ_TOKEN) to this URL. An earlier version derived the host from
// the request's X-Forwarded-Host — which is attacker-influenceable (a spoofed
// header, or a proxy forwarding it verbatim). With the loopback `--resolve` pin
// in place that was inert; once the pin was dropped (so cPanel routing works),
// a spoofed host would have routed the bearer off-box. Deriving from the
// operator's own configured site URL removes that vector entirely: the bearer
// can only ever reach the one host the operator set in Settings → General. We
// still re-validate (reject userinfo / malformed) as defence in depth.
//
// Returns undefined off cPanel, or when no site URL is configured / it doesn't
// pass the gate — the caller then falls back to the loopback default.
export function derivePublicHealthzUrl(
  configuredSiteUrl: string | null | undefined,
): string | undefined {
  if (process.env.CAVECMS_RESTART_MODE !== 'cpanel') return undefined
  if (!configuredSiteUrl) return undefined

  let u: URL
  try {
    u = new URL(configuredSiteUrl)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  // Userinfo would smuggle the bearer off the operator's own host. (getSiteOrigin
  // is already trusted, so this is belt-and-suspenders — but cheap and absolute.)
  if (u.username || u.password) return undefined
  if (!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])$/.test(u.hostname)) return undefined
  if (u.port) {
    const port = Number(u.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  }
  return `${u.origin}/healthz`
}
