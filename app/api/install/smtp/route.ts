import { z } from 'zod'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import {
  ipFromRequest,
  requireInstallToken,
  makeInstallLimit,
  refuseIfInstalled,
  checkRate,
  upsertSetting,
  okJson,
} from '@/lib/install/installEndpointHelpers'

// POST /api/install/smtp — wizard SMTP step (OPTIONAL).
//
// Two modes:
//   - testOnly=true:  verify the credentials against the SMTP server
//                     WITHOUT writing them to the DB. Used for the
//                     "Send test message" button.
//   - testOnly=false: verify credentials, then write smtp_config with
//                     enabled=true and the provided values.
//
// Refuses to enable SMTP unless the handshake succeeds — same gate the
// admin Settings → Email surface uses, so partially-correct credentials
// never get persisted in the "on" state (which would silently drop
// every lead notification / password reset / update alert).

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    host: z.string().min(1).max(200),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().min(1).max(180),
    password: z.string().min(1).max(400),
    fromAddress: z.string().email().max(180),
    fromName: z.string().max(120).optional(),
    notificationRecipient: z.string().email().max(180).optional(),
    testOnly: z.boolean().optional().default(false),
  })
  .strict()

const installLimit = makeInstallLimit('smtp')

export const POST = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  checkRate(installLimit, ip)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  const body = Body.parse(await readJsonBody(req))

  // Verify the credentials against the SMTP server BEFORE persisting.
  // The transport helper performs a real TCP connect + STARTTLS +
  // AUTH handshake; only a 2xx-class response counts.
  const { verifyTransport } = await import('@/lib/email/transport')
  const verify = await verifyTransport({
    host: body.host,
    port: body.port,
    secure: body.secure,
    user: body.user,
    password: body.password,
    fromAddress: body.fromAddress,
    fromName: body.fromName,
  })
  if (!verify.ok) {
    return new Response(
      JSON.stringify({ error: 'smtp_verify_failed', reason: verify.error }),
      { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    )
  }

  if (body.testOnly) {
    return okJson({ ok: true, verified: true })
  }

  // Persist as enabled. Password is stored plaintext in the JSON
  // value, matching the existing admin-settings storage pattern.
  // Redaction is enforced at the read-back UI boundary (not echoed
  // in /api/admin/settings responses).
  await upsertSetting('smtp_config', {
    enabled: true,
    host: body.host,
    port: body.port,
    secure: body.secure,
    user: body.user,
    password: body.password,
    fromAddress: body.fromAddress,
    fromName: body.fromName,
    notificationRecipient: body.notificationRecipient ?? body.fromAddress,
  })

  return okJson()
})
