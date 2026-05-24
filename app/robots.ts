import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

// Host-aware robots.txt. Only the apex production host (from
// env.SITE_ORIGIN) advertises the public site; every other host
// (staging.*, preview-*, localhost, IP access, future dev.* etc.)
// returns a blanket Disallow:/ so crawlers don't index
// pre-launch content from a non-canonical origin.
//
// On the apex: allow crawling everywhere except /admin and /api/*.
// The secret login path is INTENTIONALLY omitted — listing it
// would reveal its existence; security relies on it being
// unguessable + middleware returning generic redirects to / for
// unauthenticated /admin requests (see middleware.ts and the
// global project gold-standard rules).
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = (await headers()).get('host') ?? ''
  const apexHost = new URL(env.SITE_ORIGIN).host
  if (host !== apexHost) {
    // Omit the `host` directive on non-apex responses. Emitting
    // `https://localhost:3040` or similar would be a confusing
    // canonical signal; crawlers correctly ignore the field when
    // the host they fetched is not the apex, so the safest
    // behavior is to drop it entirely.
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    }
  }
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/'] }],
    sitemap: `${env.SITE_ORIGIN}/sitemap.xml`,
    host: env.SITE_ORIGIN,
  }
}
