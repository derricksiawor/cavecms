import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry, type SettingsKey } from '@/lib/cms/settings-registry'
import { MediaPickerProvider } from '@/components/inline-edit/MediaPickerProvider'
import { SettingsForm } from './SettingsForm'

const REGISTRY_KEYS = Object.keys(registry) as SettingsKey[]

// Operator-visible order. New entries (site_header) sit near the top
// so they're the first thing an admin sees; technical / SEO rows are
// at the bottom.
const KEY_ORDER: SettingsKey[] = [
  'site_header',
  // mobile_cta lives near the top — the sticky bottom bar is a
  // visible-on-every-mobile-page change, so operators expect it
  // adjacent to the global header settings rather than buried at
  // the bottom with SEO config.
  'mobile_cta',
  'contact_info',
  'social_links',
  'footer',
  'default_seo',
  'organization_json_ld',
]

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date
}

export default async function AdminSettings() {
  await requireRoleOrRedirect(['admin'])
  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    ORDER BY \`key\`
  `)) as unknown as [SettingRow[]]

  // MariaDB aliases JSON to LONGTEXT, so mysql2 returns the value
  // column as a string (unlike MySQL native JSON which auto-parses).
  // Same pattern as lib/cms/getSettings.ts — parse before handing off
  // to the form so `[]` reaches the client as an array, not the
  // string "[]" (which crashes array-shaped field renderers).
  const parsed = rawRows.map((r) => ({
    ...r,
    value:
      typeof r.value === 'string'
        ? (() => {
            try {
              return JSON.parse(r.value as string)
            } catch {
              return r.value
            }
          })()
        : r.value,
  }))

  // Merge DB rows with the full registry so a newly-added setting
  // shows up in the admin UI even before its row exists. The PATCH
  // route accepts version=0 as the "no row yet" sentinel and INSERTs
  // on first save (see app/api/admin/settings/route.ts).
  const byKey = new Map(parsed.map((r) => [r.key, r]))
  const synthesizedNow = new Date()
  const rows = (
    KEY_ORDER.includes('site_header')
      ? KEY_ORDER
      : (REGISTRY_KEYS as SettingsKey[])
  )
    .filter((k) => REGISTRY_KEYS.includes(k))
    .map((k) => {
      const existing = byKey.get(k)
      if (existing) return existing
      return {
        key: k,
        value: registry[k].default,
        version: 0,
        updated_at: synthesizedNow,
      }
    })

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Settings
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        The pieces that show up across your entire site — contact info,
        footer, social links, and the default look in search results.
        We&rsquo;ll ask you to re-enter your password before any changes go
        live.
      </p>
      <MediaPickerProvider>
        <SettingsForm initial={rows} />
      </MediaPickerProvider>
    </div>
  )
}
