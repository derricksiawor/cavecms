import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { verifyRecaptchaWithConfig } from '@/lib/security/recaptcha'
import { sha256Hex } from '@/lib/security/patchGuards'

// Live verify-keys handshake. The admin types siteKey + secretKey in
// the Security settings panel, clicks "Test these keys", and the
// browser POSTs here with a token minted by the typed siteKey.
//
// Server runs Google siteverify with the TYPED secretKey + the
// operator's IP, then records a 5-minute verification row keyed on
// {userId, siteKeyHash, secretKeyHash, version}. The PATCH
// /api/admin/settings guard for security_recaptcha refuses to set
// enabledOnLogin=true unless a matching unexpired row exists.
//
// Returns 200 + { ok: true } on success, 422 + { error, reason? } on
// rejection. No token replay risk: rows are UPSERTed by user_id so a
// later verify with different keys overwrites the prior row.

const VERIFICATION_TTL_MS = 5 * 60 * 1000

const Body = z
  .object({
    version: z.enum(['v2', 'v3']),
    siteKey: z.string().min(20).max(120),
    secretKey: z.string().min(20).max(120),
    token: z.string().min(10).max(4000),
  })
  .strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  await requireFreshReauth(ctx.jti)

  const body = Body.parse(await readJsonBody(req))

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? undefined

  const result = await verifyRecaptchaWithConfig(
    body.token,
    {
      version: body.version,
      siteKey: body.siteKey,
      secretKey: body.secretKey,
      // For verify-time challenges we use the action 'verify_keys'
      // for v3 (matches what RecaptchaVerifyModal calls execute with).
      // For v2 the SDK ignores expectedAction.
      minScore: 0,
      expectedAction: body.version === 'v3' ? 'verify_keys' : undefined,
    },
    ip,
  )

  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: 'verify_failed', reason: result.reason }),
      {
        status: 422,
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      },
    )
  }

  const siteHash = sha256Hex(body.siteKey)
  const secretHash = sha256Hex(body.secretKey)
  // expires_at computed server-side via INTERVAL so the comparison in
  // the PATCH guard uses one DB clock — no Node↔DB skew under
  // multi-host deploys. Row carries session_jti so a stolen short-
  // lived session can't reuse the verification cross-session.
  // Sweep any expired rows for OTHER users in the same statement so
  // the table doesn't grow unboundedly. This is a single point of
  // amortised cleanup — small users-count, infrequent operation.
  await db.execute(sql`
    DELETE FROM security_recaptcha_verification
    WHERE expires_at < NOW(3) AND user_id != ${ctx.userId}
  `)
  await db.execute(sql`
    INSERT INTO security_recaptcha_verification
      (user_id, session_jti, site_key_hash, secret_key_hash, version, verified_at, expires_at)
    VALUES (
      ${ctx.userId}, ${ctx.jti}, ${siteHash}, ${secretHash}, ${body.version},
      NOW(3), NOW(3) + INTERVAL ${Math.floor(VERIFICATION_TTL_MS / 1000)} SECOND
    )
    ON DUPLICATE KEY UPDATE
      session_jti = VALUES(session_jti),
      site_key_hash = VALUES(site_key_hash),
      secret_key_hash = VALUES(secret_key_hash),
      version = VALUES(version),
      verified_at = NOW(3),
      expires_at = VALUES(expires_at)
  `)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
