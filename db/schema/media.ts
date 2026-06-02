import {
  mysqlTable,
  int,
  varchar,
  json,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// Source-of-truth row for any uploaded file. variants stays NULL between the
// initial INSERT and the post-rename UPDATE — the renderer treats NULL as
// "still processing" (and the parse boundary guards against blocks pointing
// at half-uploaded rows). Hard-delete only happens via the nightly purge
// after deleted_at > 30d AND zero media_references rows remain.
export const media = mysqlTable(
  'media',
  {
    id: int('id').primaryKey().autoincrement(),
    filenameUuid: varchar('filename_uuid', { length: 40 }).notNull(),
    originalName: varchar('original_name', { length: 255 }),
    mimeType: varchar('mime_type', { length: 80 }).notNull(),
    altText: varchar('alt_text', { length: 320 }).notNull(),
    width: int('width'),
    height: int('height'),
    byteSize: int('byte_size').notNull(),
    // sha256 (hex) of the ORIGINAL uploaded bytes. Discriminates content so the
    // sync dedup never collapses two different files that happen to share
    // (name, bytes, dims, mime). NULL for rows uploaded before this column
    // existed (those fall back to the metadata tuple — the prior behaviour).
    contentHash: varchar('content_hash', { length: 64 }),
    variants: json('variants'),
    uploadedBy: int('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    filenameIdx: uniqueIndex('idx_media_filename').on(t.filenameUuid),
    deletedIdx: index('idx_media_deleted').on(t.deletedAt),
    // Content-sync media dedup probe (byte_size first — most selective for `=`).
    dedupIdx: index('idx_media_dedup').on(t.byteSize, t.originalName),
  }),
)

// Reverse index. Every save flow diffs old vs new collectMediaPaths() output
// and INSERTs/DELETEs rows here so DELETE /api/cms/media/[id] can refuse in
// O(1) when any reference still points at the row. Field stores the JSON
// path (e.g. "image" or "gallery[3].image") so the verifier cron can
// reconstruct intent and the audit log can name what changed.
//
// Composite PK matches the natural-uniqueness invariant: a single media id
// referenced by the same field of the same referent row is one fact.
export const mediaReferences = mysqlTable(
  'media_references',
  {
    mediaId: int('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    referentType: varchar('referent_type', {
      length: 24,
      enum: [
        'content_block',
        'project_section',
        'project',
        'post',
        'team_member',
        'page',
        'settings',
      ],
    }).notNull(),
    referentId: int('referent_id').notNull(),
    // Widened from 200→512 to absorb deeply-nested JSON paths a future
    // block schema may synthesize (e.g. sections[N].subsections[M].image).
    // A truncated field path would cause INSERT to fail with "Data too
    // long" mid-TX, surfacing as a confusing 500.
    field: varchar('field', { length: 512 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.mediaId, t.referentType, t.referentId, t.field],
    }),
    // The cutover bulk-deletes/re-derives refs by (referent_type, referent_id);
    // the PK leads with media_id, so this secondary index serves those scans.
    referentIdx: index('idx_mref_referent').on(t.referentType, t.referentId),
  }),
)
