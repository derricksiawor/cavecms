import {
  mysqlTable,
  int,
  varchar,
  mediumtext,
  boolean,
  json,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// Blog post entity. Markdown body lives in `body_md` and is rendered
// server-side through lib/cms/markdown.ts (unified → remark-gfm →
// rehype-sanitize) before being inlined via dangerouslySetInnerHTML —
// no client-side markdown render path, so the sanitizer is the only
// trust boundary. `published_at` is set on the first publish (admin-
// only); subsequent unpublish/republish keeps the original date so a
// reader who bookmarked the URL doesn't see the publication time
// jitter. `author_id` is the writer at create time; updated_by tracks
// the last editor for buildSets parity with projects.
//
// slug_redirects already supports 'post' resource_type (see
// db/schema/projects.ts) so a slug rename here reuses that map —
// no new redirect table needed.
export const posts = mysqlTable(
  'posts',
  {
    id: int('id').primaryKey().autoincrement(),
    slug: varchar('slug', { length: 140 }).notNull(),
    title: varchar('title', { length: 220 }).notNull(),
    excerpt: varchar('excerpt', { length: 320 }),
    bodyMd: mediumtext('body_md').notNull(),
    heroImageId: int('hero_image_id'),
    published: boolean('published').notNull().default(false),
    publishedAt: timestamp('published_at', { fsp: 3 }),
    authorId: int('author_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    seoTitle: varchar('seo_title', { length: 180 }),
    seoDescription: varchar('seo_description', { length: 320 }),
    ogImageId: int('og_image_id'),
    // ─── SEO suite (migration 0032) ───
    focusKeyphrase: varchar('focus_keyphrase', { length: 160 }),
    robotsNoindex: boolean('robots_noindex').notNull().default(false),
    robotsNofollow: boolean('robots_nofollow').notNull().default(false),
    canonicalUrl: varchar('canonical_url', { length: 500 }),
    cornerstone: boolean('cornerstone').notNull().default(false),
    seoScore: int('seo_score'),
    readabilityScore: int('readability_score'),
    seoMeta: json('seo_meta'),
    version: int('version').notNull().default(0),
    deletedAt: timestamp('deleted_at', { fsp: 3 }),
    updatedBy: int('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('idx_posts_slug').on(t.slug),
    // Composite for /blog index: filter by published, sort by
    // published_at DESC. The leading equality on `published` lets
    // MySQL drop unpublished rows before sorting.
    publishedIdx: index('idx_posts_published').on(
      t.published,
      t.publishedAt,
    ),
    // Composite (deleted_at, updated_at) replaces the single-column
    // idx_posts_deleted. Serves both the admin active-list query
    // (`WHERE deleted_at IS NULL ORDER BY updated_at DESC`) and the
    // trashed-list query (`WHERE deleted_at IS NOT NULL ORDER BY
    // deleted_at DESC`) without a filesort. MySQL reads the leading
    // edge of the index either segment depending on the filter.
    deletedUpdatedIdx: index('idx_posts_deleted_updated').on(
      t.deletedAt,
      t.updatedAt,
    ),
  }),
)
