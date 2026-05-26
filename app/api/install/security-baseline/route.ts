import { z } from 'zod'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { RESERVED } from '@/lib/cms/page-slug'
import {
  ipFromRequest,
  requireInstallToken,
  makeInstallLimit,
  refuseIfInstalled,
  checkRate,
  upsertSetting,
  okJson,
} from '@/lib/install/installEndpointHelpers'

// POST /api/install/security-baseline — wizard security baseline step
// (OPTIONAL).
//
// Lets the operator override the random LOGIN_PATH the CLI generated
// (which is hard to remember) with something they'll actually type at
// signin time. The override gets written to settings.security_login_path,
// which getResolvedLoginPath() prefers over the env fallback.
//
// reCAPTCHA + IP allowlist are deliberately NOT collected here — they're
// power-user configuration that operators almost never have ready during
// the install minute. Live in Settings → Security after the wizard.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    loginPath: z
      .string()
      .regex(/^[a-z0-9-]{6,32}$/, 'must_be_6_to_32_lowercase_or_dash')
      .refine((v) => !RESERVED.has(v.toLowerCase()), 'collides_with_reserved_path'),
  })
  .strict()

const installLimit = makeInstallLimit('security')

export const POST = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  checkRate(installLimit, ip)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  const body = Body.parse(await readJsonBody(req))

  await upsertSetting('security_login_path', { path: body.loginPath })

  return okJson({ ok: true, loginPath: body.loginPath })
})
