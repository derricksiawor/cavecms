import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { TitlesMetaClient } from './TitlesMetaClient'

// Titles & Meta — the per-content-type title/description TEMPLATE editor
// plus the site-wide indexing policy. Two independent settings keys:
//   1. seo_titles    — the separator glyph + a {title, description}
//                      template pair for each of the eight content types.
//   2. seo_indexing  — the global "discourage search engines" kill-switch
//                      and the noindex-search / noindex-paginated toggles.
//
// Server component reads both rows; missing rows are synthesized from the
// registry default at version 0 so the form can save them on first edit
// (the PATCH route handles the INSERT path when version=0). Mirrors the
// security page's row-synthesis exactly.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
}

type TitlesKey = 'seo_titles' | 'seo_indexing'

function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export default async function TitlesMetaPage() {
  await requireRoleOrRedirect(['admin'])

  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version
    FROM settings
    WHERE \`key\` IN ('seo_titles', 'seo_indexing')
  `)) as unknown as [SettingRow[]]

  const byKey = new Map(
    rawRows.map((r) => [r.key, { ...r, value: parseValue(r.value) }]),
  )

  function rowFor(key: TitlesKey) {
    const existing = byKey.get(key)
    if (existing) return existing
    return { key, value: registry[key].default, version: 0 }
  }

  const titles = rowFor('seo_titles')
  const indexing = rowFor('seo_indexing')

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Search engine optimisation
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Titles &amp; Meta
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Set the headline and the snippet search engines show for every kind of
        page, and decide which pages are allowed to appear in search at all.{' '}
        <Link
          href="/admin/seo"
          className="font-medium text-copper-700 underline-offset-2 hover:underline"
        >
          Back to the SEO overview →
        </Link>
      </p>

      <TitlesMetaClient
        titles={{ value: titles.value, version: titles.version }}
        indexing={{ value: indexing.value, version: indexing.version }}
        defaults={{
          seo_titles: registry.seo_titles.default,
          seo_indexing: registry.seo_indexing.default,
        }}
      />
    </div>
  )
}
