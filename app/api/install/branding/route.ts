import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
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

// POST /api/install/branding — wizard branding step (OPTIONAL).
//
// Writes the minimum settings.site_header to brand the public site:
//   - brandText (the operator's brand name shown in the header)
//   - theme (cream / obsidian / ivory)
//
// Skipping is fine — the wizard renders a "Skip for now" affordance
// and the site falls back to the registry default ("Your Site",
// theme=cream). Logo upload + nav editing + the full footer shape
// stay in the dashboard's Settings → Branding surface; we keep this
// step lightweight so most operators sail through in 30 seconds.
//
// MERGES with whatever site_header is already in the DB rather than
// replacing it — preserves the registry-default navItems +
// primaryCta so the public header still has the canonical nav links
// even when the operator only customised the brand text.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    brandText: z.string().min(1).max(120),
    theme: z.enum(['cream', 'obsidian', 'ivory']).optional(),
  })
  .strict()

const installLimit = makeInstallLimit('branding')

export const POST = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  checkRate(installLimit, ip)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  const body = Body.parse(await readJsonBody(req))

  // Merge with existing site_header so we keep the registry defaults
  // (navItems + primaryCta) intact when the operator only changed
  // brand text / theme.
  const [existingRows] = (await db.execute(sql`
    SELECT value FROM settings WHERE \`key\` = 'site_header'
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

  const resolvedTheme = body.theme ?? existing.theme ?? 'cream'

  const merged: Record<string, unknown> = {
    // Operator overrides FIRST so they take priority via explicit
    // assignment below (avoids a duplicate-key literal in the source).
    brandText: body.brandText,
    theme: resolvedTheme,
    // Registry defaults — keep when unset.
    logo: existing.logo ?? null,
    navItems: existing.navItems ?? [
      { label: 'Home', href: '/' },
      { label: 'Projects', href: '/projects' },
      { label: 'Services', href: '/services' },
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
    ],
    primaryCta: existing.primaryCta ?? { text: 'Get in touch', href: '/contact' },
  }

  await upsertSetting('site_header', merged)

  // Link the footer theme to the chosen theme at SETUP time so header +
  // footer match out of the box. The footer remains an independent
  // setting afterward (Settings → Footer). Merge so we preserve any
  // footer shape already written (tagline, columns, newsletter copy).
  const [footerRows] = (await db.execute(sql`
    SELECT value FROM settings WHERE \`key\` = 'footer'
  `)) as unknown as [Array<{ value: unknown }>]
  const footerRaw = footerRows[0]?.value
  const existingFooter =
    typeof footerRaw === 'string'
      ? (() => {
          try {
            return JSON.parse(footerRaw) as Record<string, unknown>
          } catch {
            return {}
          }
        })()
      : ((footerRaw as Record<string, unknown> | null | undefined) ?? {})
  // Only augment an ALREADY-VALID footer (the template step writes a
  // complete one before this branding step runs). Writing a partial
  // `{ theme }` would lack the schema-required tagline/columns and
  // fail the footer Zod parse on read — discarding the theme entirely.
  // If no valid footer exists yet, skip: the footer default + the
  // template step's own theme-link cover it.
  if (
    typeof existingFooter.tagline === 'string' &&
    Array.isArray(existingFooter.columns)
  ) {
    await upsertSetting('footer', { ...existingFooter, theme: resolvedTheme })
  }

  return okJson()
})
