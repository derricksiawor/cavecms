import 'server-only'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
// Use Web Crypto `crypto.randomUUID()` (Edge, browsers, Node 19+) instead
// of `node:crypto.randomUUID`. middleware.ts imports verifySessionJwt
// from this file; with the node:crypto import in place, the Edge bundle
// of middleware would fail at module load with "Native module not
// found: node:crypto". Web Crypto is universally available, so no
// runtime split needed.
import { env } from '@/lib/env'
// userCache is imported LAZILY (await import inside verifyPreviewJwt)
// because it transitively pulls @/db/client → mysql2 → iconv-lite →
// node:stream, none of which exist in the Edge runtime. middleware.ts
// imports verifySessionJwt from this file; if userCache were a static
// import, the entire DB stack would land in the Edge middleware bundle
// and crash at module load with "edge runtime does not support
// Node.js 'stream' module". verifySessionJwt itself doesn't need
// getUser — only verifyPreviewJwt does, and that's only called from
// the project preview-token path (Node runtime).
import {
  JWT_ISS_SESSION as ISS_SESSION,
  JWT_AUD_SESSION as AUD_SESSION,
  JWT_ISS_PREVIEW as ISS_PREVIEW,
  JWT_AUD_PREVIEW as AUD_PREVIEW,
} from './jwt-claims'

const JWT_KEY = new TextEncoder().encode(env.JWT_SECRET)
const PREVIEW_KEY = new TextEncoder().encode(env.PREVIEW_SECRET)
const FORBIDDEN_HEADERS = ['kid', 'jku', 'jwk', 'x5u', 'x5c'] as const

export interface SessionPayload extends JWTPayload {
  sub: string
  jti: string
  oat: number
  iat: number
  exp: number
  pwp: boolean
}

// signSessionJwt has moved to `./sign-session-jwt.ts` so the DB-stack
// transitive imports (`@/lib/cms/getSettings` → mysql2 → node:stream)
// stay out of the Edge-runtime middleware bundle that consumes
// `verifySessionJwt` below. Re-exporting here would defeat the split
// because the re-export turns into a static chain webpack follows. So
// Node-runtime callers (login route, JWT refresh) must import from
// `@/lib/auth/sign-session-jwt` directly. The compile-time test that
// guards against accidental Edge-side imports is the absence of a
// `signSessionJwt` symbol in this file.

export async function verifySessionJwt(token: string): Promise<SessionPayload> {
  const { payload, protectedHeader } = await jwtVerify(token, JWT_KEY, {
    algorithms: ['HS256'],
    issuer: ISS_SESSION,
    audience: AUD_SESSION,
    clockTolerance: '5s',
  })
  for (const bad of FORBIDDEN_HEADERS) {
    if ((protectedHeader as Record<string, unknown>)[bad]) {
      throw new Error('jwt header confusion')
    }
  }
  const p = payload as SessionPayload
  if (typeof p.oat !== 'number') throw new Error('missing oat')
  if (typeof p.pwp !== 'boolean') throw new Error('missing pwp')
  // Absolute-cap defence intentionally not re-checked here.
  //
  // At sign time, `exp = min(now + jwtTtlSec, oat + jwtAbsoluteMaxSec)`,
  // and `jose.jwtVerify()` automatically rejects any token whose
  // `exp` has passed. Re-deriving the cap from `settings.session_config`
  // here would force `verifySessionJwt` to import the DB layer, which
  // breaks Edge-runtime bundling for `middleware.ts`. The signing
  // gate is the canonical enforcement point; a tampered-stored JWT
  // can't outlive its `exp`, and an operator who shortens the cap
  // post-issue can't retroactively shorten already-issued tokens
  // anyway (only future signs are affected — same as every JWT
  // policy change in any auth system).
  return p
}

// --- preview JWT (separate secret + audience) ---
//
// The issuer's userId is encoded in `issued_by` (as a stringified
// number) so verifyPreviewJwt can re-check the user on resolution —
// a deactivated admin or a password rotation invalidates outstanding
// preview links the next time they're loaded, even if preview_epoch
// hasn't changed for unrelated reasons.
export async function signPreviewJwt(
  userId: string,
  resource: { type: 'project'; id: number; epoch: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    resource_type: resource.type,
    resource_id: resource.id,
    preview_epoch: resource.epoch,
    issued_by: userId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS_PREVIEW)
    .setAudience(AUD_PREVIEW)
    .setSubject(`project:${resource.id}`)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 900)
    .sign(PREVIEW_KEY)
}

// Pages-CMS preview JWT mint (spec §4.7). Distinct from the project
// preview mint above because the page verifier (PR-2 shipped
// `lib/cms/verifyPreviewToken.ts`) reads the `epoch` claim, not
// `preview_epoch` — the two resources diverged at PR-2 because the page
// verifier was authored fresh rather than reusing the project shape.
// Mirror the page verifier's expectations 1:1 so the sign/verify pair
// stays in lockstep.
//
// Claims:
//   - iss / aud — JWT_ISS_PREVIEW / JWT_AUD_PREVIEW (shared with projects)
//   - sub        = `page:{id}` — pinned to the page id at mint time.
//                  After a rename/restore/system-replacement the slug
//                  may point at a different id; sub-mismatch closes
//                  the replay window.
//   - epoch      = page.preview_epoch at mint time.
//   - issued_by  = userId as string (snake_case matches the project
//                  preview convention).
//   - iat/nbf    = now
//   - exp        = now + 15 min (mirrors projects, NOT 1h).
//
// The verifier (lib/cms/verifyPreviewToken.ts) is the only consumer.
// Rate-limiting + CSRF + role gating live in the route handler, not
// here.
export async function signPagePreviewJwt(
  userId: string,
  page: { id: number; epoch: number },
): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 900 // 15 minutes
  const token = await new SignJWT({
    epoch: page.epoch,
    issued_by: userId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS_PREVIEW)
    .setAudience(AUD_PREVIEW)
    .setSubject(`page:${page.id}`)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp)
    .sign(PREVIEW_KEY)
  return { token, exp }
}

export async function verifyPreviewJwt(
  token: string,
  expected: { type: 'project'; id: number; epoch: number },
): Promise<void> {
  const { payload, protectedHeader } = await jwtVerify(token, PREVIEW_KEY, {
    algorithms: ['HS256'],
    issuer: ISS_PREVIEW,
    audience: AUD_PREVIEW,
    subject: `project:${expected.id}`,
    clockTolerance: '5s',
  })
  for (const bad of FORBIDDEN_HEADERS) {
    if ((protectedHeader as Record<string, unknown>)[bad]) {
      throw new Error('jwt header confusion')
    }
  }
  if (payload['resource_type'] !== expected.type) throw new Error('resource type mismatch')
  if (payload['resource_id'] !== expected.id) throw new Error('resource id mismatch')
  if (payload['preview_epoch'] !== expected.epoch) throw new Error('preview epoch revoked')

  // Re-check the issuer's account state. The session JWT relies
  // on tokensValidAfterMs to revoke after a password change;
  // preview links should respect the same signal so a leaked
  // preview URL doesn't outlive an admin's offboarding.
  //
  // Skip this check ONLY for tokens minted before issued_by
  // existed — those are <= 15 min old (preview TTL) so the legacy
  // compatibility window self-closes quickly.
  const issuedBy = payload['issued_by']
  if (typeof issuedBy === 'string' && issuedBy.length > 0) {
    // Validate userId shape + iat shape BEFORE the DB read so a
    // malformed-but-MAC-valid token (impossible without the secret,
    // but defense in depth) doesn't burn a getUser round trip.
    const userId = Number(issuedBy)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('issued_by malformed')
    }
    const iat = payload['iat']
    if (typeof iat !== 'number') throw new Error('iat malformed')
    const { getUser } = await import('./userCache')
    const user = await getUser(userId)
    if (!user || !user.active) throw new Error('issuer inactive')
    // iat is seconds; tokensValidAfterMs is ms.
    if (iat * 1000 <= user.tokensValidAfterMs) {
      throw new Error('issuer tokens revoked')
    }
  }
}
