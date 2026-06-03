import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { isMissingTable } from '@/lib/db/errors'
import { getSetting } from '@/lib/cms/getSettings'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { submitUrls } from '@/lib/seo/indexnow/submit'

// Manual "Submit all now" endpoint for the Connect & Verify page's
// IndexNow card. UNLIKE the publish-time notifyIndexNow() helper, this is
// an operator-initiated action — so it deliberately does NOT gate on
// `submitOnPublish` (that toggle only governs the automatic ping on every
// publish; the operator clicking "Submit all now" always means "do it").
//
// Body { urls?: string[] }:
//   • urls given  → submit exactly those (the form may pass a curated set;
//     today the UI always submits everything, but the shape is here so a
//     future "submit this page" affordance reuses the same route).
//   • urls absent → enumerate every PUBLISHED page (url_path), post
//     (/blog/<slug>), and project (/projects/<slug>), build absolute URLs
//     against the configured site origin, and submit the lot.
//
// Returns the SubmitReport as JSON. 400 (clear message) when IndexNow is
// off, has no key, or the site origin isn't configured yet. Never throws
// to the client — submitUrls itself never throws, and everything else is
// wrapped by withError.

// Cap the auto-enumerated set so a runaway content table can't fan out an
// unbounded POST. IndexNow's own per-POST ceiling is 10k (submitUrls
// chunks at that); we cap the gathered set well below the protocol max
// for a single manual click. A site past this should rely on the
// per-publish ping, which covers each new URL as it ships.
const MAX_ENUMERATED_URLS = 10_000

const Body = z
  .object({
    urls: z.array(z.string().url().max(2048)).max(10_000).optional(),
  })
  .strict()

interface PathRow {
  url_path: string | null
}
interface SlugRow {
  slug: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = Body.parse(await readJsonBody(req))

  const cfg = await getSetting('seo_indexnow')
  if (!cfg.enabled || !cfg.key) {
    return json(
      {
        error: 'indexnow_not_configured',
        message:
          'Turn on IndexNow and generate a key before submitting URLs.',
      },
      400,
    )
  }

  const origin = await getSiteOrigin()
  if (!origin) {
    return json(
      {
        error: 'site_url_not_set',
        message:
          'Set your Site URL under Settings → General first — IndexNow needs your public address to submit URLs.',
      },
      400,
    )
  }

  const host = new URL(origin).host

  // Resolve the URL set. Explicit list wins; otherwise enumerate
  // published content. Each branch yields ABSOLUTE same-origin URLs —
  // submitUrls re-validates host + dedupes, so a stray cross-host or
  // duplicate is dropped+reported rather than failing the batch.
  let urls: string[]
  if (body.urls && body.urls.length > 0) {
    urls = body.urls
  } else {
    urls = await enumeratePublishedUrls(origin)
    if (urls.length === 0) {
      return json(
        {
          error: 'nothing_to_submit',
          message:
            'No published pages, posts, or projects yet — there is nothing to submit.',
        },
        400,
      )
    }
  }

  const report = await submitUrls({
    host,
    key: cfg.key,
    keyLocation: `${origin}/${cfg.key}.txt`,
    urls,
    engines: cfg.engines,
  })

  return json({ ok: true, report }, 200)
})

// Gather every published page/post/project as an absolute URL. Uses the
// SAME URL shapes as app/sitemap.ts (pages → url_path; projects →
// /projects/<slug>; posts → /blog/<slug>) AND the SAME indexable filter
// so the manual submit matches what the sitemap exposes: each SELECT is
// gated on the matching `seo_sitemap.include*` toggle, and drops any
// row carrying robots_noindex=1 (the sitemap's `excludeNoindex`). A URL
// IndexNow announces that the sitemap excludes is a contradictory signal
// to engines — gating both channels off the same config keeps them
// consistent. posts retains the missing-table feature-detect (the table
// may be absent on early deploys). The three reads run in parallel
// (Promise.all) — independent queries, no shared state. Bounded by
// MAX_ENUMERATED_URLS via per-query LIMIT so the gathered set can't grow
// past the manual-submit ceiling.
async function enumeratePublishedUrls(origin: string): Promise<string[]> {
  // Read the sitemap config ONCE — the include* toggles decide which
  // content types contribute. getSetting fails closed to the registry
  // default (every include true), so `cfg` is always well-formed.
  const cfg = await getSetting('seo_sitemap')

  // Match the sitemap's per-page noindex filter. The `IS NULL` arm
  // covers rows created before migration 0032 backfilled the column.
  const noindexClause = sql` AND (robots_noindex = 0 OR robots_noindex IS NULL)`

  const [pageRows, projectRows, postRows] = await Promise.all([
    cfg.includePages
      ? (async () => {
          const [rows] = (await db.execute(sql`
            SELECT url_path
            FROM pages
            WHERE published = 1 AND deleted_at IS NULL${noindexClause}
            ORDER BY is_home DESC, updated_at DESC
            LIMIT ${MAX_ENUMERATED_URLS}
          `)) as unknown as [PathRow[]]
          return rows
        })()
      : Promise.resolve([] as PathRow[]),
    cfg.includeProjects
      ? (async () => {
          const [rows] = (await db.execute(sql`
            SELECT slug
            FROM projects
            WHERE published = TRUE AND deleted_at IS NULL${noindexClause}
            LIMIT ${MAX_ENUMERATED_URLS}
          `)) as unknown as [SlugRow[]]
          return rows
        })()
      : Promise.resolve([] as SlugRow[]),
    cfg.includePosts
      ? (async () => {
          try {
            const [rows] = (await db.execute(sql`
              SELECT slug
              FROM posts
              WHERE published = TRUE AND deleted_at IS NULL${noindexClause}
              LIMIT ${MAX_ENUMERATED_URLS}
            `)) as unknown as [SlugRow[]]
            return rows
          } catch (err) {
            if (!isMissingTable(err)) throw err
            return [] as SlugRow[]
          }
        })()
      : Promise.resolve([] as SlugRow[]),
  ])

  const out: string[] = []
  for (const p of pageRows) {
    out.push(`${origin}${p.url_path ?? '/'}`)
  }
  for (const p of projectRows) {
    out.push(`${origin}/projects/${p.slug}`)
  }
  for (const p of postRows) {
    out.push(`${origin}/blog/${p.slug}`)
  }

  // Hard cap the merged set (home is ordered first within pages, so the
  // tail is what would fall off — never the homepage).
  return out.slice(0, MAX_ENUMERATED_URLS)
}
