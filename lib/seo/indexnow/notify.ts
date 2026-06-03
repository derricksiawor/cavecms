import 'server-only'
import { getSetting } from '@/lib/cms/getSettings'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { submitUrls } from '@/lib/seo/indexnow/submit'

// Fire-and-forget IndexNow submission for a set of same-origin paths (or
// absolute URLs) that just changed. Reads the operator's IndexNow config
// + the canonical site origin, short-circuits when IndexNow is disabled /
// unconfigured / submit-on-publish off, and NEVER throws — callers invoke
// it from content publish/unpublish paths where a failed ping must never
// fail the save. Submission errors are recorded inside submitUrls (which
// also never throws) and discarded here; IndexNow is strictly best-effort.
//
// Usage (do NOT await — let it run in the background of the long-lived
// standalone server): `void notifyIndexNow(['/blog/my-post'])`.
export async function notifyIndexNow(pathsOrUrls: string[]): Promise<void> {
  try {
    if (pathsOrUrls.length === 0) return
    const cfg = await getSetting('seo_indexnow')
    if (!cfg.enabled || !cfg.key || cfg.submitOnPublish === false) return
    const origin = await getSiteOrigin()
    if (!origin) return // no canonical origin → nothing crawlable to announce
    const host = new URL(origin).host
    const urls = pathsOrUrls.map((u) =>
      /^https?:\/\//i.test(u) ? u : `${origin}${u.startsWith('/') ? '' : '/'}${u}`,
    )
    await submitUrls({
      host,
      key: cfg.key,
      keyLocation: `${origin}/${cfg.key}.txt`,
      urls,
      engines: cfg.engines,
    })
  } catch {
    // best-effort — swallow everything
  }
}
