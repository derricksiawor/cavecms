import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireAuth } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { invalidateUser } from '@/lib/auth/userCache'
import { SESSION_COOKIE, CSRF_COOKIE, JTI_COOKIE, cookieFlags, csrfCookieFlags, jtiCookieFlags, isSecureRequest } from '@/lib/auth/cookies'
import { clearReauthCookie } from '@/lib/auth/reauth'

const csrfInvalid = (): Response =>
  new Response(JSON.stringify({ error: 'csrf_invalid' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })

export const POST = withError(async (req: Request) => {
  const ctx = await requireAuth()
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  const csrfCookie = c.get(CSRF_COOKIE)?.value ?? ''

  // Timing-safe double-submit check, then session-bound HMAC verification.
  const a = Buffer.from(csrfHeader)
  const b = Buffer.from(csrfCookie)
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    return csrfInvalid()
  }
  if (!(await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    return csrfInvalid()
  }

  // Bump tokens_valid_after into the future so any unexpired JWT for this
  // user (this device or others) is treated as revoked. Computed in Node
  // to avoid DB clock skew. The 1-second offset is intentional — it makes
  // the cutoff strictly greater than any iat that could have been signed
  // before this UPDATE returned.
  const tva = new Date(Date.now() + 1000)
  await db.execute(sql`
    UPDATE users SET tokens_valid_after = ${tva} WHERE id = ${ctx.userId}
  `)
  invalidateUser(ctx.userId)

  // Clear cookies with the SAME attributes used at set-time — the deletion
  // Set-Cookie must carry the matching Path (and Secure on HTTPS) or the
  // browser ignores the deletion.
  const secure = isSecureRequest(req)
  c.set(SESSION_COOKIE, '', cookieFlags(0, secure))
  c.set(CSRF_COOKIE, '', csrfCookieFlags(0, secure))
  // Clear the pages-CMS jti companion cookie alongside the session. Without
  // this, a follow-up login on the same browser would briefly inherit the
  // prior session's jti (the cookie persists until natural expiry), and the
  // FE's HKDF derivation would key off a stale value before the next page
  // navigation refreshes the cookie. Belt + braces — see spec §3.5.
  c.set(JTI_COOKIE, '', jtiCookieFlags(0, secure))
  // Clear the step-up reauth cookie alongside session + csrf.
  // Without this, a follow-up login on the same browser inherits an
  // unexpired reauth window minted for the previous user — step-up
  // bypass. The reauth cookie is now bound to the issuing jti
  // (lib/auth/reauth.ts) so the bypass is defended in two layers,
  // but explicit clearing is the cheap-and-obvious belt + braces.
  await clearReauthCookie()

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
