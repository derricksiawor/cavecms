import 'server-only'
import { SignJWT, type JWTPayload } from 'jose'
import { env } from '@/lib/env'
import { getSetting } from '@/lib/cms/getSettings'
import {
  JWT_ISS_SESSION as ISS_SESSION,
  JWT_AUD_SESSION as AUD_SESSION,
} from './jwt-claims'

// Session-JWT signer (Node-only). Split out of `lib/auth/jwt.ts` so the
// Edge bundle that ships `verifySessionJwt` to middleware doesn't
// transitively pull the DB stack (`getSetting → @/db/client → mysql2 →
// node:stream`) which crashes at the Edge runtime with "edge runtime
// does not support 'stream' module".
//
// The login route (`app/api/auth/login/route.ts`) imports from THIS
// file directly; middleware only imports `verifySessionJwt` from the
// sibling `jwt.ts`. As long as no Edge-runtime path transitively
// reaches this module, the bundler keeps the DB stack out of the
// middleware chunk.
//
// Session timeouts come from `settings.session_config` (DB-driven via
// Settings → Security). Defaults are baked into the Zod schema so a
// freshly-installed instance with no row gets a sensible 8h session.

const JWT_KEY = new TextEncoder().encode(env.JWT_SECRET)

export interface SignedSessionJwt {
  token: string
  jti: string
  oat: number
  iat: number
  exp: number
}

export interface SessionPayload extends JWTPayload {
  sub: string
  jti: string
  oat: number
  iat: number
  exp: number
  pwp: boolean
}

export async function signSessionJwt(
  sub: string,
  opts: { pwp: boolean; jti?: string; oat?: number },
): Promise<SignedSessionJwt> {
  const now = Math.floor(Date.now() / 1000)
  const jti = opts.jti ?? crypto.randomUUID()
  const oat = opts.oat ?? now
  // Operator-configured session timeouts (per security gold-standard).
  // The static import is safe here because this file is never reached
  // from the Edge middleware bundle.
  const sessCfg = await getSetting('session_config')
  const exp = Math.min(now + sessCfg.jwtTtlSec, oat + sessCfg.jwtAbsoluteMaxSec)
  const token = await new SignJWT({ oat, pwp: opts.pwp })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS_SESSION)
    .setAudience(AUD_SESSION)
    .setSubject(sub)
    .setJti(jti)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp)
    .sign(JWT_KEY)
  // `exp` is returned so callers can size the companion
  // `__Host-cavecms_session_jti` cookie's Max-Age to the JWT's actual
  // remaining lifetime instead of a bare JWT_TTL — prevents the jti
  // cookie from outliving the session JWT in the final rotation
  // window before jwtAbsoluteMaxSec.
  return { token, jti, oat, iat: now, exp }
}
