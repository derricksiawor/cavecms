import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { generateApiToken, listApiTokens } from '@/lib/auth/apiToken'
import { isDuplicateKey } from '@/lib/db/errors'

// List all API tokens (metadata only — the secret is never recoverable).
// Query lives in lib/auth/apiToken.ts (shared with the SSR page).
export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const rows = await listApiTokens()
  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})

const Create = z
  .object({
    name: z.string().min(1).max(120),
    // Capped to admin|editor — no viewer (read-only API tokens add no
    // value today) and no path above admin (see the reauth/middleware cap).
    role: z.enum(['admin', 'editor']),
    // Optional hard expiry, 1 day … 10 years. Omitted = never expires.
    expiresInDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict()

interface InsertResult {
  insertId: number
}

// Mint a token. Admin-only + CSRF + step-up reauth (creating a long-lived
// programmatic credential is security-sensitive). The plaintext token is
// returned EXACTLY ONCE in this response and is never stored or
// recoverable afterwards.
export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  await requireFreshReauth(ctx.jti)

  const body = Create.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)
  const { token, hash, prefix } = generateApiToken()
  // Compute expiry as a concrete timestamp in Node rather than via a SQL
  // `INTERVAL ? DAY` expression — deterministic, driver-agnostic, and bound
  // as an ordinary parameter (expiresInDays is a Zod-validated int 1..3650).
  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 86_400_000)
    : null

  // Mint + audit in ONE transaction so the schema's documented "mutation and
  // its audit row commit together, or neither does" invariant holds (an
  // audit-insert failure rolls back the token rather than leaving an
  // un-audited live credential). Mirrors the sibling content routes.
  let id: number
  try {
    id = await db.transaction(async (tx) => {
      const [insertArr] = (await tx.execute(sql`
        INSERT INTO api_tokens
          (name, token_hash, token_prefix, role, created_by, expires_at)
        VALUES
          (${body.name}, ${hash}, ${prefix}, ${body.role}, ${ctx.userId}, ${expiresAt})
      `)) as unknown as [InsertResult]
      const newId = Number(insertArr.insertId)
      // Audit row never stores the token or its hash — name + role only.
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'api_token_create',
        resourceType: 'api_token',
        resourceId: String(newId),
        diff: { name: body.name, role: body.role } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
      return newId
    })
  } catch (err: unknown) {
    // Astronomically unlikely (256-bit collision) but handled for honesty.
    if (isDuplicateKey(err)) throw new HttpError(409, 'token_collision')
    throw err
  }

  // `token` is shown to the operator once and never again.
  return new Response(JSON.stringify({ id, token, prefix, role: body.role }), {
    status: 201,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
