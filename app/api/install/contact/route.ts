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

// POST /api/install/contact — wizard contact-info step (OPTIONAL).
//
// Writes settings.contact_info. The schema requires phone / email /
// address / hours, but the wizard collects only email (the high-value
// one — it powers the public Contact form's lead notifications). The
// rest are left as empty strings that the operator fills in from
// Settings → Contact later.
//
// Why a one-field MVP step instead of all four fields? The wizard
// optimises for "got the customer past it in under 30s." A four-field
// form would be a longer pause. Empty strings render as "no phone /
// hours yet" in the footer — graceful degradation.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    email: z.string().email().max(180),
    // All optional — present for operators who want to fill them in
    // here rather than later.
    phone: z.string().max(40).regex(/^[+\d\s\-().]*$/, 'invalid_phone').optional(),
    address: z.string().max(280).optional(),
    hours: z.string().max(120).optional(),
  })
  .strict()

const installLimit = makeInstallLimit('contact')

export const POST = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  checkRate(installLimit, ip)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  const body = Body.parse(await readJsonBody(req))

  await upsertSetting('contact_info', {
    email: body.email,
    phone: body.phone ?? '',
    address: body.address ?? '',
    hours: body.hours ?? '',
  })

  return okJson()
})
