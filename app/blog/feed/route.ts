import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { getSiteOrigin, getSiteName } from '@/lib/cms/getSiteOrigin'
import { resolveSegments } from '@/lib/blog/resolveSegments'
import { blogIndexUrl, feedUrl, postUrl } from '@/lib/blog/urls'

// /blog/feed — RSS 2.0 for the blog. Served at the configured segment via the
// existing middleware rewrite (/<blogSeg>/feed | feed.xml -> /blog/feed; see
// lib/blog/segmentRewrite.ts), and directly at /blog/feed on the default segment.
//
// CONTRACT
//   - Returns the latest `blog_settings.feedItemCount` PUBLISHED posts
//     (published = TRUE AND deleted_at IS NULL), newest first.
//   - Valid RSS 2.0: a single <channel> with title/link/description/
//     lastBuildDate + <atom:link rel="self">; one <item> per post carrying
//     title/link/guid/pubDate/description.
//   - EVERY dynamic value is XML-escaped (xmlEscape below) so an operator's
//     title/excerpt containing &, <, >, " or a control char can never break
//     well-formedness or inject markup into the feed.
//   - Absolute item links are built from postUrl (segment + structure aware)
//     prefixed with the operator's site origin (Settings -> General). When the
//     origin is unset the link/guid fall back to the relative path — a feed
//     reader on the same origin still resolves it, and we never emit a wrong
//     absolute URL.
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

export async function GET(): Promise<Response> {
  // Resolve the configured permalink segments + site identity once.
  const [segments, siteOrigin, siteName] = await Promise.all([
    resolveSegments(),
    getSiteOrigin(),
    getSiteName(),
  ])
  const blog = await getSetting('blog_settings')

  // Bounded by the registry (feedItemCount is Zod-clamped 1..50); the extra
  // Math.min is defence-in-depth so a malformed row can never request an
  // unbounded scan.
  const limit = Math.min(50, Math.max(1, Math.floor(blog.feedItemCount)))

  const [rows] = (await db.execute(sql`
    SELECT p.slug, p.title, p.excerpt, p.published_at
    FROM posts p
    WHERE p.published = TRUE
      AND p.deleted_at IS NULL
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT ${limit}
  `)) as unknown as [FeedRow[]]

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
