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
        This is your site-wide palette — the colours every page, the header,
        and the footer are built from. Start from one of the ready-made styles
        below (the same ones shown on cavecms — Obsidian &amp; Gold, Carbon,
        Sand &amp; Sea…), or set each colour by hand: Primary colours your
        headings, Accent your buttons and links, Secondary your supporting
        text.
      </p>
      <p className="mt-3 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Choosing a style here re-skins the whole site at once. Whether the
        header and footer each read light or dark is a separate, per-bar choice
        under <span className="font-semibold text-near-black">Settings → Site
        header</span> and <span className="font-semibold text-near-black">Settings
        → Footer</span> — those tone pickers use these colours.
      </p>

      <ThemeSettingsClient
        initial={{ value: palette, version: raw?.version ?? 0 }}
      />
    </div>
  )
}
