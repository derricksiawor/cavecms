import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

// Generic gated-file delivery tokens — the generalization of brochureToken.ts.
// Issued by a form's `deliver_file` after-submit action; verified by
// app/api/files/deliver/[token]/route.ts at download time. Carries the MEDIA id
// directly (vs the brochure token's project_id), so ANY file can be gated
// behind ANY form, not just a project's brochure.
//
// Shares BROCHURE_SECRET — the same concern (signed gated-file URLs) — which is
// safe because the payload SHAPE differs: this token's canonical JSON carries
// `media_id`, the brochure token's carries `project_id`. A brochure token can
// never cross-verify as a file token (its payload has no media_id → fails the
// field check before the MAC) or vice-versa.
//
// Reusable within the TTL (default 7 days): the lead is already captured at
// submit time and the file is marketing collateral, so a friendly re-download
// beats the brochure's single-use lock for a generic lead magnet. HMAC + exp +
// the route's per-IP rate-limit are the gate.
//
// Shape: base64url(payload).base64url(hmac_sha256(secret, payload))
// where payload is the canonical JSON {v, lead_id, media_id, exp}.

export interface FileDeliveryPayload {
  v: 1
  lead_id: number
  media_id: number
  exp: number
}

// Canonicalize fixes field order so the verifier reproduces the exact bytes the
// signer fed into HMAC. Adding a field requires bumping `v` AND extending this —
// verifying an old token under a new schema must fail closed.
export function canonicalizeFileDelivery(p: FileDeliveryPayload): string {
  return JSON.stringify({
    v: 1,
    lead_id: p.lead_id,
    media_id: p.media_id,
    exp: p.exp,
  })
}

export function signFileDeliveryToken(
  p: { lead_id: number; media_id: number },
  ttlSec = 60 * 60 * 24 * 7,
): string {
  const payload: FileDeliveryPayload = {
    v: 1,
    lead_id: p.lead_id,
    media_id: p.media_id,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  }
  const canon = canonicalizeFileDelivery(payload)
  const mac = createHmac('sha256', env.BROCHURE_SECRET).update(canon).digest()
  return Buffer.from(canon).toString('base64url') + '.' + mac.toString('base64url')
}

// See brochureToken.ts: payload (~120 b) + '.' + 32-byte mac (~44 b) ≈ 170 b.
// 4096 leaves headroom while preventing megabyte tokens that would allocate
// before the MAC can fail.
const MAX_TOKEN_LEN = 4096

export function verifyFileDeliveryToken(token: string): FileDeliveryPayload | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LEN) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadPart, macPart] = parts
  if (!payloadPart || !macPart) return null

  let payload: FileDeliveryPayload
  try {
    const decoded = Buffer.from(payloadPart, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Partial<FileDeliveryPayload>
    if (
      parsed.v !== 1 ||
      typeof parsed.lead_id !== 'number' ||
      !Number.isInteger(parsed.lead_id) ||
      parsed.lead_id <= 0 ||
      typeof parsed.media_id !== 'number' ||
      !Number.isInteger(parsed.media_id) ||
      parsed.media_id <= 0 ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp)
    ) {
      return null
    }
    payload = parsed as FileDeliveryPayload
  } catch {
    return null
  }

  // Recompute the MAC over the canonical form we just parsed — NOT the input
  // bytes — so any JSON tampering (whitespace, key order) fails the MAC.
  const expected = createHmac('sha256', env.BROCHURE_SECRET)
    .update(canonicalizeFileDelivery(payload))
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
