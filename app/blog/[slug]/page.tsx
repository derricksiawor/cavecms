import { notFound, permanentRedirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { renderMarkdown } from '@/lib/cms/markdown'
import { blogPostingLd } from '@/lib/seo/jsonLd'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { resolveMetadata } from '@/lib/seo/resolve'
import { safeJsonForScript } from '@/lib/seo/escape'
import { extraSchemaForEntity } from '@/lib/seo/schema/forPage'
import { getSetting } from '@/lib/cms/getSettings'
import { parseSeoMeta, schemaDefaultsFromSetting } from '@/lib/seo/seoMeta'

export const dynamic = 'force-dynamic'

type Params = Promise<{ slug: string }>

export async function generateMetadata({ params }: { params: Params }) {
  const { slug } = await params
  const [rows] = (await db.execute(sql`
    SELECT title, excerpt, seo_title, seo_description,
           robots_noindex, robots_nofollow, canonical_url, seo_meta
    FROM posts
    WHERE slug = ${slug} AND published = TRUE AND deleted_at IS NULL
  `)) as unknown as [
    Array<{
      title: string
      excerpt: string | null
      seo_title: string | null
      seo_description: string | null
      robots_noindex: number | null
      robots_nofollow: number | null
      canonical_url: string | null
      seo_meta: unknown
    }>,
  ]
  const r = rows[0]
  const meta = parseSeoMeta(r?.seo_meta)
  return resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? r?.excerpt ?? null,
    fallbackTitle: r?.title ?? 'Post',
    canonicalPath: `/blog/${slug}`,
    contentType: 'post',
    templateVars: { title: r?.title ?? undefined, excerpt: r?.excerpt ?? undefined },
    noindex: !!r?.robots_noindex,
    nofollow: !!r?.robots_nofollow,
    canonicalOverride: r?.canonical_url,
    ogTitle: meta.ogTitle,
    ogDescription: meta.ogDescription,
    twitterTitle: meta.twitterTitle,
    twitterDescription: meta.twitterDescription,
  })
}

interface PostDetailRow {
  id: number
  slug: string
  title: string
  excerpt: string | null
  body_md: string
  // mysql2 may return TIMESTAMP as Date OR ISO string depending on
  // driver config (`dateStrings`). Accept both and convert at use.
  published_at: Date | string | null
  updated_at: Date | string | null
  hero_image_id: number | null
  author_name: string | null
  hero_variants: string | { lg?: string } | null
  seo_description: string | null
  seo_meta: unknown
}

// NOTE: do NOT wrap the body of this function in try/catch. Next.js
// signals redirects/notFounds via thrown errors (NEXT_REDIRECT,
// NEXT_NOT_FOUND). A naive try/catch would swallow these and produce
// a 200 with broken markup.
export default async function BlogPost({ params }: { params: Params }) {
  const { slug } = await params

  const [rows] = (await db.execute(sql`
    SELECT p.id, p.slug, p.title, p.excerpt, p.body_md, p.published_at,
           p.updated_at, p.hero_image_id, u.name AS author_name,
           m.variants AS hero_variants,
           p.seo_description, p.seo_meta
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id
    LEFT JOIN media m ON m.id = p.hero_image_id AND m.deleted_at IS NULL
    WHERE p.slug = ${slug}
      AND p.published = TRUE
      AND p.deleted_at IS NULL
  `)) as unknown as [PostDetailRow[]]
  const post = rows[0]

  if (!post) {
    // Resolution order matches /projects/[slug]: published render →
    // slug_redirects 308 → 404. permanentRedirect throws
    // NEXT_REDIRECT which Next surfaces as HTTP 308.
    const [redirRows] = (await db.execute(sql`
      SELECT new_slug FROM slug_redirects
      WHERE resource_type = 'post' AND old_slug = ${slug}
    `)) as unknown as [Array<{ new_slug: string }>]
    if (redirRows[0]) permanentRedirect(`/blog/${redirRows[0].new_slug}`)
    notFound()
  }

  // mysql2 may return the JSON column as either a parsed object or a
  // raw string depending on driver config — match the projects list
  // page's defensive parse.
  const heroVariants: { lg?: string } | null =
    typeof post.hero_variants === 'string'
      ? (JSON.parse(post.hero_variants) as { lg?: string })
      : (post.hero_variants as { lg?: string } | null)

  const html = await renderMarkdown(post.body_md)

  // published_at is non-null on every published row because the
  // PATCH route stamps it on first publish; the COALESCE check here
  // is defense-in-depth against a hypothetical row that was
  // published via direct DB edit. Normalize to Date regardless of
  // whether mysql2 returned a string or a Date object.
  const publishedAt = post.published_at
    ? new Date(post.published_at)
    : new Date()

  const siteOrigin = await getSiteOrigin()
  const ld = blogPostingLd({
    title: post.title,
    slug: post.slug,
    publishedAt,
    excerpt: post.excerpt,
    heroImage: heroVariants?.lg ?? null,
    author: post.author_name ?? 'CaveCMS',
    siteOrigin,
  })

  // Per-page structured data — ADDITIONS-ONLY on top of the legacy
  // blogPostingLd PRIMARY emitted above. This emits ONLY (a) the
  // BreadcrumbList (Home › Blog › Post) and (b) the explicit per-page
  // override shape when the operator flips schemaType (e.g. to FAQPage /
  // NewsArticle). It NEVER emits a default Article — that would duplicate
  // the BlogPosting primary the legacy builder already produced for this
  // URL. The post URL drives both the entity url + breadcrumb trail; when
  // siteOrigin is unset we use the relative path (consistent with the
  // legacy builders omitting absolute URLs).
  const meta = parseSeoMeta(post.seo_meta)
  const seoSchema = await getSetting('seo_schema')
  const postUrl = siteOrigin
    ? `${siteOrigin}/blog/${post.slug}`
    : `/blog/${post.slug}`
  const breadcrumbs = [
    { name: 'Home', url: siteOrigin ? `${siteOrigin}/` : '/' },
    { name: 'Blog', url: siteOrigin ? `${siteOrigin}/blog` : '/blog' },
    { name: post.title, url: postUrl },
  ]
  const schemaGraph = extraSchemaForEntity({
    entity: {
      kind: 'post',
      title: post.title,
      description: post.seo_description ?? post.excerpt ?? undefined,
      url: postUrl,
      datePublished: publishedAt,
      dateModified: post.updated_at ? new Date(post.updated_at) : undefined,
      author: post.author_name ?? undefined,
      image: heroVariants?.lg ?? undefined,
    },
    override: { schemaType: meta.schemaType, schemaData: meta.schemaData },
    defaults: schemaDefaultsFromSetting(seoSchema),
    breadcrumbs,
  })

  return (
    <main className="py-12 max-w-3xl mx-auto px-4">
      <script
        type="application/ld+json"
        // safeJsonForScript escapes </script>, --> and U+2028/U+2029
        // so admin-controlled fields (title, excerpt, author) can
        // never break out of the script tag.
        dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
      />
      {/* Per-page schema ADDITIONS + breadcrumbs. extraSchemaForEntity
          returns an already-filtered ordered array (no nulls, no default
          primary); each object is emitted via safeJsonForScript like the
          legacy BlogPosting primary above. */}
      {schemaGraph.map((node, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonForScript(node) }}
        />
      ))}
      <h1 className="text-3xl font-semibold tracking-tight">{post.title}</h1>
      <time
        className="text-xs uppercase tracking-wide text-copper-600 mt-2 inline-block"
        dateTime={publishedAt.toISOString()}
      >
        {publishedAt.toISOString().slice(0, 10)}
        {post.author_name ? ` · ${post.author_name}` : null}
      </time>
      {heroVariants?.lg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={heroVariants.lg}
          alt=""
          className="w-full h-auto mt-6 rounded"
        />
      )}
      <article
        className="prose mt-8"
        // body_md is server-rendered via the rehype-sanitize pipeline
        // in lib/cms/markdown.ts. The sanitizer is the only trust
        // boundary; the editor surface posts plain markdown.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </main>
  )
}
