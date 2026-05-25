import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'
import { UpdatesClient } from './UpdatesClient'

// Admin-only Settings → Updates surface.
//
// Server component pattern (mirrors Settings → Security): read the
// `updates` settings row (synthesize {version:0, default} if absent),
// resolve the running version from env, and hand both to a client
// component that drives the interactive bits (Check Now button,
// update modal, settings form).

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
}

export default async function UpdatesSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    WHERE \`key\` = 'updates'
    LIMIT 1
  `)) as unknown as [SettingRow[]]

  const synthesizedNow = new Date()
  const raw = rows[0]
  const parsedValue =
    raw && typeof raw.value === 'string'
      ? (() => {
          try {
            return JSON.parse(raw.value as string)
          } catch {
            return registry.updates.default
          }
        })()
      : (raw?.value ?? registry.updates.default)

  const initial = {
    key: 'updates' as const,
    value: parsedValue,
    version: raw?.version ?? 0,
    updatedAt:
      raw?.updated_at instanceof Date
        ? raw.updated_at.toISOString()
        : typeof raw?.updated_at === 'string'
          ? raw.updated_at
          : synthesizedNow.toISOString(),
  }

  const current = getCurrentVersion()

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Updates
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Keep your site current. We&rsquo;ll let you know when there&rsquo;s a
        new version and walk you through a one-click install — if anything
        goes wrong, we&rsquo;ll automatically put your site back the way it
        was.
      </p>

      <UpdatesClient initial={initial} currentVersion={current} />
    </div>
  )
}
