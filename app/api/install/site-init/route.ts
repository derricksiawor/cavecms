import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { HttpError } from '@/lib/auth/requireRole'
import { isInstalled } from '@/lib/install/installState'
import { isLoopbackUrl } from '@/lib/security/hostKind'
import { requireInstallToken } from '@/lib/install/installEndpointHelpers'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'

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

  // A public install (cpanel / vps / pm2) can never have a localhost Site URL —
  // the in-app updater's health check, the sitemap, and update emails all
  // derive from it, and a loopback host breaks every one of them. The wizard
  // pre-fills this from the request host, which is localhost when the operator
  // reaches /install over an SSH tunnel during setup, so this is the
  // authoritative gate. Laptop dev installs legitimately use localhost.
  // The message is rendered verbatim in the wizard, so it's a full sentence.
  // Gate on the surface being SET to a public one: an UNSET var means
  // contributor dev (`pnpm dev`) or a laptop install, both of which legitimately
  // use localhost. A real public install always has this written by the CLI.
  const installSurface = process.env.CAVECMS_RESTART_MODE
  if (
    installSurface &&
    installSurface !== 'laptop' &&
    isLoopbackUrl(body.siteUrl)
  ) {
    throw new HttpError(
      422,
      "Your site address can't be localhost. Enter the public web address visitors use, for example https://yoursite.com.",
    )
  }

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
  // Bust the tag-cached getSetting() snapshot so the very next wizard
  // step (template / branding) reads the operator's freshly-saved
  // site_general values, not the registry default. Without this,
  // template seeding can render with "Your Site" for up to 60 s.
  safeRevalidate([tag.settings]).catch(() => undefined)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
