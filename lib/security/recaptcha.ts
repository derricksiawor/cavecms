import 'server-only'
import { env } from '@/lib/env'
import { getSetting } from '@/lib/cms/getSettings'

interface SiteVerifyResponse {
  success: boolean
  score?: number
  action?: string
  challenge_ts?: string
  hostname?: string
  'error-codes'?: string[]
}

export type RecaptchaVersion = 'v2' | 'v3'

export interface RecaptchaServerConfig {
  version: RecaptchaVersion
  siteKey: string
  secretKey: string
  // v3 only; ignored for v2 (which is binary pass/fail).
  minScore: number
}

export interface RecaptchaResult {
  ok: boolean
  reason:
    | 'configured_off'
    | 'verified'
    | 'low_score'
    | 'wrong_action'
    | 'verify_failed'
    | 'verify_timeout'
  score?: number
}

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify'
const VERIFY_TIMEOUT_MS = 4000

// Two entry points:
//
//   - getRecaptchaServerConfig(scope) — reads DB security_recaptcha,
//     returns the effective keys/version OR null if the surface is
//     disabled or unconfigured. Used by login + lead routes to decide
//     "do I even need to verify?".
//
//   - verifyRecaptchaWithConfig(token, config, ...) — pure verifier
//     against an explicit config. Used by the verify-before-enable
//     handshake (typed keys, not stored ones) and by the route-level
//     callers (config from getRecaptchaServerConfig).
//
// `verifyRecaptcha()` (the legacy single-arg form) is kept as a thin
// shim that resolves the public-scope config then verifies — so the
// login route's existing call site can stay one-line.

// Returns the effective server-side config for the named scope, or
// null when the surface is disabled / unconfigured (caller skips
// verification). Backward-compat: when the DB row is at its untouched
// default AND env keys are present, falls back to env (preserves the
// dev-without-DB-config experience that ships today).
export async function getRecaptchaServerConfig(
  scope: 'public' | 'login',
): Promise<RecaptchaServerConfig | null> {
  const cfg = await getSetting('security_recaptcha')

  // Scope gate FIRST — an explicit `enabledOnLogin=false` (the
  // operator's stated intent) must take precedence over the
  // env-fallback. Prior version applied the untouched-defaults
  // env-fallback BEFORE the scope check, which silently turned
  // login reCAPTCHA ON for first-deploy environments with env keys
  // present, bypassing the verify-before-enable handshake entirely.
  if (scope === 'login' && !cfg.enabledOnLogin) return null
  if (scope === 'public' && !cfg.enabled) {
    // Public-scope env fallback for the legacy "env keys + no DB
    // config" dev path. Only when both keys are set AND the DB row
    // is at its untouched defaults (so we can't be silently shadowing
    // an admin's explicit choice).
    const untouched =
      !cfg.enabled && !cfg.enabledOnLogin && !cfg.siteKey && !cfg.secretKey
    if (
      untouched &&
      env.RECAPTCHA_SECRET_KEY &&
      env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY
    ) {
      return {
        version: 'v3',
        siteKey: env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY,
        secretKey: env.RECAPTCHA_SECRET_KEY,
        minScore: env.RECAPTCHA_MIN_SCORE,
      }
    }
    return null
  }

  // The scope gate already returned null for the disabled cases.
  // Now require complete keys. For LOGIN scope this case is a
  // misconfiguration (Zod schema's refine should have caught it at
  // PATCH-time); fail CLOSED so the login route 503s rather than
  // silently disabling reCAPTCHA when the operator intended it on.
  if (!cfg.siteKey || !cfg.secretKey) {
    if (scope === 'login' && cfg.enabledOnLogin) {
      throw new Error(
        'security_recaptcha misconfigured: enabledOnLogin=true but siteKey/secretKey missing',
      )
    }
    return null
  }

  return {
    version: cfg.version,
    siteKey: cfg.siteKey,
    secretKey: cfg.secretKey,
    minScore: cfg.minScore,
  }
}

// Module-level concurrency cap. Under a botnet spread across 1000
// IPs the per-IP rate limit doesn't help — each request opens its own
// 4-second outbound fetch to google.com. With no cap, the undici
// connection pool exhausts and every verify (including legit ones)
// stalls or times out. 50 concurrent verifies is generous for any
// realistic lead-form load; excess waits in a small FIFO queue. If
// the queue itself grows past MAX_QUEUE we fail-open (return
// verify_failed) to keep latency bounded — the lead route's spam
// guard treats verify_failed as fail-open anyway.
const MAX_INFLIGHT = 50
const MAX_QUEUE = 200
let inFlightCount = 0
const queue: Array<() => void> = []
async function acquireSlot(): Promise<boolean> {
  if (inFlightCount < MAX_INFLIGHT) {
    inFlightCount += 1
    return true
  }
  if (queue.length >= MAX_QUEUE) return false
  return new Promise<boolean>((resolve) => {
    queue.push(() => {
      inFlightCount += 1
      resolve(true)
    })
  })
}
function releaseSlot(): void {
  inFlightCount -= 1
  const next = queue.shift()
  if (next) next()
}

// Pure verifier — no env reads, no default-config fallbacks. Caller
// supplies the config explicitly. For v3, set `expectedAction` so a
// token minted for a different action (e.g. replayed from a
// submission elsewhere on the site) is rejected. For v2, leave it
// undefined — v2 tokens have no action claim.
export async function verifyRecaptchaWithConfig(
  token: string,
  config: RecaptchaServerConfig & { expectedAction?: string },
  remoteIp?: string,
): Promise<RecaptchaResult> {
  if (!token) return { ok: false, reason: 'verify_failed' }
  // Fail-open if the queue itself is full — same effective state as
  // a Google outage; spam-guard fail-open path covers it.
  const acquired = await acquireSlot()
  if (!acquired) return { ok: false, reason: 'verify_failed' }

  const body = new URLSearchParams()
  body.set('secret', config.secretKey)
  body.set('response', token)
  if (remoteIp) body.set('remoteip', remoteIp)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS)
  let data: SiteVerifyResponse
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, reason: 'verify_failed' }
    data = (await res.json()) as SiteVerifyResponse
  } catch (err) {
    // Distinguish timeout from rejection so the UI can surface
    // "Couldn't reach Google" vs "Google rejected your keys" — same
    // operator action, very different diagnosis.
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: 'verify_timeout' }
    }
    return { ok: false, reason: 'verify_failed' }
  } finally {
    clearTimeout(timer)
    releaseSlot()
  }

  if (!data.success) return { ok: false, reason: 'verify_failed' }

  if (config.version === 'v2') {
    // v2 is binary: success=true is sufficient. No action, no score.
    return { ok: true, reason: 'verified' }
  }

  // v3 path: action + score gates.
  if (config.expectedAction && data.action !== config.expectedAction) {
    return { ok: false, reason: 'wrong_action', score: data.score }
  }
  const score = typeof data.score === 'number' ? data.score : 0
  if (score < config.minScore) {
    return { ok: false, reason: 'low_score', score }
  }
  return { ok: true, reason: 'verified', score }
}

// Legacy single-arg form. Resolves public-scope config then verifies.
// Returns { ok: true, reason: 'configured_off' } when the public
// surface is disabled or unconfigured — preserves the calling
// convention used by lead-route fail-open semantics.
let configuredOffWarned = false
export async function verifyRecaptcha(
  token: string,
  expectedAction: string,
  remoteIp?: string,
): Promise<RecaptchaResult> {
  const cfg = await getRecaptchaServerConfig('public')
  if (!cfg) {
    if (!configuredOffWarned && env.NODE_ENV !== 'test') {
      configuredOffWarned = true
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'recaptcha_configured_off',
        note: 'reCAPTCHA is not enabled / configured — public form verification is bypassed.',
      }))
    }
    return { ok: true, reason: 'configured_off' }
  }
  return verifyRecaptchaWithConfig(
    token,
    { ...cfg, expectedAction: cfg.version === 'v3' ? expectedAction : undefined },
    remoteIp,
  )
}
