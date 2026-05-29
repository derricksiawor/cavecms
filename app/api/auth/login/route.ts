import { cookies } from 'next/headers'
import { sql, eq, and } from 'drizzle-orm'
import { db } from '@/db/client'
import { users, userKnownIps } from '@/db/schema'
import { verifyPassword, getDummyScryptHash } from '@/lib/auth/scrypt'
import { signSessionJwt } from '@/lib/auth/sign-session-jwt'
import { issueCsrf } from '@/lib/auth/csrf'
import { computeLockState, recordFailure, recordSuccess } from '@/lib/auth/lockout'
import { invalidateUser } from '@/lib/auth/userCache'
import { consumePreCsrf } from '@/lib/auth/preCsrf'
import { rateLimitDynInfo } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import {
  getRecaptchaServerConfig,
  verifyRecaptchaWithConfig,
} from '@/lib/security/recaptcha'
import { getSetting } from '@/lib/cms/getSettings'
import { withError } from '@/lib/api/withError'
import { SESSION_COOKIE, CSRF_COOKIE, JTI_COOKIE, cookieFlags, csrfCookieFlags, jtiCookieFlags, isSecureRequest } from '@/lib/auth/cookies'
import { env } from '@/lib/env'

const MAX_PASSWORD_LEN = 256
const MAX_EMAIL_LEN = 180
const MAX_BODY_BYTES = 8 * 1024 // 8 KB cap on login form body
// Tightened from the permissive `[^\s@]+@[^\s@]+\.[^\s@]+` shape that
// accepted multi-`@` strings and HTML-sensitive bytes. The previous
// regex let an attacker insert payload like `admin@<script>x</script>@
// victim.com` into `login_attempts.email`, turning the audit-log view
// into a stored-XSS surface if any consumer ever rendered the value
// unescaped. The local part follows the dot-atom-text shape; the
// domain accepts standard host chars with at least one dot. Length
// bounded so the column can't be filled with multi-megabyte spam.
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,191}\.[A-Za-z]{2,}$/
const NEXT_FALLBACK_PATH = '/auth/rotate'

const generic = (status = 401): Response =>
  new Response(
    JSON.stringify({ error: 'Invalid email or password' }),
    {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    },
  )

// Distinct response for the THROTTLED / LOCKED-OUT cases only (per-IP +
// per-email rate-limit windows, and the progressive lockout tier). Unlike
// `generic`, this tells the operator they're temporarily blocked and how
// long to wait — but it is ENUMERATION-SAFE: rateLimitDyn buckets by the
// submitted email/IP string and computeLockState/recordFailure accumulate
// failures for ANY submitted email (a non-existent address locks identically),
// so this response NEVER confirms an account exists. It deliberately reveals
// nothing about WHICH axis (IP vs email) tripped — the body is uniform.
const lockedResponse = (retryAfter: number): Response =>
  new Response(
    JSON.stringify({
      error: 'Too many failed attempts. Please try again later.',
      retryAfter,
      locked: true,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
        'retry-after': String(retryAfter),
      },
    },
  )

/** Side-effect awaits (DB writes) wrapped so a post-timeout rejection can
 *  never escape as an unhandled rejection (which instrumentation.ts treats
 *  as fatal). Logged at error level with a stable label. */
function safeAwait<T>(p: Promise<T>, label: string): Promise<T | undefined> {
  return p.catch((err: unknown) => {
    console.error(JSON.stringify({
      level: 'error',
      label,
      err: err instanceof Error ? err.message : String(err),
    }))
    return undefined
  })
}

export const POST = withError(async (req: Request) => {
  // Cheap headers/IP work first, before parsing the body.
  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => { headerObj[k] = v })

  // Behind nginx in prod, x-real-ip carries the client IP. Next.js Route
  // Handlers don't expose the TCP socket, so we assume loopback and trust
  // x-real-ip per clientIpFromHeaders policy. nginx MUST be configured with
  // `proxy_set_header X-Real-IP $remote_addr` (overrides any client value).
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  const userAgent = String(headerObj['user-agent'] ?? '').slice(0, 255)

  // Pull live thresholds from DB (cached). On any read failure
  // (transient DB hiccup), fall back to the pre-DB hardcoded values
  // — fail-CLOSED-ish: a "couldn't read" should never RELAX rate
  // limits below the historic baseline. getSetting itself fails
  // closed to the registry default, which IS the historic baseline,
  // so the fallback is implicit.
  const thresholds = await getSetting('security_login_thresholds')

  // 1. Per-IP rate limit (only locks attacker's own IP — never another user).
  const ipLimit = rateLimitDynInfo('login:ip', ip, {
    limit: thresholds.perIpLimit,
    windowSec: thresholds.perIpWindowSec,
  })
  if (!ipLimit.allowed) {
    return lockedResponse(ipLimit.retryAfter ?? thresholds.perIpWindowSec)
  }

  // 2. Body size cap before parsing — prevents memory pressure from oversized
  //    multipart bodies. content-length is advisory but commonly correct.
  const lenHeader = req.headers.get('content-length')
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) return generic(413)

  const form = await req.formData()
  const rawEmail = String(form.get('email') ?? '').toLowerCase().trim().slice(0, MAX_EMAIL_LEN)
  const password = String(form.get('password') ?? '')
  const honeypot = String(form.get('hp_token') ?? '') // honeypot
  const csrfBody = String(form.get('csrf') ?? '')
  const recaptchaToken = String(form.get('g-recaptcha-response') ?? '')

  // 3. Honeypot — silent reject (attacker observes 401, no oracle beyond that).
  if (honeypot) return generic()

  // 4. Pre-CSRF consume happens BEFORE per-email rate-limit so an attacker
  //    cannot poison a victim's per-email bucket without first holding a
  //    valid pre-CSRF nonce (which requires having visited the login page,
  //    rate-limited per-IP at the page renderer).
  if (!consumePreCsrf(csrfBody)) return generic()

  // 5. reCAPTCHA verification BEFORE we touch the credentials path so
  //    a bot can't spend our scrypt budget. Three layered gates:
  //      (a) env.SECURITY_DISABLE_LOGIN_RECAPTCHA short-circuits to
  //          skip — break-glass for a botched key save that would
  //          otherwise lock out login.
  //      (b) getRecaptchaServerConfig('login') returns null when
  //          security_recaptcha.enabledOnLogin is false OR keys are
  //          unconfigured + no env fallback. Skip in that case
  //          (matches the pre-DB behaviour where no env keys =
  //          configured_off pass).
  //      (c) Otherwise verify with the resolved config. v3 enforces
  //          action='login' + minScore; v2 is binary success/fail.
  //    Fail-closed on any verify failure (bot brute-force is worse
  //    than a brief user lockout — see lib/leads/spam.ts for the
  //    contrasting public-form fail-open posture).
  if (!env.SECURITY_DISABLE_LOGIN_RECAPTCHA) {
    const rcCfg = await getRecaptchaServerConfig('login')
    if (rcCfg) {
      const recaptcha = await verifyRecaptchaWithConfig(
        recaptchaToken,
        {
          ...rcCfg,
          expectedAction: rcCfg.version === 'v3' ? 'login' : undefined,
        },
        ip,
      )
      if (!recaptcha.ok) return generic()
    }
  }

  // 6. Shape validation. An empty/garbage email never poisons the per-email
  //    bucket because it never reaches the limiter.
  const emailValid = !!rawEmail && EMAIL_RE.test(rawEmail)
  if (!emailValid) return generic()
  if (password.length === 0 || password.length > MAX_PASSWORD_LEN) return generic()
  const email = rawEmail

  // 7. Per-email rate limit — guard against brute-force against ONE account.
  //    Enumeration-safe: the bucket is keyed on the submitted email string
  //    with no account-existence check, so a bogus email throttles identically.
  const emailLimit = rateLimitDynInfo('login:email', email, {
    limit: thresholds.perEmailLimit,
    windowSec: thresholds.perEmailWindowSec,
  })
  if (!emailLimit.allowed) {
    return lockedResponse(emailLimit.retryAfter ?? thresholds.perEmailWindowSec)
  }

  // 8. Credential path — ALWAYS run scrypt regardless of user existence,
  //    using the dummy hash for non-existent users to flatten timing.
  const c = await cookies()
  const [user] = await db.select().from(users).where(eq(users.email, email))
  const hash = user?.passwordHash ?? (await getDummyScryptHash())
  const passwordOk = await verifyPassword(password, hash)

  // Fail-CLOSED on lockout-read failure. A DB hiccup that happens to
  // throw inside computeLockState was previously surfaced as 500 by
  // withError — but only AFTER scrypt verify ran. That gave an
  // attacker an unbounded password-guess window during sustained DB
  // pressure (rate limits still applied, but the per-email lockout
  // escalation didn't). Now: on read failure we synthesise a locked
  // state so the request fails the `!state.locked || isKnownIp` gate
  // unless the attacker also has a known-IP row (which they cannot
  // synthesise). Structured warn so the operator sees the trail.
  let state: Awaited<ReturnType<typeof computeLockState>>
  try {
    state = await computeLockState({ email, ip })
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'login_lockout_read_failed_fail_closed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    state = {
      locked: true,
      // The arrays are window-bucketed failure counts; the failing
      // path only inspects `locked`, but we synthesise a saturated
      // shape so downstream code that did read these would treat the
      // account as already at the highest-tier lockout escalation.
      eCounts: [Infinity, Infinity, Infinity],
      iCounts: [Infinity, Infinity, Infinity],
    }
  }

  // Run the userKnownIps lookup for any existing user (not only locked ones)
  // so its presence/absence doesn't reveal lock state to an attacker timing
  // the response.
  // Always issue the userKnownIps lookup (even when user doesn't exist) so
  // its presence/absence doesn't reveal user existence via response timing.
  // For non-existent users we query against id=-1 which trivially returns
  // 0 rows but pays the same network round-trip.
  const knownRows = await db
    .select()
    .from(userKnownIps)
    .where(and(eq(userKnownIps.userId, user?.id ?? -1), eq(userKnownIps.ip, ip)))
  const isKnownIp = !!user && knownRows.length > 0
  const allowed = !state.locked || isKnownIp

  if (!allowed || !user || !passwordOk || !user.active) {
    await safeAwait(
      recordFailure({ email, ip, userAgent, reason: 'bad_credentials', preCheckedState: state }),
      'login_recordFailure',
    )
    // Distinguish ONLY the progressive-lockout case (`!allowed` ⇒
    // state.locked && !isKnownIp) from a genuine wrong-password / wrong-user /
    // inactive verdict. The lockout branch tells the operator how long to wait;
    // every other branch keeps the existing generic 401 so it never leaks which
    // field was wrong. Enumeration-safe: `state.locked` is computed from
    // login_attempts + failed_logins_by_email bucketed by the submitted email
    // (a non-existent address locks identically), and the recordFailure write
    // above ran for ALL of these branches, so the locked response carries no
    // account-existence signal and the failure-accounting timing is unchanged.
    // state.retryAfter is set whenever state.locked is true; the fail-closed
    // synthesised state (lockout read error) has no retryAfter, so fall back to
    // the per-email lockout window as a conservative wait hint.
    if (!allowed) {
      return lockedResponse(state.retryAfter ?? thresholds.perEmailWindowSec)
    }
    return generic()
  }

  // Success path. Compute tokens_valid_after in Node so DB clock skew can't
  // either revoke the just-issued token or leave a window where prior
  // tokens stay valid. -2s buffer matches the JWT clockTolerance.
  // Run the users-table update and the recordSuccess side-effects in
  // parallel — they touch independent rows. Both are wrapped in safeAwait
  // (well, the user UPDATE is awaited directly because we need it before
  // signing the JWT — the recordSuccess writes are post-success bookkeeping).
  const tva = new Date(Date.now() - 2000)
  const loginAt = new Date()
  await Promise.all([
    db.execute(sql`
      UPDATE users SET tokens_valid_after = ${tva}, last_login_at = ${loginAt} WHERE id = ${user.id}
    `),
    safeAwait(
      recordSuccess({ email, ip, userId: user.id, userAgent }),
      'login_recordSuccess',
    ),
  ])
  invalidateUser(user.id)

  const { token, jti, iat, exp } = await signSessionJwt(String(user.id), { pwp: user.mustRotatePassword })
  const csrfToken = await issueCsrf({ jti, sub: String(user.id) })

  // Both cookies use the JWT's actual remaining lifetime (`exp - iat`)
  // rather than bare `JWT_TTL_SECONDS`. On a fresh login `oat === now`
  // so `exp - iat === JWT_TTL_SECONDS`; the divergence only matters in
  // a future refresh/rotate path where `oat` is in the past and
  // `JWT_ABSOLUTE_MAX_SECONDS` clamps `exp` below the bare TTL. Wiring
  // `exp - iat` here keeps the session cookie + the jti companion
  // cookie in lockstep with the token's true expiry, closing the
  // session-cookie-outlives-JWT footgun for any caller that reuses
  // `signSessionJwt` for a renewal (none exist today; defence in
  // depth). Spec §3.5 cookie-Max-Age-fix.
  // Secure flag tracks the request protocol so http://localhost installs
  // store the cookie (Safari refuses Secure cookies over HTTP).
  const secure = isSecureRequest(req)
  c.set(SESSION_COOKIE, token, cookieFlags(exp - iat, secure))
  // CSRF cookie Max-Age comes from DB-stored session_config.
  const { getSetting: getSettingForCookies } = await import('@/lib/cms/getSettings')
  const csrfCookieTtl = (await getSettingForCookies('session_config')).csrfTtlSec
  c.set(CSRF_COOKIE, csrfToken, csrfCookieFlags(csrfCookieTtl, secure))
  c.set(JTI_COOKIE, jti, jtiCookieFlags(exp - iat, secure))

  // Fire-and-forget update check for admins. Warms the 5-minute
  // in-memory release cache so the dashboard's next-page-load is
  // instantaneous. Skipped on local dev (sha === 'dev') and for
  // non-admin roles. Wrapped in a catch so a GitHub API hiccup can
  // NEVER fail the login.
  if (user.role === 'admin') {
    void (async () => {
      try {
        const { getCurrentVersion } = await import('@/lib/updates/getCurrentVersion')
        if (getCurrentVersion().sha === 'dev') return
        const { checkLatestRelease } = await import('@/lib/updates/checkLatestRelease')
        const owner = process.env.CAVECMS_REPO_OWNER ?? 'derricksiawor'
        const repo = process.env.CAVECMS_REPO_NAME ?? 'cavecms'
        await checkLatestRelease({ owner, repo })
      } catch {
        /* fail-silent — operator's login succeeded regardless */
      }
    })()
  }

  // Use a non-secret stable path for rotation; LOGIN_PATH never appears in
  // any post-auth response body or browser history.
  const next = user.mustRotatePassword ? NEXT_FALLBACK_PATH : '/admin'
  return new Response(
    JSON.stringify({ ok: true, next, csrf: csrfToken }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    },
  )
})
