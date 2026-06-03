import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { SocialSchemaClient } from './SocialSchemaClient'

// Social & Schema — how links to the site preview when shared (seo_social:
// X card style, account handles, content language, Facebook app id) plus
// the site-wide structured-data defaults (seo_schema: company vs person,
// breadcrumbs, default article type, sitelinks search box). Two independent
// settings keys; missing rows are synthesized from the registry default at
// version 0 so the form can save them on first edit (the PATCH route
// handles the INSERT path when version=0).

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
}

type SocialKey = 'seo_social' | 'seo_schema'

function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export default async function SocialSchemaPage() {
  await requireRoleOrRedirect(['admin'])

  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version
    FROM settings
    WHERE \`key\` IN ('seo_social', 'seo_schema')
  `)) as unknown as [SettingRow[]]

  const byKey = new Map(
    rawRows.map((r) => [r.key, { ...r, value: parseValue(r.value) }]),
  )

  function rowFor(key: SocialKey) {
    const existing = byKey.get(key)
    if (existing) return existing
    return { key, value: registry[key].default, version: 0 }
  }

  const social = rowFor('seo_social')
  const schema = rowFor('seo_schema')

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Search engine optimisation
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Social &amp; Schema
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Make your links look right when they&rsquo;re shared, and give search
        engines the background they need to show richer results.{' '}
        <Link
          href="/admin/seo"
          className="font-medium text-copper-700 underline-offset-2 hover:underline"
        >
          Back to the SEO overview →
        </Link>
      </p>

      <SocialSchemaClient
        social={{ value: social.value, version: social.version }}
        schema={{ value: schema.value, version: schema.version }}
        defaults={{
          seo_social: registry.seo_social.default,
          seo_schema: registry.seo_schema.default,
        }}
      />
    </div>
  )
}
