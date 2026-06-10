// Derive the install's PUBLIC healthz URL from the request, for the cPanel
// surface only. On cPanel/Passenger the app is on a private Unix socket, so an
// orchestrator (update OR restore) can't probe 127.0.0.1:$PORT — it must hit
// the public host, which the bash side then pins to 127.0.0.1 via curl
// --resolve (see compute_healthz_resolve in cavecms-update-helpers.sh).
//
// The host comes from the request's forwarded host — the operator just reached
// the dashboard through it, so it provably serves this app. That value is
// attacker-influenceable (a spoofed X-Forwarded-Host, or a proxy forwarding it
// verbatim), and the orchestrator carries a bearer token to this host, so we
// accept ONLY a strict hostname[:port] or bracketed IPv6 — no userinfo, which
// would let the bearer be smuggled off-box. The orchestrator re-gates this
// too (defence in depth); rejecting here means a bad value falls back to the
// loopback default rather than routing publicly at all.
//
// Returns undefined off cPanel or when the host doesn't pass the gate.
export function derivePublicHealthzUrl(req: Request): string | undefined {
  if (process.env.CAVECMS_RESTART_MODE !== 'cpanel') return undefined
  const fwdHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  const fwdProto = req.headers.get('x-forwarded-proto') ?? 'https'
  const firstProto = (fwdProto.split(',')[0] ?? 'https').trim()
  const firstHost = (fwdHost?.split(',')[0] ?? '').trim()
  const m = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d+))?$/.exec(firstHost)
  if (!m) return undefined
  // Reject an out-of-range port (a bad port can't exfil — the orchestrator
  // pins to 127.0.0.1 regardless — but don't emit a malformed target).
  if (m[1]) {
    const port = Number(m[1])
    if (port < 1 || port > 65535) return undefined
  }
  return `${firstProto === 'http' ? 'http' : 'https'}://${firstHost}/healthz`
}
