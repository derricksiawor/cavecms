import { cookies } from 'next/headers'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireAuth, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { hashPassword, verifyPassword, getDummyScryptHash } from '@/lib/auth/scrypt'
import { signSessionJwt } from '@/lib/auth/sign-session-jwt'
import { issueCsrf } from '@/lib/auth/csrf'
import { invalidateUser } from '@/lib/auth/userCache'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  JTI_COOKIE,
  cookieFlags,
  csrfCookieFlags,
  jtiCookieFlags,
  isSecureRequest,
} from '@/lib/auth/cookies'
import { getSetting } from '@/lib/cms/getSettings'

// Forced-password-rotation endpoint. A user created by an admin lands with
// must_rotate_password=TRUE; login mints a session JWT carrying pwp=true,
// which getSession treats as "not yet fully authenticated" (the admin layout
// redirects these users to /auth/rotate). This handler is the ONLY surface a
// pwp user can act on: it sets a new password, clears the flag, and re-issues
// a clean pwp=false session in the same response.
//
// Auth model: requireAuth() (NOT requireRole) because the pwp session is the
// credential — the user already proved knowledge of the temp password at
// login. We deliberately do NOT re-ask for the current password here (product
// decision: new + confirm only). Defence still holds because:
//   - the request must carry a VALID pwp session cookie (requireAuth),
//   - CSRF double-submit is enforced (browser can't be tricked cross-site),
//   - two rate-limit buckets cap brute-force / abuse,
//   - API-token (Bearer) requests are refused outright — a programmatic
//     token must never rotate a human's password.

// New-password floor: 12 chars, matching the project standard for new admin
// accounts (Create schema in app/api/admin/users/route.ts). Upper bound 200
// mirrors login/reauth — large enough to never feel cramped, small enough that
// scrypt can't be driven to OOM by a multi-megabyte body.
const Body = z
  .object({ password: z.string().min(12).max(200) })
  .strict()

// Two buckets, same shape as /api/auth/reauth. Per-user caps a stolen pwp
// session hammering the endpoint; per-IP caps a single host rotating cookies.
const rotateRateByUser = rateLimit('auth:rotate:user', { limit: 5, windowSec: 60 })
const rotateRateByIp = rateLimit('auth:rotate:ip', { limit: 10, windowSec: 60 })

export const POST = withError(async (req: Request) => {
  const ctx = await requireAuth()

  // A Bearer API token must never be able to rotate a password — the token is
  // a non-interactive credential and carries no rotation obligation.
  if (ctx.viaApiToken) throw new HttpError(403, 'forbidden')

  // Only a user who actually OWES a rotation may use this endpoint. A
  // fully-authenticated user (pwp=false) hitting it is a no-op/abuse vector —
  // they change their password under Settings, not here. The page-level guard
  // already redirects them to /admin; this is the structural backstop.
  if (!ctx.pwp) throw new HttpError(409, 'rotation_not_required')

  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!rotateRateByUser(String(ctx.userId))) throw new HttpError(429, 'rate_limited')
  if (!rotateRateByIp(ip)) throw new HttpError(429, 'rate_limited')

  const parsed = Body.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    // Generic, copy-friendly message — the only validation that can fail here
    // is the 12-char floor (client enforces it too, so this is the
    // belt-and-braces server reject).
    throw new HttpError(400, 'password_too_short')
  }
  const newPassword = parsed.data.password

  // Load the current hash so we can refuse a "rotation" to the SAME password —
  // re-setting the temp password would defeat the entire forced-rotation
  // purpose. Constant-time dummy-hash path if the row vanished mid-session,
  // matching login/reauth so timing never reveals "deleted user".
  const [rows] = (await db.execute(
    sql`SELECT password_hash FROM users WHERE id = ${ctx.userId} LIMIT 1`,
  )) as unknown as [Array<{ password_hash: string }>]
  const currentHash = rows[0]?.password_hash ?? (await getDummyScryptHash())
  const sameAsCurrent = await verifyPassword(newPassword, currentHash)
  if (!rows[0]) throw new HttpError(401, 'unauthenticated')
  if (sameAsCurrent) throw new HttpError(400, 'same_password')

  const newHash = await hashPassword(newPassword)

  // Invalidate every token issued at-or-before now (the old pwp token) and set
  // the new password + clear the flag in one statement. -2s buffer matches the
  // JWT clockTolerance + the login flow so the FRESH token we sign just below
  // (iat = now) is NOT caught by the tokens_valid_after revocation check.
  const tva = new Date(Date.now() - 2000)
  await db.execute(sql`
    UPDATE users
    SET password_hash = ${newHash},
        must_rotate_password = ${false},
        tokens_valid_after = ${tva}
    WHERE id = ${ctx.userId}
  `)
  invalidateUser(ctx.userId)

  // Re-issue a clean session in the SAME response so the user is dropped
  // straight into /admin without a second login. pwp=false this time.
  const { token, jti, iat, exp } = await signSessionJwt(String(ctx.userId), { pwp: false })
  const csrfToken = await issueCsrf({ jti, sub: String(ctx.userId) })
  const secure = isSecureRequest(req)
  const c = await cookies()
  c.set(SESSION_COOKIE, token, cookieFlags(exp - iat, secure))
  const csrfCookieTtl = (await getSetting('session_config')).csrfTtlSec
  c.set(CSRF_COOKIE, csrfToken, csrfCookieFlags(csrfCookieTtl, secure))
  c.set(JTI_COOKIE, jti, jtiCookieFlags(exp - iat, secure))

  return new Response(JSON.stringify({ ok: true, next: '/admin', csrf: csrfToken }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
