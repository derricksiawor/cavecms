import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { verifyTransport } from '@/lib/email/transport'

// POST /api/admin/email/verify — probe SMTP credentials WITHOUT
// persisting them. Used by the Settings → Email "Test connection"
// button so an operator can validate credentials before flipping
// `enabled: true` (which the settings PATCH route also gates on a
// successful verify — this endpoint is the operator's instant-
// feedback companion).
//
// Body shape: a partial smtp_config. If `password` is empty AND a
// password is already on file for the current `smtp_config` row, we
// reuse the stored one (otherwise the test would fail when the
// operator clicks Test without touching the redacted field).

export const dynamic = 'force-dynamic'

// Pass-through schema — accepts extra keys (the form sends the full
// `enabled` toggle + everything else, even though verify only cares
// about the connection parameters). Strict-mode would 400 on those.
const Body = z.object({
  host: z.string().max(200).optional(),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().max(180).optional(),
  password: z.string().max(400).optional(),
  fromAddress: z.string().max(180).optional(),
  fromName: z.string().max(120).optional(),
})

interface SettingRow {
  value: unknown
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = Body.parse(await readJsonBody(req))

  // Resolve password: empty incoming → reuse stored. Mirrors the
  // settings PATCH credential-preserving merge.
  let password = body.password ?? ''
  if (!password) {
    const [rows] = (await db.execute(sql`
      SELECT value FROM settings WHERE \`key\` = 'smtp_config'
    `)) as unknown as [SettingRow[]]
    const stored = rows[0]?.value
    const parsed =
      typeof stored === 'string'
        ? (() => {
            try {
              return JSON.parse(stored) as Record<string, unknown>
            } catch {
              return null
            }
          })()
        : (stored as Record<string, unknown> | null | undefined)
    const storedPwd = parsed?.password
    if (typeof storedPwd === 'string') password = storedPwd
  }

  const result = await verifyTransport({
    host: body.host,
    port: body.port,
    secure: body.secure,
    user: body.user || undefined,
    password,
    fromAddress: body.fromAddress || '',
    fromName: body.fromName || undefined,
  })

  if (!result.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: result.error }),
      {
        status: 422,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      },
    )
  }

  return new Response(
    JSON.stringify({ ok: true }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  )
})
