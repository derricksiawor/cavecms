import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { HttpError } from '@/lib/auth/requireRole'
import { isInstalled } from '@/lib/install/installState'
import { requireInstallToken } from '@/lib/install/installEndpointHelpers'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

// POST /api/install/site-init — wizard step 3.
// Writes settings.site_general (siteUrl + siteName) ONLY. Completion
// (flipping install_state.completedAt) was moved to its own endpoint
// /api/install/complete so the wizard can walk through the optional
// follow-up steps (branding, contact, SMTP, security baseline) without
// being locked out by the install-complete middleware gate.
//
// Refuses if isInstalled() is already true — defence in depth.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    siteUrl: z
      .string()
      .url()
      .max(500)
      .refine(
        (u) => u.startsWith('https://') && !u.endsWith('/'),
        'must_be_https_no_trailing_slash',
      ),
    siteName: z.string().min(1).max(120),
  })
  .strict()

const installLimit = rateLimit('install:site', { limit: 5, windowSec: 300 })

export const POST = withError(async (req: Request) => {
  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!installLimit(ip)) {
    throw new HttpError(429, 'rate_limited')
  }

  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail

  if (await isInstalled()) {
    return new Response(JSON.stringify({ error: 'already_installed' }), {
      status: 410,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  const body = Body.parse(await readJsonBody(req))

  // Write site_general ONLY — completion lives in /api/install/complete.
  const siteGeneralValue = JSON.stringify({
    siteUrl: body.siteUrl,
    siteName: body.siteName,
  })
  await db.execute(sql`
    INSERT INTO settings (\`key\`, value, version, updated_by)
    VALUES ('site_general', ${siteGeneralValue}, 1, NULL)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      version = version + 1
  `)
  // Also stash the initialSiteUrl on install_state so /complete has a
  // forensic record of which URL the operator entered, surviving any
  // later site_general edit.
  const [existingRows] = (await db.execute(sql`
    SELECT value FROM settings WHERE \`key\` = 'install_state'
  `)) as unknown as [Array<{ value: unknown }>]
  const existingRaw = existingRows[0]?.value
  const existing =
    typeof existingRaw === 'string'
      ? (() => {
          try {
            return JSON.parse(existingRaw) as Record<string, unknown>
          } catch {
            return {}
          }
        })()
      : ((existingRaw as Record<string, unknown> | null | undefined) ?? {})
  const installStateValue = JSON.stringify({
    ...existing,
    initialSiteUrl: body.siteUrl,
  })
  await db.execute(sql`
    INSERT INTO settings (\`key\`, value, version, updated_by)
    VALUES ('install_state', ${installStateValue}, 1, NULL)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      version = version + 1
  `)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
