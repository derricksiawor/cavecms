import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { getSetting } from '@/lib/cms/getSettings'

export const dynamic = 'force-dynamic'

// The admin base + API surface are ALWAYS disallowed on the public host,
// regardless of operator additions. These are re-asserted on the merged
// group below so a hostile/buggy extraRules merge can never drop them.
// (The obscured admin LOGIN path is deliberately NOT listed — naming it
// in robots.txt would leak its existence; it stays unadvertised.)
const MANAGED_DISALLOW = ['/admin', '/api/'] as const

// Parse the operator's additive robots.txt text (seo_robots.extraRules)
// into extra disallow/allow entries + an optional crawl-delay, to be
// FOLDED INTO the single managed `User-agent: *` group. The registry's
// Zod schema already forbids new groups / Sitemap / Host / Allow on the
// protected set, but this parser is defensive in depth: it only ever
// recognises simple `Disallow:`/`Allow:`/`Crawl-delay:` lines and
// silently skips everything else (blank, `#` comments, User-agent,
// Sitemap, Host, or any malformed directive). Nothing here can open a
// new group or re-permit the managed Disallows.
function parseExtraRules(extraRules: string): {
  disallow: string[]
  allow: string[]
  crawlDelay?: number
} {
  const disallow: string[] = []
  const allow: string[] = []
  let crawlDelay: number | undefined

  for (const raw of extraRules.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    // A single `Disallow: <path>` line → fold the path into the
    // managed group's disallow list. `Disallow:` with an empty value
    // is the robots.txt idiom for "allow everything"; we drop it
    // (the managed Allow:/ already covers that) rather than emit an
    // empty disallow that some parsers treat as Disallow:/.
    const dis = /^disallow\s*:\s*(.*)$/i.exec(line)
    if (dis) {
      const path = (dis[1] ?? '').trim()
      // Empty value = "allow everything" idiom → drop (managed Allow:/
      // covers it). A bare `Disallow: /` (block the whole site) is also
      // dropped here: it would sit ambiguously alongside the managed
      // `Allow: /` (crawlers resolve that to "crawlable"), so it wouldn't
      // actually work — full-site blocking is the "Discourage search
      // engines" switch's job, not an extraRules line.
      if (path !== '' && path !== '/') disallow.push(path)
      continue
    }

    // A single `Allow: <path>` line → fold into the managed group's
    // allow list. The schema already rejects `Allow: /admin|/api`, but
    // re-guard here so even a stale/tampered DB value can't re-permit
    // the protected surface through this code path.
    const alw = /^allow\s*:\s*(.*)$/i.exec(line)
    if (alw) {
      const path = (alw[1] ?? '').trim()
      if (path === '') continue
      if (/^\/(admin|api)\b/i.test(path)) continue
      allow.push(path)
      continue
    }

    // `Crawl-delay: <n>` — Next's Robots rule supports `crawlDelay`.
    // Pass through only a clean non-negative number (last one wins);
    // anything with junk after the number is ignored.
    const cd = /^crawl-delay\s*:\s*(\d+(?:\.\d+)?)\s*$/i.exec(line)
    if (cd) {
      const n = Number(cd[1] ?? '')
      if (Number.isFinite(n) && n >= 0) crawlDelay = n
      continue
    }

    // Any other line (User-agent, Sitemap, Host, unknown directive,
    // malformed) is silently skipped — defence in depth on top of the
    // registry schema.
  }

  return { disallow, allow, crawlDelay }
}

// Host-aware robots.txt. Only the operator's configured apex host
// (Settings → General → Site URL) advertises the public site; every
// other host (staging.*, preview-*, localhost, IP access, etc.)
// returns a blanket Disallow:/ so crawlers don't index pre-launch
// content from a non-canonical origin.
//
// Until the operator sets their Site URL, every host returns a
// blanket Disallow — safer default than emitting whatever host the
// crawler hit as canonical.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const configuredOrigin = await getSiteOrigin()
  if (!configuredOrigin) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    }
  }
  const host = (await headers()).get('host') ?? ''
  const apexHost = new URL(configuredOrigin).host
  if (host !== apexHost) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    }
  }

  // Apex host success path — now consult the SEO suite.
  const indexing = await getSetting('seo_indexing')

  // GLOBAL DISCOURAGE kill-switch (WordPress "Discourage search engines").
  // When on, the entire site is hidden: Disallow:/ with NO sitemap line.
  // This wins over everything below.
  if (indexing.discourageSearchEngines) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    }
  }

  // Merge the operator's additive extraRules into the SINGLE managed
  // `User-agent: *` group. The managed /admin + /api/ disallows are
  // always re-asserted (placed first), then deduped against operator
  // additions — they can never be dropped by the merge.
  const [robotsCfg, sitemapCfg] = await Promise.all([
    getSetting('seo_robots'),
    getSetting('seo_sitemap'),
  ])
  const extra = parseExtraRules(robotsCfg.extraRules)

  const disallow = Array.from(new Set<string>([...MANAGED_DISALLOW, ...extra.disallow]))
  const allow = Array.from(new Set<string>(['/', ...extra.allow]))

  return {
    rules: [
      {
        userAgent: '*',
        allow,
        disallow,
        ...(extra.crawlDelay !== undefined ? { crawlDelay: extra.crawlDelay } : {}),
      },
    ],
    // Only advertise the sitemap when it's actually enabled — pointing at
    // /sitemap.xml while seo_sitemap.enabled=false would be a contradictory
    // crawl signal (an index that resolves to an empty shard).
    ...(sitemapCfg.enabled ? { sitemap: `${configuredOrigin}/sitemap.xml` } : {}),
    host: configuredOrigin,
  }
}
