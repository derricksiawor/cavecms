import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { CSRF_COOKIE } from './cookies'
import { verifyCsrf } from './csrf'
import { HttpError } from './requireRole'
import { isApiTokenJti } from './apiTokenScope'

/**
 * Double-submit + HMAC CSRF check for mutating endpoints.
 *
 * Every CMS handler calls this right after `requireRole(...)`. Three layers:
 *  1. header and cookie present + same length (cheap reject)
 *  2. timing-safe equality of header vs cookie
 *  3. HMAC verification against the current session (jti + sub)
 *
 * Any failure throws HttpError(403, 'csrf_invalid') — withError surfaces a
 * generic 403 to the client (no detail leakage). Reuse of an expired or
 * forged token falls through to layer 3 and is rejected there.
 */
export async function requireCsrf(
  req: Request,
  ctx: { jti: string; userId: number },
): Promise<void> {
  // API-token (Bearer) requests carry no cookie and are not sent
  // automatically by a browser, so they are not a CSRF vector — the
  // token IS the credential. The synthetic `apitoken:<id>` jti marks
  // these requests; skip the double-submit check for them. (The token
  // was already verified by requireRole/_loadAuthState before this runs.)
  if (isApiTokenJti(ctx.jti)) return
  const header = req.headers.get('x-csrf-token') ?? ''
  const cookieJar = await cookies()
  const cookie = cookieJar.get(CSRF_COOKIE)?.value ?? ''
  if (!header || !cookie || header.length !== cookie.length) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const headerBuf = Buffer.from(header)
  const cookieBuf = Buffer.from(cookie)
  if (!timingSafeEqual(headerBuf, cookieBuf)) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const ok = await verifyCsrf(header, { jti: ctx.jti, sub: String(ctx.userId) })
  if (!ok) throw new HttpError(403, 'csrf_invalid')
}
