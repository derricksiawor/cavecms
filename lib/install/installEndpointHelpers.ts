import { timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { isInstalled } from '@/lib/install/installState'
import { HttpError } from '@/lib/auth/requireRole'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

// Shared scaffolding for the install-wizard route handlers
// (/api/install/{branding,contact,smtp,security-baseline,complete}).
// All of these:
//   - rate-limit per IP (5 attempts / 5 min) — install endpoints should
//     fire once-per-install in normal operation
//   - refuse if installation is already complete (defence in depth
//     against a stale /install tab + a finished install racing)
//   - write to a `settings` row via INSERT ... ON DUPLICATE KEY UPDATE
//
// Centralised here so the per-step routes can stay small + the policy
// (rate, install-gate) is impossible to drift across endpoints.

export function makeInstallLimit(bucket: string) {
  return rateLimit(`install:${bucket}`, { limit: 5, windowSec: 300 })
}

export function ipFromRequest(req: Request): string {
  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  return clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
}

export async function refuseIfInstalled(): Promise<Response | null> {
  if (await isInstalled()) {
    return new Response(JSON.stringify({ error: 'already_installed' }), {
      status: 410,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  return null
}

/**
 * Bootstrap-token gate for /api/install/* endpoints.
 *
 * The CLI generates a random INSTALL_BOOTSTRAP_TOKEN (32 url-safe bytes)
 * at install time and writes it to env.production. The operator
 * receives a URL with the token embedded (e.g.
 * `https://site.com/install?t=<token>`); the wizard page reads it
 * from the query and includes it in every install-API call as the
 * `X-Install-Token` header.
 *
 * Why: between when the app boots and when the wizard completes,
 * /api/install/* is reachable by anyone on the internet. Without a
 * token gate, an attacker watching DNS / CT logs for new domains
 * could race the legitimate operator and claim the first admin
 * account. The rate limit alone is bypassable (IPv6 rotation, etc.).
 *
 * If INSTALL_BOOTSTRAP_TOKEN is unset (legacy installs that predate
 * this gate), the check is skipped — defensive, since pre-existing
 * production instances don't carry the env var until they re-install.
 * Document this caveat clearly: ALL new installs should have the
 * token, and the gate is the primary defence.
 *
 * Returns a 401 Response if the token is missing/wrong; null when OK.
 */
export function requireInstallToken(req: Request): Response | null {
  const expected = process.env.INSTALL_BOOTSTRAP_TOKEN
  if (!expected) {
    // Token not configured — fall through (legacy install path).
    // The isInstalled() gate is still in front of every endpoint.
    return null
  }
  const provided = req.headers.get('x-install-token') ?? ''
  // Length check up front: timingSafeEqual throws on length mismatch.
  // A mismatch IS a wrong token; this is safe to short-circuit
  // because length itself can't leak the expected length (it's known
  // to be 32 url-safe bytes by the CLI / spec).
  if (provided.length !== expected.length) {
    return tokenRejection()
  }
  let ok = false
  try {
    ok = timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    ok = false
  }
  if (!ok) return tokenRejection()
  return null
}

function tokenRejection(): Response {
  return new Response(
    JSON.stringify({
      error: 'install_token_missing_or_invalid',
      hint: 'Re-open the install URL the CLI printed (it includes ?t=<token>).',
    }),
    {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  )
}

export function checkRate(
  limit: (key: string) => boolean,
  ip: string,
): void {
  if (!limit(ip)) {
    throw new HttpError(429, 'rate_limited')
  }
}

/**
 * Upsert a `settings` row. The settings table's PRIMARY KEY is `key`,
 * so this is atomic + race-safe under concurrent install requests
 * (which shouldn't happen but defence in depth).
 */
export async function upsertSetting(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value)
  await db.execute(sql`
    INSERT INTO settings (\`key\`, value, version, updated_by)
    VALUES (${key}, ${json}, 1, NULL)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      version = version + 1
  `)
}

export function okJson(body: Record<string, unknown> = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
