import { cookies } from 'next/headers'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { HttpError } from '@/lib/auth/requireRole'
import { hashPassword } from '@/lib/auth/scrypt'
import { hashResetToken } from '@/lib/auth/passwordReset'
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

// Consume an admin-issued password-reset link and set the new password.
//
// Auth model: this endpoint is UNAUTHENTICATED and login-equivalent — the
// single-use secret token IS the credential (a magic link). Like the login
// endpoint, it is CSRF-exempt (there is no session cookie to double-submit
// against). Defense rests on: the high-entropy single-use token, a short
// expiry, two rate-limit buckets, and generic error responses (no
// user-enumeration). On success it sets a new permanent password and issues a
// clean session so the user lands signed-in — mirroring the forced-rotation
// flow's session handoff.

const Body = z
  .object({
    token: z.string().min(10).max(200),
    password: z.string().min(12).max(200),
  })
  .strict()

// Rate-limit buckets. NOTE on what each actually protects:
//   - resetRateByToken keys on the submitted token's hash, so it only caps
//     REPLAY of one specific (e.g. stolen) link — a guessing attack uses a
//     different token each try, so this bucket never trips for guessing.
//   - resetRateByIp is the (IP-spoofable) throttle against guessing volume.
// The REAL defense against guessing is the token's 256 bits of entropy
// (lib/auth/passwordReset.ts) — a wrong guess never resolves to a user.
// The buckets are belt-and-braces. Same shape as the rotation endpoint.
const resetRateByToken = rateLimit('auth:reset:token', { limit: 5, windowSec: 60 })
const resetRateByIp = rateLimit('auth:reset:ip', { limit: 10, windowSec: 60 })

export const POST = withError(async (req: Request) => {
  const parsed = Body.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    // The only validation that can fail (client enforces the 12-char floor
    // too): a too-short / malformed password or token.
    throw new HttpError(400, 'invalid_input')
  }
  const { token, password } = parsed.data
  const tokenHash = hashResetToken(token)

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!resetRateByToken(tokenHash)) throw new HttpError(429, 'rate_limited')
  if (!resetRateByIp(ip)) throw new HttpError(429, 'rate_limited')

  const newHash = await hashPassword(password)
  const tva = new Date(Date.now() - 2000)

  // Atomically CLAIM the token (single-use under concurrency): the conditional
  // UPDATE only matches an unconsumed, unexpired row, and MySQL's row lock
  // serializes two racing tabs — exactly one gets affectedRows=1. Then set the
  // password for that token's user inside the same TX.
  const userInfo = await db.transaction(async (tx) => {
    const [claim] = (await tx.execute(sql`
      UPDATE password_reset_tokens
      SET consumed_at = now(3)
      WHERE token_hash = ${tokenHash}
        AND consumed_at IS NULL
        AND expires_at > now(3)
    `)) as unknown as [{ affectedRows: number }]
    if (!claim || claim.affectedRows !== 1) {
      throw new HttpError(400, 'invalid_or_expired')
    }

    const [tokenRows] = (await tx.execute(sql`
      SELECT user_id FROM password_reset_tokens WHERE token_hash = ${tokenHash} LIMIT 1
    `)) as unknown as [Array<{ user_id: number }>]
    const userId = tokenRows[0]?.user_id
    if (!userId) throw new HttpError(400, 'invalid_or_expired')

    const [userRows] = (await tx.execute(sql`
      SELECT id, active FROM users WHERE id = ${userId} LIMIT 1
    `)) as unknown as [Array<{ id: number; active: number }>]
    const user = userRows[0]
    // ON DELETE CASCADE means a token can't outlive its user, but guard anyway.
    if (!user) throw new HttpError(400, 'invalid_or_expired')

    const active = user.active === 1
    // On the active path we issue a session below (login-equivalent), so
    // stamp last_login_at to match the login/rotate contract — otherwise the
    // Users table's "Last signed in" column would read stale after a reset.
    // Inactive users get the password set but NO session, so no stamp.
    const lastLogin = active ? sql`, last_login_at = now(3)` : sql``
    await tx.execute(sql`
      UPDATE users
      SET password_hash = ${newHash},
          must_rotate_password = FALSE,
          password_changed_at = now(3),
          tokens_valid_after = ${tva}${lastLogin}
      WHERE id = ${userId}
    `)

    return { userId, active }
  })

  invalidateUser(userInfo.userId)

  // A deactivated account gets its password reset (the admin's intent) but no
  // session — they still can't sign in until re-enabled. Send them to "/".
  if (!userInfo.active) {
    return new Response(JSON.stringify({ ok: true, next: '/' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }

  // Issue a clean pwp=false session in the SAME response so the user lands
  // straight in /admin — mirrors the rotate route's handoff.
  const { token: jwt, jti, iat, exp } = await signSessionJwt(String(userInfo.userId), {
    pwp: false,
  })
  const csrfToken = await issueCsrf({ jti, sub: String(userInfo.userId) })
  const secure = isSecureRequest(req)
  const c = await cookies()
  c.set(SESSION_COOKIE, jwt, cookieFlags(exp - iat, secure))
  const csrfCookieTtl = (await getSetting('session_config')).csrfTtlSec
  c.set(CSRF_COOKIE, csrfToken, csrfCookieFlags(csrfCookieTtl, secure))
  c.set(JTI_COOKIE, jti, jtiCookieFlags(exp - iat, secure))

  return new Response(JSON.stringify({ ok: true, next: '/admin', csrf: csrfToken }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
