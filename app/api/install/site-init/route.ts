import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { HttpError } from '@/lib/auth/requireRole'
import { isInstalled, __resetInstallStateCache } from '@/lib/install/installState'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

// POST /api/install/site-init — wizard step 3.
// Writes settings.site_general (siteUrl + siteName) AND flips the
// install_state.completedAt flag, which makes the middleware:
//   - lock /install permanently (subsequent /install GETs → /admin)
//   - serve every other route normally (the redirect-everything-to-
//     /install gate stops firing)
//
// We bundle site-init + completion into ONE endpoint because the
// email step is fully skippable (configured later) and the site URL
// is the last REQUIRED piece of config. If the operator skips email,
// they land on /done with the install already marked complete.
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

  if (await isInstalled()) {
    return new Response(JSON.stringify({ error: 'already_installed' }), {
      status: 410,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  const body = Body.parse(await readJsonBody(req))

  await db.transaction(async (tx) => {
    // Write site_general.
    const siteGeneralValue = JSON.stringify({
      siteUrl: body.siteUrl,
      siteName: body.siteName,
    })
    await tx.execute(sql`
      INSERT INTO settings (\`key\`, value, version, updated_by)
      VALUES ('site_general', ${siteGeneralValue}, 1, NULL)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        version = version + 1
    `)

    // Mark install complete. Merge with the existing pending row
    // that admin-create wrote, preserving its `adminCreatedAt`
    // forensic marker.
    const [existingRows] = (await tx.execute(sql`
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
      completedAt: new Date().toISOString(),
      initialSiteUrl: body.siteUrl,
    })
    await tx.execute(sql`
      INSERT INTO settings (\`key\`, value, version, updated_by)
      VALUES ('install_state', ${installStateValue}, 1, NULL)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        version = version + 1
    `)
  })

  // Bust the isInstalled() cache so the very next middleware request
  // sees installed=true and locks /install. Without this, the
  // operator could refresh /install during the 5s cache window and
  // briefly re-enter the wizard.
  __resetInstallStateCache()

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
