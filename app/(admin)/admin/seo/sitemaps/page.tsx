import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { SitemapsCrawlClient } from './SitemapsCrawlClient'

// Sitemaps & Crawl — the XML sitemap configuration (seo_sitemap: master
// switch, what to include, exclude-noindex, per-file split limit) and the
// operator's additive robots.txt rules (seo_robots: extraRules + a live
// preview of the FULL resulting file). Two independent settings keys;
// missing rows are synthesized from the registry default at version 0 so
// the form can save them on first edit (the PATCH route handles the INSERT
// path when version=0). The origin feeds the live sitemap URL + the
// robots.txt preview's Sitemap/Host lines.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
}

type SitemapKey = 'seo_sitemap' | 'seo_robots'

function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export default async function SitemapsCrawlPage() {
  await requireRoleOrRedirect(['admin'])

  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version
    FROM settings
    WHERE \`key\` IN ('seo_sitemap', 'seo_robots')
  `)) as unknown as [SettingRow[]]

  const byKey = new Map(
    rawRows.map((r) => [r.key, { ...r, value: parseValue(r.value) }]),
  )

  function rowFor(key: SitemapKey) {
    const existing = byKey.get(key)
    if (existing) return existing
    return { key, value: registry[key].default, version: 0 }
  }

  const sitemap = rowFor('seo_sitemap')
  const robots = rowFor('seo_robots')
  const origin = await getSiteOrigin()

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Search engine optimisation
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Sitemaps &amp; Crawl
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Hand search engines a tidy map of your pages, and fine-tune what their
        crawlers are allowed to visit. Your admin and internal pages stay
        private no matter what.{' '}
        <Link
          href="/admin/seo"
          className="font-medium text-copper-700 underline-offset-2 hover:underline"
        >
          Back to the SEO overview →
        </Link>
      </p>

      <SitemapsCrawlClient
        sitemap={{ value: sitemap.value, version: sitemap.version }}
        robots={{ value: robots.value, version: robots.version }}
        origin={origin}
        defaults={{
          seo_sitemap: registry.seo_sitemap.default,
          seo_robots: registry.seo_robots.default,
        }}
      />
    </div>
  )
}
