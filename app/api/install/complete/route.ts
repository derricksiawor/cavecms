import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { __resetInstallStateCache } from '@/lib/install/installState'
import {
  ipFromRequest,
  requireInstallToken,
  makeInstallLimit,
  refuseIfInstalled,
  checkRate,
  okJson,
} from '@/lib/install/installEndpointHelpers'

// POST /api/install/complete — wizard finalisation.
//
// Flips install_state.completedAt and busts the isInstalled() cache so
// the very next middleware request sees installed=true and locks
// /install permanently.
//
// Carved out of /api/install/site-init (which used to set this flag
// alongside the site_general write) so the optional follow-up steps
// (branding / contact / smtp / security-baseline) can run between site
// identity and completion without the install-complete gate refusing
// them.
//
// Idempotent: if already complete, refuses with 410 (the wizard
// reading 410 means "you finished — refresh and you'll see /admin").

export const dynamic = 'force-dynamic'

const installLimit = makeInstallLimit('complete')

export const POST = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  checkRate(installLimit, ip)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  // Merge with the existing install_state row so we preserve the
  // forensic fields (adminCreatedAt, initialSiteUrl) written by
  // earlier steps.
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

  const completedAt = new Date().toISOString()
  const merged = JSON.stringify({ ...existing, completedAt })

  await db.execute(sql`
    INSERT INTO settings (\`key\`, value, version, updated_by)
    VALUES ('install_state', ${merged}, 1, NULL)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      version = version + 1
  `)

  __resetInstallStateCache()
  return okJson({ ok: true, completedAt })
})
