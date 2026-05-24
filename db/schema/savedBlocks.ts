import {
  mysqlTable,
  int,
  varchar,
  mysqlEnum,
  json,
  timestamp,
  index,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// Per-user "Saved blocks / My library" — operators right-click any
// widget and choose "Save as block" to add it to their library, then
// re-insert from the WidgetPicker's Saved tab. See migration
// db/migrations/0013_saved_blocks.sql for the column-by-column rationale.
//
// V1 stores widgets only — sections + columns are a future tier.
// `data` is the sanitized + Zod-validated widget payload; `meta` is
// the WidgetMetaSchema payload with htmlId stripped (htmlId is per-
// page-unique). Both re-validated at instantiate time so a saved row
// that pre-dates a post-deploy schema tightening fails closed at the
// paste boundary rather than committing currently-invalid data.
export const savedBlocks = mysqlTable(
  'saved_blocks',
  {
    id: int('id').primaryKey().autoincrement(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    kind: mysqlEnum('kind', ['widget']).notNull().default('widget'),
    blockType: varchar('block_type', { length: 50 }).notNull(),
    data: json('data').notNull(),
    meta: json('meta'),
    preview: varchar('preview', { length: 255 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => ({
    // Panel-load roundtrip: WHERE user_id=? ORDER BY created_at DESC.
    userCreatedIdx: index('idx_saved_blocks_user_created').on(
      t.userId,
      t.createdAt,
    ),
  }),
)
