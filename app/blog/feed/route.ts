import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { getSiteOrigin, getSiteName } from '@/lib/cms/getSiteOrigin'
import { resolveSegments } from '@/lib/blog/resolveSegments'
import { blogIndexUrl, feedUrl, postUrl } from '@/lib/blog/urls'
// blog-system worktree (Phase 8): public post-visibility gate (adds the
// scheduling clause so a future-dated post is never emitted into the feed).
import { publicPostGateSql } from '@/lib/cms/postStatus'
import { isMissingTable } from '@/lib/db/errors'

// /blog/feed — RSS 2.0 for the blog. Served at the configured segment via the
// existing middleware rewrite (/<blogSeg>/feed | feed.xml -> /blog/feed; see
// lib/blog/segmentRewrite.ts), and directly at /blog/feed on the default segment.
//
// CONTRACT
//   - Returns the latest `blog_settings.feedItemCount` PUBLICLY-VISIBLE posts
//     (publicPostGateSql: published + not-trashed + publish time arrived —
//     Phase 8 added the scheduling clause so a future-dated post is held back),
//     newest first. lastBuildDate derives from rows[0], so it reflects the
//     newest VISIBLE post, never a not-yet-live scheduled one.
//   - Valid RSS 2.0: a single <channel> with title/link/description/
//     lastBuildDate + <atom:link rel="self">; one <item> per post carrying
//     title/link/guid/pubDate/description.
//   - EVERY dynamic value is XML-escaped (xmlEscape below) so an operator's
//     title/excerpt containing &, <, >, " or a control char can never break
//     well-formedness or inject markup into the feed.
//   - Absolute item links are built from postUrl (segment + structure aware)
//     prefixed with the operator's site origin (Settings -> General). When the
//     operator hasn't configured a Site URL yet (fresh install, dev), we DERIVE
//     the origin from the request's forwarded Host + proto headers instead of
//     emitting relative paths — RSS readers fetch the feed out-of-context and a
//     relative <link>/<guid> is non-dereferenceable for them. The derived
//     origin is the host the request actually came in on (same as robots.ts /
//     sitemap.ts read), so it's correct for whatever address the reader used.
//
// CACHING
//   The post save/publish/delete paths already bust the `posts-index` tag
//   (lib/cache/tags.ts tagsForPostSave/Delete/Restore add tag.postsIndex on any
//   publish/slug/core change). This route is force-dynamic (mirrors the blog
//   index + sitemap, which are also force-dynamic) so the feed is always fresh;
//   the tag wiring is already correct should a CDN/edge cache be layered on.

export const dynamic = 'force-dynamic'

// XML 1.0 forbids C0 control chars except tab (U+0009), newline (U+000A) and
// carriage-return (U+000D). Built from \u escapes (no literal control bytes in
// source — those are fragile and some editors strip them).
const ILLEGAL_XML_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]',
  'g',
)

// XML 1.0 text escape. & is replaced FIRST so a literal & isn't double-escaped
// after the entity replacements introduce their own &. Illegal control chars are
// stripped before escaping so the output is always well-formed.
function xmlEscape(value: string): string {
  return value
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// RFC-822 / RFC-1123 date for RSS pubDate + lastBuildDate. RSS readers expect
// this format (not ISO-8601). toUTCString() emits exactly
// "Wed, 03 Jun 2026 04:58:57 GMT", which is RFC-1123-compliant.
function rfc822(value: Date | string | null): string {
  const d = value ? new Date(value) : new Date()
  return Number.isNaN(d.getTime()) ? new Date(0).toUTCString() : d.toUTCString()
}

interface FeedRow {
  slug: string
  title: string
  excerpt: string | null
  published_at: Date | string | null
}

// Derive the request's own origin from the forwarded Host + proto headers —
// the same headers robots.ts / sitemap.ts / the middleware redirects read.
// Behind a reverse proxy `Host` carries the public hostname and
// `x-forwarded-proto` the public scheme; on a direct localhost/LAN hit Host is
// the listener address and there's no XFP (so we default http). Returns null
// when there's no usable Host so callers keep their relative-path fallback
// rather than emit a malformed `://path` origin.
function originFromRequest(req: Request): string | null {
  const host = req.headers.get('host')
  if (!host) return null
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  // XFP can be a comma list ("https, http") behind chained proxies — take the
  // first, trimmed, and only honour the two valid schemes.
  const scheme = proto.split(',')[0]!.trim()
  const safeScheme = scheme === 'https' || scheme === 'http' ? scheme : 'http'
  return `${safeScheme}://${host}`
}

export async function GET(req: Request): Promise<Response> {
  // Resolve the configured permalink segments + site identity once.
  const [segments, configuredOrigin, siteName] = await Promise.all([
    resolveSegments(),
    getSiteOrigin(),
    getSiteName(),
  ])
  // Prefer the operator's configured Site URL; when unset, fall back to the
  // origin the request came in on so every <link>/<guid> is still ABSOLUTE
  // (RSS readers need absolute URLs — see CONTRACT above).
  const siteOrigin = configuredOrigin ?? originFromRequest(req)
  const blog = await getSetting('blog_settings')

  // Bounded by the registry (feedItemCount is Zod-clamped 1..50); the extra
  // Math.min is defence-in-depth so a malformed row can never request an
  // unbounded scan.
  const limit = Math.min(50, Math.max(1, Math.floor(blog.feedItemCount)))

  // Missing-table-safe (F9): mirror fetchRecentPostsSafely — on a fresh/partial
  // install where the `posts` table isn't migrated yet, degrade to an empty BUT
  // valid <channel> (rows=[] already produces one below) instead of a 500. Any
  // other DB error propagates so a real outage isn't masked.
  let rows: FeedRow[]
  try {
    ;[rows] = (await db.execute(sql`
      SELECT p.slug, p.title, p.excerpt, p.published_at
      FROM posts p
      WHERE 1 = 1
        ${publicPostGateSql('p')}
      ORDER BY p.published_at DESC, p.id DESC
      LIMIT ${limit}
    `)) as unknown as [FeedRow[]]
  } catch (err) {
    if (isMissingTable(err)) {
      rows = []
    } else {
      throw err
    }
  }

  // Absolute when the origin is configured; relative path otherwise (a wrong
  // absolute URL is worse than a relative one for a feed reader).
  const abs = (path: string) => (siteOrigin ? `${siteOrigin}${path}` : path)
  const channelLink = abs(blogIndexUrl(1, segments))
  const selfLink = abs(feedUrl(segments))
  const channelTitle = `${siteName} — Blog`
  const channelDescription = `Latest posts from ${siteName}.`

  // lastBuildDate = newest post's publish time, else now.
  const lastBuild = rfc822(rows[0]?.published_at ?? null)

  const items = rows
    .map((r) => {
      const link = abs(postUrl(r.slug, segments, r.published_at))
      // Description: excerpt when present, else the title (never empty — an
      // empty <description> is valid but unhelpful in a reader).
      const description = r.excerpt?.trim() || r.title
      return [
        '    <item>',
        `      <title>${xmlEscape(r.title)}</title>`,
        `      <link>${xmlEscape(link)}</link>`,
        // isPermaLink="false" — the guid is the canonical link string but we
        // don't promise it's dereferenceable forever (a slug rename 301s), so
        // false is the honest, RSS-correct value.
        `      <guid isPermaLink="false">${xmlEscape(link)}</guid>`,
        `      <pubDate>${rfc822(r.published_at)}</pubDate>`,
        `      <description>${xmlEscape(description)}</description>`,
        '    </item>',
      ].join('\n')
    })
    .join('\n')

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(channelTitle)}</title>`,
    `    <link>${xmlEscape(channelLink)}</link>`,
    `    <description>${xmlEscape(channelDescription)}</description>`,
    `    <lastBuildDate>${lastBuild}</lastBuildDate>`,
    `    <atom:link href="${xmlEscape(selfLink)}" rel="self" type="application/rss+xml" />`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ]
    // Drop the empty items line when there are no posts so the channel stays
    // tidy (an empty <channel> with no <item> is valid RSS).
    .filter((line) => line !== '')
    .join('\n')

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    },
  })
}
