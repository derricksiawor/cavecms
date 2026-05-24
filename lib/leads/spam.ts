import 'server-only'
import { verifyRecaptcha } from '@/lib/security/recaptcha'

// Re-export the honeypot constants + helper from the dedicated
// module. Keeps the public spam-check surface ergonomic (single
// import in routes) while letting the constant live in a tiny file
// alongside the form components that depend on it without pulling
// in `server-only`-tagged side effects.
export { HONEYPOT_FIELD, honeypotTripped } from './honeypot'

// Result shape for lead-form spam checks. `pass` decides whether
// to write the lead row; `degraded` flags that the verification
// fell back to fail-open (used by callers to attach a log marker
// so a spike in degraded passes is visible in monitoring).
export interface SpamCheckResult {
  pass: boolean
  degraded: boolean
  reason: string
  score?: number
}

// Lead-form reCAPTCHA wrapper with FAIL-OPEN semantics.
//
// Auth routes (login) fail CLOSED on verify_failed — letting a bot
// brute-force passwords is worse than locking a legit user out for
// a minute. Lead routes fail OPEN because dropping a real enquiry
// during a reCAPTCHA outage is real lost business, and the
// honeypot + per-IP rate-limit + per-route preCSRF nonce already
// stand in front of the lead pipeline.
//
// Decision matrix:
//   configured_off  → pass (no key in dev)   degraded=true
//   verified        → pass                   degraded=false
//   low_score       → fail (bot signal)      reason='low_score'
//   wrong_action    → fail (template misuse) reason='wrong_action'
//   verify_failed   → pass  (FAIL-OPEN)      degraded=true
//   missing token   → pass  (FAIL-OPEN)      degraded=true,
//                            reason='missing_token'
//
// `missing_token` fails OPEN because in production the cause is
// almost always "site forgot to wire the client-side reCAPTCHA
// execute()" — a deploy bug, not a bot signal. Dropping every
// lead silently while operators discover the wiring gap would be
// catastrophic. Callers log `degraded=true` so a missing_token
// spike is visible in metrics.
export async function checkLeadRecaptcha(
  token: string | null | undefined,
  action: string,
  ip: string | null,
): Promise<SpamCheckResult> {
  if (!token) {
    return { pass: true, degraded: true, reason: 'missing_token' }
  }
  const r = await verifyRecaptcha(token, action, ip ?? undefined)
  if (r.ok) {
    return {
      pass: true,
      degraded: r.reason === 'configured_off',
      reason: r.reason,
      score: r.score,
    }
  }
  if (r.reason === 'verify_failed') {
    return { pass: true, degraded: true, reason: r.reason, score: r.score }
  }
  return { pass: false, degraded: false, reason: r.reason, score: r.score }
}
