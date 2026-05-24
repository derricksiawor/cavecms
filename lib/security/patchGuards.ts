import 'server-only'
import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { env } from '@/lib/env'
import { cidrListMatch, parseCidr } from '@/lib/security/ipMatch'

// Dedicated error class so the route handler can catch + render the
// guard's structured payload (`{error, message?, saverIp?}`) as a 422
// JSON body. The generic HttpError pipeline in withError only carries
// a string code — this class carries a richer object so the client
// can render a precise lockout message.
export class SecurityGuardFailure extends Error {
  constructor(public readonly payload: { error: string; message?: string; saverIp?: string }) {
    super(payload.error)
    this.name = 'SecurityGuardFailure'
  }
}

// Per-security-key save-time guards. Run inside the same transaction
// as the settings UPDATE so a guard failure rolls back any partial
// write (e.g. the security_login_path_pending row write paired with
// the path change).
//
// Each guard either:
//   - throws HttpError(422, '<CODE>') with a JSON body the client maps
//     to a precise message; OR
//   - completes silently (guard passed); AND optionally
//   - performs side-writes within the same tx (login-path's pending
//     row insert, for example).

type Tx = {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>
}

function guardFail(code: string, extra: { message?: string; saverIp?: string } = {}): never {
  throw new SecurityGuardFailure({ error: code, ...extra })
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

// ─── security_ip_lists ───
// If the allowlist is enabled AND non-empty, the saver's IP MUST
// match one of the new CIDRs. Also fails on any malformed CIDR
// (defence-in-depth alongside the Zod regex).
export function guardIpLists(
  value: {
    allowlist: { enabled: boolean; cidrs: string[] }
    blocklist: { enabled: boolean; cidrs: string[] }
  },
  saverIp: string,
): void {
  for (const c of value.allowlist.cidrs) {
    if (!parseCidr(c)) guardFail('invalid_cidr', { message: `Malformed CIDR in allowlist: ${c}` })
  }
  for (const c of value.blocklist.cidrs) {
    if (!parseCidr(c)) guardFail('invalid_cidr', { message: `Malformed CIDR in blocklist: ${c}` })
  }
  // Refuse enabling either list when the saver's IP wasn't trustable
  // (no x-real-ip header from nginx, e.g. dev / mis-proxied prod). A
  // saver IP of 0.0.0.0 would never match any non-trivial CIDR, so
  // the allowlist check below would always 422 with a misleading
  // "your IP isn't in the list" — surfacing the real cause makes the
  // operator fix nginx instead of debugging the form.
  if (
    saverIp === '0.0.0.0' &&
    (value.allowlist.enabled || value.blocklist.enabled)
  ) {
    guardFail('SAVER_IP_UNRESOLVABLE', {
      message:
        "Your IP couldn't be detected. Configure your reverse proxy to forward X-Real-IP before enabling these lists.",
    })
  }
  // Reject if saver IP is in blocklist — they'd 403 themselves on the
  // NEXT request and never reach the settings page again.
  if (value.blocklist.enabled && cidrListMatch(saverIp, value.blocklist.cidrs)) {
    guardFail('SAVER_IP_IN_BLOCKLIST', {
      saverIp,
      message: `Your current IP (${saverIp}) is in the blocklist. Remove it or you'll get 403 on every request.`,
    })
  }
  if (value.allowlist.enabled && value.allowlist.cidrs.length > 0) {
    if (!cidrListMatch(saverIp, value.allowlist.cidrs)) {
      guardFail('SAVER_IP_NOT_IN_ALLOWLIST', { saverIp })
    }
  }
}

// ─── security_maintenance ───
// If enabled, the saver IP must be in bypassIps (UI auto-adds when
// the operator clicks the "Add my IP" affordance; this guard is the
// belt-and-braces).
export function guardMaintenance(
  value: { enabled: boolean; bypassIps: string[] },
  saverIp: string,
): void {
  for (const c of value.bypassIps) {
    if (!parseCidr(c)) guardFail('invalid_cidr', { message: `Malformed CIDR in bypass list: ${c}` })
  }
  if (value.enabled && saverIp === '0.0.0.0') {
    guardFail('SAVER_IP_UNRESOLVABLE', {
      message:
        "Your IP couldn't be detected; fix X-Real-IP forwarding before enabling maintenance.",
    })
  }
  if (value.enabled && !cidrListMatch(saverIp, value.bypassIps)) {
    guardFail('SAVER_IP_NOT_IN_BYPASS', { saverIp })
  }
}

// ─── security_recaptcha ───
// If the operator is FLIPPING enabledOnLogin from false → true, OR
// changing keys/version while enabledOnLogin remains true, a fresh
// matching verification row (≤5 min, exact siteKeyHash+secretKeyHash
// +version match, scoped to this userId) MUST exist. Otherwise we
// reject with 422 RECAPTCHA_LOGIN_VERIFICATION_REQUIRED.
//
// `prevValue` is the to-be-overwritten row (or the registry default
// when no row exists yet) so we can detect the field-changed cases
// without an extra DB round-trip.
type RecaptchaPrevValue = {
  enabled: boolean
  enabledOnLogin: boolean
  version: 'v2' | 'v3'
  siteKey?: string
  secretKey?: string
} | null | undefined

// Defensive default for a corrupt / null prev value. Treat unknown
// prior state as "everything off" so any becoming-enabled transition
// is detected and forces a fresh verification (safer side).
const RECAPTCHA_PREV_FALLBACK = {
  enabled: false,
  enabledOnLogin: false,
  version: 'v3' as const,
  siteKey: undefined,
  secretKey: undefined,
}

export async function guardRecaptcha(
  tx: Tx,
  userId: number,
  jti: string,
  prevValueRaw: RecaptchaPrevValue,
  newValue: {
    enabled: boolean
    enabledOnLogin: boolean
    version: 'v2' | 'v3'
    siteKey?: string
    secretKey?: string
  },
): Promise<void> {
  const prevValue = prevValueRaw ?? RECAPTCHA_PREV_FALLBACK

  // Disabling both surfaces never requires verify (turning OFF is safe).
  if (!newValue.enabled && !newValue.enabledOnLogin) return

  const keysChanged =
    prevValue.siteKey !== newValue.siteKey ||
    prevValue.secretKey !== newValue.secretKey ||
    prevValue.version !== newValue.version

  // Two trigger paths for "require verify":
  //   (a) becoming-enabled on EITHER surface (was off → now on)
  //   (b) keys/version changed while either surface is enabled
  // (b) closes the silent-breakage case where an operator rotates
  // the Google secret and saves without testing — public lead
  // intake / login would silently fail every verification thereafter.
  const becomingEnabledLogin = !prevValue.enabledOnLogin && newValue.enabledOnLogin
  const becomingEnabledPublic = !prevValue.enabled && newValue.enabled
  const enabledKeysChanged =
    keysChanged && (newValue.enabled || newValue.enabledOnLogin)

  if (!becomingEnabledLogin && !becomingEnabledPublic && !enabledKeysChanged) return

  if (!newValue.siteKey || !newValue.secretKey) {
    guardFail('RECAPTCHA_KEYS_REQUIRED', {
      message: 'Site key and secret key are required when reCAPTCHA is enabled.',
    })
  }

  // Look up the verification row for this user. Row is session-bound
  // (session_jti) so a stolen short-lived session can't re-use a
  // verification minted from a different session.
  const siteHash = sha256Hex(newValue.siteKey!)
  const secretHash = sha256Hex(newValue.secretKey!)
  // Expiry compared in SQL via NOW(3) — same clock as the verify
  // route's INSERT (expires_at = NOW(3) + INTERVAL ... SECOND) so a
  // multi-host deploy with Node-clock skew can't surface a row as
  // valid/expired inconsistently across hosts. The row is returned
  // only when not-yet-expired; absence means "row missing OR expired"
  // — collapse both into the same RECAPTCHA_LOGIN_VERIFICATION_
  // REQUIRED response.
  const [rows] = (await tx.execute(sql`
    SELECT site_key_hash, secret_key_hash, version, session_jti
    FROM security_recaptcha_verification
    WHERE user_id = ${userId} AND expires_at > NOW(3)
  `)) as unknown as [
    Array<{
      site_key_hash: string
      secret_key_hash: string
      version: string
      session_jti: string | null
    }>,
  ]
  const row = rows[0]
  if (!row) guardFail('RECAPTCHA_LOGIN_VERIFICATION_REQUIRED')
  if (
    row!.site_key_hash !== siteHash ||
    row!.secret_key_hash !== secretHash ||
    row!.version !== newValue.version ||
    row!.session_jti !== jti
  ) {
    guardFail('RECAPTCHA_LOGIN_VERIFICATION_REQUIRED')
  }

  // One-shot: delete the verification row inside the same TX so a
  // stolen-session attacker can't reuse it across multiple PATCH
  // cycles within the 5-min window.
  await tx.execute(sql`
    DELETE FROM security_recaptcha_verification WHERE user_id = ${userId}
  `)
}

// ─── security_login_path ───
// Write the pending-revert row alongside the path change. Refuse the
// save if a previous pending row is still in flight (unconfirmed and
// unexpired) — avoids chaining unconfirmed changes.
// Caller passes `prevPath` = the current effective path (the DB row's
// path, or env.LOGIN_PATH as bootstrap default).
export async function guardLoginPath(
  tx: Tx,
  newPath: string,
  prevPath: string,
  saverUserId: number,
): Promise<void> {
  if (newPath === prevPath) return // no-op save; let the upstream path handle

  // Hard-block when the env override is set — a DB save would be inert
  // (getResolvedLoginPath honors env first), and silently letting the
  // save "succeed" misleads the operator into thinking their new path
  // is live. Force them to remove the env override + restart first.
  if (env.LOGIN_PATH_OVERRIDE) {
    guardFail('LOGIN_PATH_OVERRIDE_SET', {
      message: `LOGIN_PATH_OVERRIDE env is set to "${env.LOGIN_PATH_OVERRIDE}" — remove it from the environment and restart PM2 before changing the DB path.`,
    })
  }

  const [rows] = (await tx.execute(sql`
    SELECT expires_at, confirmed_at
    FROM security_login_path_pending
    WHERE id = 1
  `)) as unknown as [Array<{ expires_at: Date | string; confirmed_at: Date | string | null }>]
  const row = rows[0]
  if (row) {
    const exp =
      typeof row.expires_at === 'string'
        ? new Date(row.expires_at).getTime()
        : row.expires_at.getTime()
    if (!row.confirmed_at && exp > Date.now()) {
      guardFail('LOGIN_PATH_CHANGE_IN_FLIGHT', {
        message: 'A previous login-path change is still awaiting confirmation. Confirm it or wait for auto-revert.',
      })
    }
  }
  // expires_at computed server-side via NOW(3) + INTERVAL so the
  // comparison in getResolvedLoginPath uses the same DB clock — no
  // Node↔DB skew under multi-host deploys.
  await tx.execute(sql`
    INSERT INTO security_login_path_pending (id, previous_path, new_path, expires_at, confirmed_at, created_at, created_by)
    VALUES (1, ${prevPath}, ${newPath}, NOW(3) + INTERVAL 10 MINUTE, NULL, NOW(3), ${saverUserId})
    ON DUPLICATE KEY UPDATE
      previous_path = VALUES(previous_path),
      new_path = VALUES(new_path),
      expires_at = VALUES(expires_at),
      confirmed_at = NULL,
      created_at = NOW(3),
      created_by = VALUES(created_by)
  `)
}

export { sha256Hex }
