import {
  mysqlTable,
  int,
  varchar,
  json,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// `projects` is the entity table. Each project carries the public-page
// status (state machine in lib/cms/projectStatus.ts), versioning for
// optimistic lock, preview_epoch for token revocation, and a SEO trio
// for the marketing pages in Plan 05. `deleted_at` is the soft-delete
// flag — recovery happens in /admin/trash (Plan 08) and the cron sweep
// (Plan 09) hard-purges rows older than 30 days with zero references.
export const projects = mysqlTable(
  'projects',
  {
    id: int('id').primaryKey().autoincrement(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    tagline: varchar('tagline', { length: 220 }),
    status: varchar('status', {
      length: 24,
      enum: ['coming_soon', 'under_construction', 'selling', 'sold_out'],
    }).notNull(),
    location: varchar('location', { length: 180 }),
    heroImageId: int('hero_image_id'),
    brochurePdfId: int('brochure_pdf_id'),
    featuredOrder: int('featured_order'),
    published: boolean('published').notNull().default(false),
    publishedAt: timestamp('published_at', { fsp: 3 }),
    seoTitle: varchar('seo_title', { length: 180 }),
    seoDescription: varchar('seo_description', { length: 320 }),
    ogImageId: int('og_image_id'),
    // ─── SEO suite (migration 0034) ───
    focusKeyphrase: varchar('focus_keyphrase', { length: 160 }),
    robotsNoindex: boolean('robots_noindex').notNull().default(false),
    robotsNofollow: boolean('robots_nofollow').notNull().default(false),
    canonicalUrl: varchar('canonical_url', { length: 500 }),
    cornerstone: boolean('cornerstone').notNull().default(false),
    seoScore: int('seo_score'),
    readabilityScore: int('readability_score'),
    seoMeta: json('seo_meta'),
    // Bumped on unpublish + slug rename + soft-delete to invalidate any
    // outstanding preview tokens. verifyPreviewJwt compares the token's
    // preview_epoch claim against this row.
    previewEpoch: int('preview_epoch').notNull().default(0),
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
    slugIdx: uniqueIndex('idx_projects_slug').on(t.slug),
    // Composite for the public list: filter by published, sort by
    // featured_order. MySQL uses this for the WHERE + leading sort key.
    publishedIdx: index('idx_projects_published').on(
      t.published,
      t.featuredOrder,
    ),
    deletedIdx: index('idx_projects_deleted').on(t.deletedAt),
  }),
)

// Each project has exactly 10 section rows — one per `section_key` —
// auto-seeded at create-time (see app/api/cms/projects/route.ts POST).
// The unique index closes the door on accidental dupes from a buggy
// seeder. `position` carries the editor's render order and lives in
// the 1000-step convention shared with content_blocks.
export const projectSections = mysqlTable(
  'project_sections',
  {
    id: int('id').primaryKey().autoincrement(),
    projectId: int('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sectionKey: varchar('section_key', {
      length: 32,
      enum: [
        'hero',
        'gallery',
        'floor_plans',
        'pricing',
        'amenities',
        'location',
        'brochure',
        'timeline',
        'testimonials',
        'inquiry',
      ],
    }).notNull(),
    position: int('position').notNull(),
    data: json('data').notNull(),
    version: int('version').notNull().default(0),
    updatedBy: int('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => ({
    keyUniq: uniqueIndex('idx_psecs_project_key').on(t.projectId, t.sectionKey),
    posIdx: index('idx_psecs_project_position').on(t.projectId, t.position),
  }),
)

// Old-slug → new-slug map used by the public page renderer to issue a
// 308 permanent redirect when an URL someone bookmarked or a search
// engine indexed has been renamed. The PATCH /api/cms/projects/[id]
// handler maintains this in the same TX as the rename — including
// chain collapse (A→B then B→C becomes A→C) and self-reference removal.
// `resource_type` is an enum so blog post renames (Plan 06) share the
// table without polluting the lookup index.
export const slugRedirects = mysqlTable(
  'slug_redirects',
  {
    id: int('id').primaryKey().autoincrement(),
    resourceType: varchar('resource_type', {
      length: 16,
      enum: ['project', 'post', 'page'],
    }).notNull(),
    oldSlug: varchar('old_slug', { length: 140 }).notNull(),
    newSlug: varchar('new_slug', { length: 140 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    typeOldUniq: uniqueIndex('idx_redirects_type_old').on(
      t.resourceType,
      t.oldSlug,
    ),
  }),
)
