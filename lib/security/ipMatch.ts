// Edge-compatible CIDR matcher for IPv4 + IPv6. No Node built-ins, no
// external deps — runs identically in middleware (Edge runtime) and in
// route handlers (Node runtime).
//
// Used by:
//   - PATCH /api/admin/settings — guard that refuses an IP-allowlist
//     save excluding the operator's current IP, or a maintenance-mode
//     save excluding it from bypassIps.
//   - middleware-fed /api/internal/security-config — eventually
//     enforced in middleware for allowlist / blocklist / maintenance
//     bypass decisions.

interface IpBytes {
  family: 4 | 6
  bytes: Uint8Array
}

function ipv4ToBytes(addr: string): Uint8Array | null {
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const p = parts[i]
    if (!p || !/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n < 0 || n > 255) return null
    out[i] = n
  }
  return out
}

function ipv6ToBytes(addr: string): Uint8Array | null {
  // Lower the case (hex digits are case-insensitive) but reject any
  // chars outside [0-9a-f:].
  const lower = addr.toLowerCase()
  if (!/^[0-9a-f:]+$/.test(lower)) return null

  // Strip a single "::" expansion. Two "::" in one address is malformed.
  const halves = lower.split('::')
  if (halves.length > 2) return null

  let groups: string[]
  if (halves.length === 2) {
    const leftRaw = halves[0]
    const rightRaw = halves[1]
    const left = leftRaw ? leftRaw.split(':') : []
    const right = rightRaw ? rightRaw.split(':') : []
    const missing = 8 - left.length - right.length
    if (missing < 0) return null
    groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  } else {
    groups = lower.split(':')
  }
  if (groups.length !== 8) return null

  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i]
    if (!g || g.length > 4 || !/^[0-9a-f]+$/.test(g)) return null
    const n = parseInt(g, 16)
    out[i * 2] = (n >> 8) & 0xff
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

function ipToBytes(addr: string): IpBytes | null {
  if (addr.includes(':')) {
    const b = ipv6ToBytes(addr)
    return b ? { family: 6, bytes: b } : null
  }
  const b = ipv4ToBytes(addr)
  return b ? { family: 4, bytes: b } : null
}

interface ParsedCidr {
  family: 4 | 6
  bytes: Uint8Array
  prefix: number
}

// Parse a CIDR (e.g. "203.0.113.42/24", "2001:db8::/32") or a bare IP
// (treated as /32 v4 or /128 v6). Returns null on any malformed input;
// the caller surfaces this as a per-row validation error in the
// settings form.
export function parseCidr(cidr: string): ParsedCidr | null {
  const slash = cidr.indexOf('/')
  const base = slash === -1 ? cidr : cidr.slice(0, slash)
  const prefixStr = slash === -1 ? undefined : cidr.slice(slash + 1)
  const ip = ipToBytes(base)
  if (!ip) return null
  const totalBits = ip.family === 4 ? 32 : 128
  let prefix: number
  if (prefixStr === undefined) {
    prefix = totalBits
  } else {
    if (!/^\d{1,3}$/.test(prefixStr)) return null
    prefix = Number(prefixStr)
    if (prefix < 0 || prefix > totalBits) return null
  }
  return { family: ip.family, bytes: ip.bytes, prefix }
}

// Does `ip` (string) lie within `cidr` (string)? Returns false on any
// parse failure for either side — by-design fail-closed for the
// matching path (the parse step at PATCH-time is the trust boundary
// that surfaces typos to the operator).
export function cidrMatch(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr)
  if (!parsed) return false
  const target = ipToBytes(ip)
  if (!target) return false
  if (target.family !== parsed.family) return false

  const fullBytes = parsed.prefix >> 3 // whole bytes that must match exactly
  const trailingBits = parsed.prefix & 7 // remaining bits in the next byte
  for (let i = 0; i < fullBytes; i++) {
    if (target.bytes[i] !== parsed.bytes[i]) return false
  }
  if (trailingBits > 0) {
    const mask = (0xff << (8 - trailingBits)) & 0xff
    const a = (target.bytes[fullBytes] ?? 0) & mask
    const b = (parsed.bytes[fullBytes] ?? 0) & mask
    if (a !== b) return false
  }
  return true
}

// Any CIDR in `cidrs` matches `ip`?
export function cidrListMatch(ip: string, cidrs: readonly string[]): boolean {
  for (const c of cidrs) {
    if (cidrMatch(ip, c)) return true
  }
  return false
}

// Edge-runtime client IP resolver. Mirrors the trust policy in
// lib/http/clientIp.ts: nginx sets x-real-ip from the verified TCP
// socket address; XFF is ignored (client-spoofable when not behind
// the configured edge). Returns '0.0.0.0' when no trusted IP is
// determinable so callers always have a string to bucket against.
//
// Middleware-callable: takes a Request (or NextRequest) and reads
// headers via the standard Headers API. No Node built-ins.
export function clientIpFromRequest(req: Request): string {
  const candidate = req.headers.get('x-real-ip')?.trim()
  if (candidate && (ipv4ToBytes(candidate) || ipv6ToBytes(candidate.toLowerCase()))) {
    return candidate
  }
  return '0.0.0.0'
}
