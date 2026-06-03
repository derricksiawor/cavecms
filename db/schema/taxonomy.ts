import {
  mysqlTable,
  int,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/mysql-core'
import { users } from './users'
import { posts } from './posts'

// Blog categories — one-level hierarchy (parent_id → categories.id, SET NULL).
// Slug validated in the app layer (page-slug rules + a taxonomy reserved set);
// the UNIQUE(slug) here is the final guard. `position` orders sibling
// categories in the admin + archive nav.
export const categories = mysqlTable(
  'categories',
  {
    id: int('id').primaryKey().autoincrement(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: varchar('description', { length: 320 }),
    parentId: int('parent_id'),
    position: int('position').notNull().default(0),
    version: int('version').notNull().default(0),
    updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('idx_categories_slug').on(t.slug),
    parentIdx: index('idx_categories_parent').on(t.parentId),
  }),
)

// Free-form tags (no hierarchy). Same slug discipline as categories.
export const tags = mysqlTable(
  'tags',
  {
    id: int('id').primaryKey().autoincrement(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex('idx_tags_slug').on(t.slug),
  }),
)

// post ⇄ category junction. Composite PK + a (category_id, post_id) index so
// the archive query (`WHERE category_id = ?`) is a covering index scan.
export const postCategories = mysqlTable(
  'post_categories',
  {
    postId: int('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    categoryId: int('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.postId, t.categoryId] }),
    categoryIdx: index('idx_pc_category').on(t.categoryId, t.postId),
  }),
)

// post ⇄ tag junction. Mirror of post_categories.
export const postTags = mysqlTable(
  'post_tags',
  {
    postId: int('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: int('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.postId, t.tagId] }),
    tagIdx: index('idx_pt_tag').on(t.tagId, t.postId),
  }),
)
