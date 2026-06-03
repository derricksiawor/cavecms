import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { CookieConsentEditor } from './CookieConsentEditor'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
}

export default async function CookieSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version
    FROM settings
    WHERE \`key\` = 'cookie_consent'
  `)) as unknown as [SettingRow[]]

  const row = rows[0]
  const raw =
    row && typeof row.value === 'string'
      ? (() => {
          try {
            return JSON.parse(row.value as string)
          } catch {
            return registry.cookie_consent.default
          }
        })()
      : (row?.value ?? registry.cookie_consent.default)
  // Normalize to the full shape (fills any field added since the row was
  // saved); fall back to the registry default if the stored blob is invalid.
  const parsed = registry.cookie_consent.schema.safeParse(raw)
  const value = parsed.success ? parsed.data : registry.cookie_consent.default

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Cookie consent
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        A GDPR-style consent banner for your visitors. When enabled, first-time
        visitors choose which cookie categories they allow — Reject all,
        Customise, or Accept all. Their choice is remembered, and your Google
        Analytics / Ads tags (under <span className="font-semibold text-near-black">Settings
        → Integrations</span>) only store data once the matching category is
        granted. Visitors can reopen this anytime from the footer link.
      </p>

      <CookieConsentEditor initial={{ value, version: row?.version ?? 0 }} />
    </div>
  )
}
