import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { hashPassword } from '@/lib/auth/scrypt'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { getSiteOrigin, getSiteName } from '@/lib/cms/getSiteOrigin'
import { getResolvedLoginPath } from '@/lib/security/getResolvedLoginPath'
import { enqueueEmail } from '@/lib/email/queue'
import { userInviteEmail } from '@/lib/email/templates/userInvite'
import { logEnqueueFailure } from '@/lib/leads/logEnqueueFailure'

interface UserRow {
  id: number
  email: string
  name: string | null
  role: 'admin' | 'editor' | 'viewer'
  active: number
  must_rotate_password: number
  last_login_at: Date | null
  created_at: Date
}

export const GET = withError(async () => {
  const ctx = await requireRole(adminPolicy('inviteUser'))
  checkReadRate(ctx.userId)
  const [rows] = (await db.execute(sql`
    SELECT id, email, name, role, active, must_rotate_password,
           last_login_at, created_at
    FROM users
    ORDER BY id
  `)) as unknown as [UserRow[]]
  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})

// Minimum password length on user CREATE — 12 chars, mirroring the
// project's standard for new admin accounts. Login passwords from
// pre-Plan-08 admin can be shorter (legacy); rotation flow at
// /auth/rotate enforces the new floor.
const Create = z
  .object({
    email: z
      .string()
      .min(3)
      .max(180)
      .email(),
    name: z.string().min(1).max(180).optional(),
    role: z.enum(['admin', 'editor', 'viewer']),
    password: z.string().min(12).max(200),
  })
  .strict()

interface InsertResult {
  insertId: number
}

// Creating a user requires admin + fresh reauth. The created user
// always lands with must_rotate_password=TRUE so the operator's
// chosen initial password is single-use — the new user is forced
// to set their own at first login.
export const POST = withError(async (req) => {
  const ctx = await requireRole(adminPolicy('inviteUser'))
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  await requireFreshReauth(ctx.jti)

  const body = Create.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)
  const hash = await hashPassword(body.password)

  try {
    const [insertArr] = (await db.execute(sql`
      INSERT INTO users (email, name, role, password_hash, must_rotate_password)
      VALUES (${body.email.toLowerCase().trim()},
              ${body.name ?? null},
              ${body.role},
              ${hash},
              TRUE)
    `)) as unknown as [InsertResult]
    const newUserId = Number(insertArr.insertId)

    // Invite email — tells the new user their account exists and where to
    // sign in. The starter password is NEVER emailed (the admin hands it
    // over directly, and it's single-use anyway). Needs a configured Site
    // URL to build the absolute sign-in link; without one, `emailed:false`
    // tells the UI to say so. Enqueue only — delivery runs in the
    // background (#0.599); a failed enqueue is logged, never a 500 (the
    // account itself was created fine).
    let emailed = false
    const origin = await getSiteOrigin()
    if (origin) {
      try {
        const [siteName, loginPath, inviterRows] = await Promise.all([
          getSiteName(),
          getResolvedLoginPath(),
          db.execute(sql`
            SELECT COALESCE(NULLIF(name, ''), email) AS name
            FROM users WHERE id = ${ctx.userId} LIMIT 1
          `) as unknown as Promise<[Array<{ name: string | null }>]>,
        ])
        const enqueuedId = await enqueueEmail(
          userInviteEmail({
            to: body.email.toLowerCase().trim(),
            name: body.name ?? null,
            siteName,
            signInUrl: `${origin.replace(/\/+$/, '')}/${loginPath.replace(/^\/+/, '')}`,
            invitedBy: inviterRows[0]?.[0]?.name ?? null,
          }),
        )
        emailed = enqueuedId > 0
      } catch (err) {
        await logEnqueueFailure('admin:user_invite', body.email, err)
      }
    }

    // Audit row: never includes the password hash. Email + role only.
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'create',
      resourceType: 'user',
      resourceId: String(newUserId),
      diff: { email: body.email, role: body.role, emailed } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    return new Response(JSON.stringify({ ok: true, id: newUserId, emailed }), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (err: unknown) {
    if (isDuplicateKey(err)) throw new HttpError(409, 'email_taken')
    throw err
  }
})
