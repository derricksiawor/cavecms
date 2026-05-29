import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { THEME_PALETTE_DEFAULT, type ThemePalette } from '@/lib/cms/themeCss'
import { ThemeSettingsClient } from './ThemeSettingsClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
}

export default async function ThemeSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version
    FROM settings
    WHERE \`key\` = 'theme_palette'
    LIMIT 1
  `)) as unknown as [SettingRow[]]

  const raw = rows[0]
  const parsedValue =
    raw && typeof raw.value === 'string'
      ? (() => {
          try {
            return JSON.parse(raw.value as string)
          } catch {
            return registry.theme_palette.default
          }
        })()
      : (raw?.value ?? registry.theme_palette.default)

  // Normalize against defaults so the client always gets a full palette
  // even if the stored row predates a field.
  const palette: ThemePalette = {
    ...THEME_PALETTE_DEFAULT,
    ...(parsedValue && typeof parsedValue === 'object' ? parsedValue : {}),
  }

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Theme
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Set your brand colors. Primary colors your headings, Accent your
        buttons and links, Secondary your supporting text — applied across
        every page, the header, and the footer. The obsidian / ivory /
        champagne section tones stay; these colors decide what they look
        like.
      </p>

      <ThemeSettingsClient
        initial={{ value: palette, version: raw?.version ?? 0 }}
      />
    </div>
  )
}
