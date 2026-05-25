import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'

export const dynamic = 'force-dynamic'

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
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/'] }],
    sitemap: `${configuredOrigin}/sitemap.xml`,
    host: configuredOrigin,
  }
}
