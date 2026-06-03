import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { isFontCatalogKey, TYPOGRAPHY_ROLES_DEFAULT } from '@/lib/typography/catalog'
import { TypographySettingsClient } from './TypographySettingsClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
}

export default async function TypographySettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version
    FROM settings
    WHERE \`key\` = 'typography_roles'
    LIMIT 1
  `)) as unknown as [SettingRow[]]

  const raw = rows[0]
  const parsed =
    raw && typeof raw.value === 'string'
      ? (() => {
          try {
            return JSON.parse(raw.value as string)
          } catch {
            return null
          }
        })()
      : (raw?.value ?? null)

  // Normalize + fail-closed: an unknown/garbage stored key falls back to the
  // shipped role default, exactly like getSetting does on the public side.
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const value = {
    display:
      typeof obj.display === 'string' && isFontCatalogKey(obj.display)
        ? obj.display
        : TYPOGRAPHY_ROLES_DEFAULT.display,
    body:
      typeof obj.body === 'string' && isFontCatalogKey(obj.body)
        ? obj.body
        : TYPOGRAPHY_ROLES_DEFAULT.body,
  }

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Typography
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Two faces define your whole site — one for headings, one for body copy.
        Pick the pairing here and every page follows it, unless an individual
        block sets its own font. All fonts are self-hosted, so there are no
        external requests and nothing leaks to third parties.
      </p>

      <TypographySettingsClient
        initial={{ value, version: raw?.version ?? 0 }}
      />
    </div>
  )
}
