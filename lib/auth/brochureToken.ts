import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

// Brochure download tokens. Issued by Plan 07's
// POST /api/leads/brochure handler after a successful lead capture;
// verified by app/api/brochure/[token]/route.ts at download time.
//
// Shape: base64url(payload).base64url(hmac_sha256(secret, payload))
// where payload is the canonical JSON: {v, lead_id, project_id, exp}.
// The atomic single-use guarantee lives at the DB layer
// (leads.brochure_token_used_at) — the token alone is reusable; the
// DOWNLOAD is single-use via the CAS UPDATE.
//
// Default TTL is 7 days — long enough for an email recipient on
// vacation, short enough that a forwarded link doesn't outlive sales
// interest. The CAS still defends against replay within the window.

export interface BrochurePayload {
  v: 1
  lead_id: number
  project_id: number
  exp: number
}

// Canonicalize fixes field order so the verifier reproduces the exact
// bytes the signer fed into HMAC. Adding a field to the payload
// requires bumping `v` AND extending this function — verifying an old
// token under a new schema must fail closed.
export function canonicalize(p: BrochurePayload): string {
  return JSON.stringify({
    v: 1,
    lead_id: p.lead_id,
    project_id: p.project_id,
    exp: p.exp,
  })
}

export function signBrochureToken(
  p: { lead_id: number; project_id: number },
  ttlSec = 60 * 60 * 24 * 7,
): string {
  const payload: BrochurePayload = {
    v: 1,
    lead_id: p.lead_id,
    project_id: p.project_id,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  }
  const canon = canonicalize(payload)
  const mac = createHmac('sha256', env.BROCHURE_SECRET).update(canon).digest()
  return (
    Buffer.from(canon).toString('base64url') +
    '.' +
    mac.toString('base64url')
  )
}

// Upper bound on legitimate token length: payload (~120 bytes
// base64-encoded) + '.' + 32-byte mac base64-encoded (~44 bytes).
// Total around 170 bytes. 4096 leaves generous headroom for any
// future payload growth while preventing megabyte tokens that
// would allocate memory before the MAC even gets a chance to fail.
const MAX_TOKEN_LEN = 4096

export function verifyBrochureToken(token: string): BrochurePayload | null {
  // Defense-in-depth length cap — keeps Buffer.from(...) from
  // allocating multi-MB buffers for adversarial inputs before the
  // MAC check.
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LEN) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadPart, macPart] = parts
  if (!payloadPart || !macPart) return null

  let payload: BrochurePayload
  try {
    const decoded = Buffer.from(payloadPart, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Partial<BrochurePayload>
    if (
      parsed.v !== 1 ||
      typeof parsed.lead_id !== 'number' ||
      !Number.isInteger(parsed.lead_id) ||
      parsed.lead_id <= 0 ||
      typeof parsed.project_id !== 'number' ||
      !Number.isInteger(parsed.project_id) ||
      parsed.project_id <= 0 ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp)
    ) {
      return null
    }
    payload = parsed as BrochurePayload
  } catch {
    return null
  }

  // Recompute the MAC over the canonical form we just parsed — NOT
  // over the input bytes. This forces any tampering with the JSON
  // (whitespace, key order, duplicate fields) to fail MAC even when
  // the parsed payload still looks valid.
  const expected = createHmac('sha256', env.BROCHURE_SECRET)
    .update(canonicalize(payload))
    .digest()
  let actual: Buffer
  try {
    actual = Buffer.from(macPart, 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length) return null
  if (!timingSafeEqual(actual, expected)) return null

  if (Math.floor(Date.now() / 1000) > payload.exp) return null
  return payload
}
