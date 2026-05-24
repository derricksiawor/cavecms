import { unstable_cache } from 'next/cache'
import { getRecaptchaServerConfig } from '@/lib/security/recaptcha'

// Public surface for client-side reCAPTCHA wiring. Returns ONLY the
// fields safe for the browser — version + siteKey. Never the secret.
// Lead forms fetch this on mount, decide whether to load the v3
// script or render the v2 widget, and emit a token on submit.
//
// Tag-cached: PATCH /api/admin/settings revalidates the 'settings'
// tag on any save, which busts this cache so a flip in the security
// panel reaches the next page render without a deploy.
//
// 60-second `revalidate` backstop matches getSetting()'s own
// revalidate window — if for any reason the tag-invalidation chain
// missed, this self-heals within a minute.
//
// No `force-dynamic` export: the route reads no per-request state, so
// Next can statically optimise it. unstable_cache + tag invalidation
// handles freshness.

const readConfig = unstable_cache(
  async () => {
    const cfg = await getRecaptchaServerConfig('public')
    if (!cfg) return { enabled: false } as const
    return {
      enabled: true,
      version: cfg.version,
      siteKey: cfg.siteKey,
    } as const
  },
  ['public-recaptcha-config'],
  { tags: ['settings'], revalidate: 60 },
)

export async function GET(): Promise<Response> {
  const body = await readConfig()
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Operator-side config: short browser cache acceptable, but
      // `must-revalidate` keeps a stale cached "disabled" response
      // from masking a re-enable for too long.
      'cache-control': 'public, max-age=30, must-revalidate',
    },
  })
}
