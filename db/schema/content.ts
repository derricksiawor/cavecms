import {
  mysqlTable,
  int,
  varchar,
  boolean,
  json,
  mysqlEnum,
  timestamp,
  index,
  uniqueIndex,
  type AnyMySqlColumn,
} from 'drizzle-orm/mysql-core'
import { sql } from 'drizzle-orm'
import { users } from './users'

// CMS pages. Free-form slugs (utf8mb4_bin), title-driven, soft-deletable,
// versioned for optimistic-lock, and previewable. Two STORED generated
// columns — `is_home_key` for the partial-unique-on-is_home=1 emulation
// and `url_path` for the canonical URL — are declared in the hand-rolled
// migration db/migrations/0010_pages_cms.sql (Drizzle 0.36 cannot
// round-trip GENERATED ALWAYS AS expressions reliably for is_home_key
// because TINYINT generated columns are awkward via .generatedAlwaysAs;
// url_path is declared here and asserted by the post-migrate gate).
//
// IMPORTANT: `utf8mb4_bin` is set in the hand-rolled migration step 1.
// Drizzle 0.36 does not expose per-column collation on varchar; if a
// future `pnpm db:generate` emits a MODIFY on this column WITHOUT the
// COLLATE clause, it will silently regress to the table-default
// collation. The post-migrate asserts re-check this on every deploy.
export const pages = mysqlTable(
  'pages',
  {
    id: int('id').primaryKey().autoincrement(),
    slug: varchar('slug', { length: 140 }).notNull(),
    title: varchar('title', { length: 220 }).notNull(),
    // is_home decouples the homepage URL from the slug. Only ONE row
    // may have is_home=TRUE (enforced by partial unique index emulated
    // via the `is_home_key` generated column declared in the migration).
    // `/` queries WHERE is_home=TRUE; the slug stays free for SEO.
    isHome: boolean('is_home').notNull().default(false),
    // System rows (the seeded home/about/services/contact). Their
    // slugs cannot be renamed (refused by PATCH). DELETE on a system
    // row succeeds but creates an audit row with action='delete' +
    // diff.system=true and the row is soft-deleted like any other.
    system: boolean('system').notNull().default(false),
    // Discriminator: 'page' (normal — routable, listed, sitemapped) vs
    // 'post_body' (hidden block tree owned by a post via posts.body_page_id).
    // Every page-surfacing query filters kind='page' (spec §4.4). Defaults to
    // 'page' so all existing rows + behavior are unchanged.
    kind: varchar('kind', { length: 20 }).notNull().default('page'),
    published: boolean('published').notNull().default(false),
    publishedAt: timestamp('published_at', { fsp: 3 }),
    deletedAt: timestamp('deleted_at', { fsp: 3 }),
    seoTitle: varchar('seo_title', { length: 180 }),
    seoDescription: varchar('seo_description', { length: 320 }),
    ogImageId: int('og_image_id'),
    // ─── SEO suite (migration 0034) ───
    // Real columns for the bulk-queried signals; seo_meta JSON for the
    // render-only override bag. See db/migrations/0034_seo_fields.sql.
    focusKeyphrase: varchar('focus_keyphrase', { length: 160 }),
    robotsNoindex: boolean('robots_noindex').notNull().default(false),
    robotsNofollow: boolean('robots_nofollow').notNull().default(false),
    canonicalUrl: varchar('canonical_url', { length: 500 }),
    cornerstone: boolean('cornerstone').notNull().default(false),
    seoScore: int('seo_score'),
    readabilityScore: int('readability_score'),
    seoMeta: json('seo_meta'),
    heroImageId: int('hero_image_id'),
    // Per-page header-mode override (migration 0042). NULL = inherit —
    // the site_header.headerMode default plus the first-section surface
    // auto-resolve decide; 'solid' | 'overlay' forces the mode here.
    headerMode: varchar('header_mode', { length: 10 }),
    // Preview-token revocation token (mirrors projects.preview_epoch).
    // Bumped on every unpublish / slug rename / soft-delete / is_home
    // change so any leaked preview URL invalidates instantly.
    previewEpoch: int('preview_epoch').notNull().default(0),
    version: int('version').notNull().default(0),
    // Draft → Publish (migration 0028). version = published optimistic-lock token;
    // the draft layer is tracked separately so draft autosaves never collide with
    // the published version axis (which is what makes undo version-conflict-free).
    //   hasDraft       — page has ≥1 block with draft_state != 'live'
    //   draftVersion   — advances per draft autosave; advisory concurrency guard
    //   draftUpdatedAt / draftUpdatedBy — last draft autosave audit
    hasDraft: boolean('has_draft').notNull().default(false),
    draftVersion: int('draft_version').notNull().default(0),
    // Undo/redo cursor — seq of the current draft state in page_draft_revisions
    // (migration 0029). canUndo = a revision with seq < cursor exists.
    draftUndoCursor: int('draft_undo_cursor').notNull().default(0),
    draftUpdatedAt: timestamp('draft_updated_at', { fsp: 3 }),
    draftUpdatedBy: int('draft_updated_by'),
    // Advisory edit lock (migration 0045) — which operator currently holds
    // the inline editor for this page, renewed by heartbeat while editing.
    // A heartbeat past the TTL means the lock is silently claimable. UI-level
    // only: block-write APIs stay lock-agnostic so API tokens + agents keep
    // editing headlessly.
    editLockUserId: int('edit_lock_user_id'),
    editLockHeartbeatAt: timestamp('edit_lock_heartbeat_at', { fsp: 3 }),
    updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
    // url_path — STORED GENERATED column.
    // Value: '/' when is_home=1, '/{slug}' otherwise. Single canonical
    // URL pathway for sitemap, JSON-LD canonical, admin-list display, and
    // redirect-target resolution. NEVER used for the public render
    // lookup (still by slug). Drizzle 0.36.4 omits this column from
    // INSERT/UPDATE codegen because of the .generatedAlwaysAs marker.
    //
    // MariaDB does NOT permit NOT NULL on a STORED generated column
    // (unlike MySQL 5.7+ — see migration 0010 step 5b comment). The
    // expression is deterministic so at runtime urlPath is always a
    // string, but the TS column type must allow null for the Drizzle
    // snapshot to round-trip cleanly through `pnpm db:generate`.
    // Application code consuming `page.urlPath` can assert non-null via
    // `page.urlPath!` or via a narrowing helper.
    urlPath: varchar('url_path', { length: 142 })
      .generatedAlwaysAs(
        sql`IF(is_home = 1, '/', CONCAT('/', slug))`,
        { mode: 'stored' },
      ),
  },
  (t) => ({
    slugIdx: uniqueIndex('idx_pages_slug').on(t.slug),
    // Public render: WHERE slug=:slug AND deleted_at IS NULL AND is_home=0.
    publishedIdx: index('idx_pages_published').on(t.published, t.publishedAt),
    // Admin trash: WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC.
    deletedUpdatedIdx: index('idx_pages_deleted_updated').on(t.deletedAt, t.updatedAt),
    // Lets the "list normal pages" hot path skip hidden post-body pages.
    kindIdx: index('idx_pages_kind').on(t.kind),
    // Sitemap: WHERE published = 1 [AND noindex...] ORDER BY is_home DESC,
    // updated_at DESC. Serves the home-first/recency ordering from the
    // index instead of a filesort over the whole published set.
    sitemapIdx: index('idx_pages_sitemap').on(t.published, t.isHome, t.updatedAt),
  }),
)

// Every editable region is a row. Typed FKs (image_id, og_image_id) are
// peers of typed blocks; freeform blocks store media via media_id inside
// the `data` JSON (sanitized + Zod-parsed at the parse boundary, indexed
// in reverse by media_references).
//
// block_key is NULL for freeform blocks the editor adds; non-null for the
// fixed page-template slots whose existence the renderer guarantees. The
// unique index uses MySQL's "NULLs are distinct" semantics — many NULL
// keys per page coexist, but two fixed-key duplicates collide at insert.
//
// page_id carries an ON DELETE CASCADE FK to pages.id so the cron-purge
// hard-delete sweep removes blocks atomically with their parent page.
// media_references rows for those blocks become orphans which the weekly
// verify-media-refs reconciler sweeps within 7 days.
export const contentBlocks = mysqlTable(
  'content_blocks',
  {
    id: int('id').primaryKey().autoincrement(),
    pageId: int('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    // Migration 0011: section/column hierarchy. parent_id is the
    // self-FK forming the 2-level tree:
    //   section (parent_id NULL, kind='section')
    //     column (parent_id=section.id, kind='column')
    //       widget (parent_id=column.id, kind='widget')
    // Legacy rows (created before 0011) are kind='widget' parent_id=NULL
    // and continue to render as top-level loose widgets.
    parentId: int('parent_id').references(
      (): AnyMySqlColumn => contentBlocks.id,
      { onDelete: 'cascade' },
    ),
    // Discriminates section / column container blocks from widget
    // leaves. Default 'widget' for back-compat with existing rows.
    kind: mysqlEnum('kind', ['section', 'column', 'widget'])
      .notNull()
      .default('widget'),
    blockKey: varchar('block_key', { length: 50 }),
    blockType: varchar('block_type', { length: 50 }).notNull(),
    position: int('position').notNull(),
    data: json('data').notNull(),
    // Per-kind container metadata (section background tone / padding /
    // columns count; column width). null for widgets — widgets carry
    // their layout config in `data`.
    meta: json('meta'),
    version: int('version').notNull().default(0),
    // Draft → Publish overlay (migration 0028). data/meta/position/parent_id
    // above are the PUBLISHED values the public reads; the draft_* mirrors hold
    // pending edits, materialised into the live columns on Publish.
    //   draftState='live'     → draft_* ignored (no pending change)
    //   draftState='modified' → draft_* hold the edit
    //   draftState='added'    → block exists in draft only (public excludes)
    //   draftState='removed'  → block deleted in draft only (public keeps)
    // draftParentId is app-validated (no self-FK): a draft move may target an
    // 'added' block that has no stable published parent yet.
    draftData: json('draft_data'),
    draftMeta: json('draft_meta'),
    draftPosition: int('draft_position'),
    draftParentId: int('draft_parent_id'),
    draftState: mysqlEnum('draft_state', ['live', 'modified', 'added', 'removed'])
      .notNull()
      .default('live'),
    deletedAt: timestamp('deleted_at', { fsp: 3 }),
    updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
    // Migration 0014: per-page htmlId uniqueness. Generated stored
    // column derived from meta.$.htmlId; soft-deleted rows resolve to
    // NULL so a restore (or a fresh create after a sibling's soft-
    // delete) can re-use the htmlId without engaging the constraint.
    // Read-only at the application layer — drizzle never SETs it
    // explicitly; MariaDB recomputes on every INSERT/UPDATE.
    htmlIdLive: varchar('html_id_live', { length: 64 }),
  },
  (t) => ({
    pagePosIdx: index('idx_blocks_page').on(t.pageId, t.position),
    deletedIdx: index('idx_blocks_deleted').on(t.deletedAt),
    pageKeyIdx: uniqueIndex('idx_blocks_page_key').on(t.pageId, t.blockKey),
    // Migration 0011 — per-parent tree-walk in position order.
    parentPosIdx: index('idx_content_blocks_parent_position').on(
      t.parentId,
      t.position,
    ),
    // Migration 0014 — authoritative per-page htmlId uniqueness gate.
    htmlIdLiveIdx: uniqueIndex('uniq_content_blocks_page_html_id_live').on(
      t.pageId,
      t.htmlIdLive,
    ),
    // Migration 0028 — fast scan of a page's pending draft rows (publish /
    // discard / "N unsaved changes" count).
    draftStateIdx: index('idx_blocks_draft_state').on(t.pageId, t.draftState),
  }),
)
