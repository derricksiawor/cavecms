import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

// Public-form CSRF strategy. Authenticated CMS routes use the
// double-submit __Host-bwc_csrf cookie + header; public lead forms
// have no session yet so we issue a server-bound nonce embedded in
// the rendered HTML form.
//
// Why HMAC-stateless instead of an in-memory store:
//   1. Next.js 15.5 forbids cookies().set() in Server Components, so
//      the originally-planned double-submit cookie cannot be issued
//      from page render. Without a cookie there is no client-side
//      anchor to verify against.
//   2. An in-memory issued-set keyed by random bytes does not
//      survive process restart and does not synchronize across
//      multiple PM2 instances. A user who opens /contact on
//      worker A and submits to worker B would silently lose their
//      submission — exactly the "drop leads silently with a generic
//      200" data-loss path called out in audit.
//   3. HMAC + exp gives us: server-origin binding, time-bounded
//      replay window, and crash-safe behavior. Single-use semantics
//      are not required for CSRF — the threat is forging a request
//      from a victim's browser, which is already blocked by
//      same-origin (CORS), CSP frame-ancestors 'none', and the
//      route-level rate-limit + honeypot + reCAPTCHA chain
//      (Plan 07).
//
// Token shape:  base64url(random16) . exp_unix . base64url(mac)
// where mac = HMAC-SHA256(CSRF_SECRET, `${random}|${exp}`)
//
// On consume we distinguish three states so the caller can
// differentiate genuine "session expired" UX from "forged/bot"
// silence:
//   ok      — MAC verified and exp not past; the nonce is valid.
//   expired — MAC verified but exp has passed; the user opened
//             the form > TTL ago. Caller may surface a refresh hint.
//   invalid — MAC mismatch or malformed; almost certainly bot/fuzz.
//             Caller should drop silently with a generic 200.
//
// CSRF_SECRET is reused (already required, >=32 bytes). Keeping
// nonce + session CSRF on the same secret means a single rotation
// invalidates both surfaces at once.

const TTL_SEC = 15 * 60
const MAX_NONCE_LEN = 512
// Per-segment caps: random is 16 bytes base64url-encoded (~22 chars),
// exp is a unix seconds integer (<=12 chars), mac is 32 bytes
// base64url-encoded (~43 chars). Capping each segment BEFORE the
// HMAC compute means an attacker can't burn CPU by sending 500-char
// `random` values to force a long macFor() string concat.
const MAX_RANDOM_LEN = 64
const MAX_EXP_LEN = 12
const MAX_MAC_LEN = 88

export type PreCsrfResult = 'ok' | 'expired' | 'invalid'

function macFor(random: string, exp: number): Buffer {
  return createHmac('sha256', env.CSRF_SECRET)
    .update(`${random}|${exp}`)
    .digest()
}

export async function ensurePublicPreCsrf(): Promise<string> {
  const random = randomBytes(16).toString('base64url')
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC
  const mac = macFor(random, exp).toString('base64url')
  return `${random}.${exp}.${mac}`
}

export async function consumePublicPreCsrf(
  formValue: string | null | undefined,
): Promise<PreCsrfResult> {
  if (!formValue || formValue.length > MAX_NONCE_LEN) return 'invalid'
  const parts = formValue.split('.')
  if (parts.length !== 3) return 'invalid'
  const [random, expStr, macReceived] = parts
  if (!random || !expStr || !macReceived) return 'invalid'
  // Per-segment caps before HMAC compute — bounds the work an
  // attacker can force per probe.
  if (
    random.length > MAX_RANDOM_LEN ||
    expStr.length > MAX_EXP_LEN ||
    macReceived.length > MAX_MAC_LEN
  ) {
    return 'invalid'
  }
  const exp = Number(expStr)
  if (!Number.isInteger(exp) || exp <= 0) return 'invalid'

  // Verify MAC FIRST so an attacker probing for "expired vs invalid"
  // gets a constant-time-style answer for forged inputs.
  let receivedBuf: Buffer
  try {
    receivedBuf = Buffer.from(macReceived, 'base64url')
  } catch {
    return 'invalid'
  }
  const expectedBuf = macFor(random, exp)
  if (receivedBuf.length !== expectedBuf.length) return 'invalid'
  if (!timingSafeEqual(receivedBuf, expectedBuf)) return 'invalid'

  // Only after the MAC has verified do we surface the exp signal —
  // otherwise attackers could distinguish "expired but real" from
  // "forged" tokens by submitting old payloads and reading the
  // response shape.
  if (Math.floor(Date.now() / 1000) > exp) return 'expired'
  return 'ok'
}
