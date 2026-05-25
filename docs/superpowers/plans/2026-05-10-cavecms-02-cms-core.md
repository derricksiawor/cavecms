# CaveCMS Plan 02 — CMS Core (Blocks + Media)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the content-blocks data model + Zod-typed save flow with optimistic locking, the atomic image-upload pipeline, the `media_references` reverse-index, the audit log, and the `revalidateTag` taxonomy. After this plan, an Admin can POST a JSON block update and the public page re-renders.

**Architecture:** Each editable region is a row in `content_blocks` (typed by `block_type`). `data` JSON is validated by Zod on every read AND write (the only mutation path). Saves run in a single TX: SELECT FOR UPDATE → version check → UPDATE → upsert `media_references` → INSERT `audit_log` → COMMIT → `revalidateTag`. Media uploads write the DB row first (variants=NULL), then atomically rename files in, then UPDATE the variants — crash-safe.

**Tech Stack:** Same as Plan 01 + `sharp`, `microdiff`, `isomorphic-dompurify`, `file-type`.

**Prerequisites:** Plan 01 complete.

---

### Task 1: Schema — content tables

**Files:**
- Create: `db/schema/content.ts`, `db/schema/media.ts`, `db/schema/audit.ts`, `db/schema/notifications.ts`
- Modify: `db/schema/index.ts`

- [ ] **Step 1: `db/schema/content.ts`**

```ts
import { mysqlTable, int, varchar, json, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const pages = mysqlTable('pages', {
  id: int('id').primaryKey().autoincrement(),
  slug: varchar('slug', { length: 50, enum: ['home','about','services','contact'] }).notNull(),
  seoTitle: varchar('seo_title', { length: 180 }),
  seoDescription: varchar('seo_description', { length: 320 }),
  ogImageId: int('og_image_id'),
  version: int('version').notNull().default(0),
  updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
}, (t) => ({ slugIdx: uniqueIndex('idx_pages_slug').on(t.slug) }))

export const contentBlocks = mysqlTable('content_blocks', {
  id: int('id').primaryKey().autoincrement(),
  pageId: int('page_id').notNull(),
  blockKey: varchar('block_key', { length: 50 }),
  blockType: varchar('block_type', { length: 50 }).notNull(),
  position: int('position').notNull(),
  data: json('data').notNull(),
  version: int('version').notNull().default(0),
  deletedAt: timestamp('deleted_at', { fsp: 3 }),
  updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  pagePosIdx: index('idx_blocks_page').on(t.pageId, t.position),
  deletedIdx: index('idx_blocks_deleted').on(t.deletedAt),
  pageKeyIdx: uniqueIndex('idx_blocks_page_key').on(t.pageId, t.blockKey),   // partial via NULLs distinct
}))
```

- [ ] **Step 2: `db/schema/media.ts`**

```ts
import { mysqlTable, int, varchar, json, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const media = mysqlTable('media', {
  id: int('id').primaryKey().autoincrement(),
  filenameUuid: varchar('filename_uuid', { length: 40 }).notNull(),
  originalName: varchar('original_name', { length: 255 }),
  mimeType: varchar('mime_type', { length: 80 }).notNull(),
  altText: varchar('alt_text', { length: 320 }).notNull(),
  width: int('width'), height: int('height'),
  byteSize: int('byte_size').notNull(),
  variants: json('variants'),                                  // null until variants written
  uploadedBy: int('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  deletedAt: timestamp('deleted_at', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({
  filenameIdx: uniqueIndex('idx_media_filename').on(t.filenameUuid),
  deletedIdx: index('idx_media_deleted').on(t.deletedAt),
}))

export const mediaReferences = mysqlTable('media_references', {
  mediaId: int('media_id').notNull().references(() => media.id, { onDelete: 'cascade' }),
  referentType: varchar('referent_type', { length: 24, enum: ['content_block','project_section','project','post','team_member','page','settings'] }).notNull(),
  referentId: int('referent_id').notNull(),
  field: varchar('field', { length: 200 }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.mediaId, t.referentType, t.referentId, t.field] }) }))
```

- [ ] **Step 3: `db/schema/audit.ts`**

```ts
import { mysqlTable, bigint, int, varchar, json, timestamp, index } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const auditLog = mysqlTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  userId: int('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 40 }).notNull(),
  resourceType: varchar('resource_type', { length: 40 }).notNull(),
  resourceId: varchar('resource_id', { length: 60 }),
  diff: json('diff'),
  ip: varchar('ip', { length: 45 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index('idx_audit_created').on(t.createdAt),
  userIdx: index('idx_audit_user_created').on(t.userId, t.createdAt),
  resourceIdx: index('idx_audit_resource').on(t.resourceType, t.resourceId, t.createdAt),
  actionIdx: index('idx_audit_action').on(t.action, t.createdAt),
}))
```

- [ ] **Step 4: `db/schema/notifications.ts`**

```ts
import { mysqlTable, int, varchar, text, json, timestamp, index, mediumtext } from 'drizzle-orm/mysql-core'

export const notificationFailures = mysqlTable('notification_failures', {
  id: int('id').primaryKey().autoincrement(),
  kind: varchar('kind', { length: 32, enum: ['smtp_send','recaptcha_degraded','revalidate_failed','unhandled_rejection','rbac_field_reject'] }).notNull(),
  refTable: varchar('ref_table', { length: 40 }),
  refId: int('ref_id'),
  payload: json('payload'),
  attempts: int('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextRetryAt: timestamp('next_retry_at', { fsp: 3 }),
  resolvedAt: timestamp('resolved_at', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({ dueIdx: index('idx_notif_kind_pending').on(t.kind, t.resolvedAt, t.nextRetryAt) }))

export const schemaFingerprint = mysqlTable('schema_fingerprint', {
  id: int('id').primaryKey(),                       // single-row table (id=1)
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  appliedAt: timestamp('applied_at', { fsp: 3 }).notNull().defaultNow(),
})
```

- [ ] **Step 5: re-export from `db/schema/index.ts`**

```ts
export * from './users'
export * from './auth'
export * from './content'
export * from './media'
export * from './audit'
export * from './notifications'
```

- [ ] **Step 6: generate migration + commit**

```bash
pnpm drizzle-kit generate && git add db && git commit -m "feat(db): CMS + media + audit + notification schemas"
```

---

### Task 2: Block type registry (Zod schemas)

**Files:**
- Create: `lib/cms/block-registry.ts`, `tests/unit/block-registry.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { parseBlockData, blockSchemas } from '@/lib/cms/block-registry'

describe('block registry', () => {
  it('parses a hero block', () => {
    const parsed = parseBlockData('hero', {
      title: 'Building Homes…', subtitle: 'Lux', image: { media_id: 1, alt: 'hero' },
      cta: { text: 'Brochure', href: '/contact', openInNew: false },
    })
    expect(parsed.title).toBe('Building Homes…')
  })
  it('rejects unknown block_type', () => {
    expect(() => parseBlockData('mystery', {})).toThrow()
  })
})
```

- [ ] **Step 2: implement `lib/cms/block-registry.ts`**

```ts
import 'server-only'
import { z } from 'zod'

const MediaRef = z.object({ media_id: z.number().int().positive(), alt: z.string().max(320) })
const Cta = z.object({
  text: z.string().min(1).max(80),
  href: z.string().min(1).max(500),
  openInNew: z.boolean().default(false),
})

export const blockSchemas = {
  hero: z.object({
    title: z.string().min(1).max(220),
    subtitle: z.string().max(320).optional(),
    image: MediaRef,
    cta: Cta.optional(),
  }),
  services_intro: z.object({
    title: z.string().min(1).max(220),
    body_richtext: z.string().max(4000),
    items: z.array(z.object({ icon: z.string().max(60).optional(), title: z.string().max(120), body: z.string().max(500) })).max(12),
  }),
  featured_projects: z.object({
    title: z.string().max(220).optional(),
    project_ids: z.array(z.number().int().positive()).max(12),
    layout: z.enum(['grid','carousel']).default('grid'),
  }),
  about_history: z.object({
    title: z.string().max(220),
    body_richtext: z.string().max(8000),
    image: MediaRef.optional(),
  }),
  team_block: z.object({
    title: z.string().max(220).optional(),
    member_ids: z.array(z.number().int().positive()).max(50).optional(),
    all: z.boolean().default(false),
  }),
  cta: z.object({ title: z.string().max(220), body: z.string().max(800).optional(), cta: Cta }),
  text: z.object({ heading: z.string().max(220).optional(), body_richtext: z.string().max(8000) }),
  image: z.object({ image: MediaRef, caption: z.string().max(320).optional(), alignment: z.enum(['left','center','right']).default('center') }),
  gallery: z.object({
    images: z.array(MediaRef.extend({ caption: z.string().max(320).optional() })).min(1).max(48),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  }),
  quote: z.object({ quote: z.string().max(800), attribution: z.string().max(120).optional(), attribution_title: z.string().max(120).optional() }),
} as const

export type BlockType = keyof typeof blockSchemas
export type BlockData<T extends BlockType = BlockType> = z.infer<typeof blockSchemas[T]>

export function parseBlockData(type: string, data: unknown): BlockData {
  const schema = (blockSchemas as Record<string, z.ZodTypeAny>)[type]
  if (!schema) throw new Error(`unknown_block_type:${type}`)
  return schema.parse(data) as BlockData
}

export const FIXED_BLOCK_KEYS_PER_PAGE: Record<string, BlockType[]> = {
  home: ['hero','featured_projects','services_intro','cta'],
  about: ['hero','about_history','team_block'],
  services: ['hero','services_intro'],
  contact: ['hero'],
}
```

- [ ] **Step 3: run + commit**

```bash
git add lib/cms/block-registry.ts tests/unit/block-registry.test.ts && git commit -m "feat(cms): block-type registry with Zod schemas"
```

---

### Task 3: Rich-text sanitizer

**Files:**
- Create: `lib/cms/sanitize.ts`, `tests/unit/sanitize.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { sanitizeRichText } from '@/lib/cms/sanitize'

describe('sanitizeRichText', () => {
  it('keeps allowed tags + adds noopener', () => {
    const html = sanitizeRichText('<p><a href="https://example.com">x</a></p>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('target="_blank"')
  })
  it('strips javascript: hrefs', () => {
    const html = sanitizeRichText('<p><a href="javascript:alert(1)">x</a></p>')
    expect(html).not.toContain('javascript:')
  })
  it('strips disallowed tags', () => {
    const html = sanitizeRichText('<script>bad</script><p>ok</p>')
    expect(html).not.toContain('script')
  })
})
```

- [ ] **Step 2: implement**

```ts
import 'server-only'
import DOMPurify from 'isomorphic-dompurify'

const CONFIG = {
  ALLOWED_TAGS: ['p','br','strong','em','a','ul','ol','li'],
  ALLOWED_ATTR: ['href','rel','target'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer nofollow')
    node.setAttribute('target', '_blank')
  }
})

export function sanitizeRichText(html: string): string {
  return String(DOMPurify.sanitize(html, CONFIG))
}
```

- [ ] **Step 3: commit**

```bash
git add lib/cms/sanitize.ts tests/unit/sanitize.test.ts && git commit -m "feat(cms): DOMPurify rich-text sanitizer with URI allow-list"
```

---

### Task 4: Parse boundary — read/write helpers

**Files:**
- Create: `lib/cms/parse.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { blockSchemas, parseBlockData, type BlockType } from './block-registry'
import { sanitizeRichText } from './sanitize'

const RICHTEXT_FIELDS = new Set(['body_richtext','quote'])

function walkAndSanitize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(walkAndSanitize)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = RICHTEXT_FIELDS.has(k) && typeof v === 'string' ? sanitizeRichText(v) : walkAndSanitize(v)
  }
  return out
}

export function parseAndSanitize(type: string, raw: unknown) {
  const sanitized = walkAndSanitize(raw)
  return parseBlockData(type, sanitized)
}

export function parseForRead(type: string, raw: unknown) {
  // On read, re-parse + re-sanitize as defense-in-depth against DB tampering / restores
  return parseAndSanitize(type, raw)
}
```

- [ ] **Step 2: commit**

```bash
git add lib/cms/parse.ts && git commit -m "feat(cms): read/write parse boundary with sanitization"
```

---

### Task 5: Cache tag taxonomy

**Files:**
- Create: `lib/cache/tags.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'

export const tag = {
  page:    (slug: string) => `page:${slug}`,
  project: (slug: string) => `project:${slug}`,
  post:    (slug: string) => `post:${slug}`,
  projectsIndex:    'projects-index',
  featuredProjects: 'featured-projects',
  postsIndex:       'posts-index',
  team:             'team',
  settings:         'settings',
  sitemap:          'sitemap',
  robots:           'robots',
} as const

export interface TagSet { tags: string[] }

export function tagsForBlockSave(pageSlug: string): TagSet {
  return { tags: [tag.page(pageSlug)] }
}

export function tagsForProjectSave(slug: string, opts: { publishedChanged?: boolean; slugChanged?: boolean; featuredChanged?: boolean; coreChanged?: boolean }): TagSet {
  const t = new Set<string>([tag.project(slug)])
  if (opts.publishedChanged || opts.slugChanged) t.add(tag.sitemap)
  if (opts.publishedChanged || opts.slugChanged || opts.coreChanged) t.add(tag.projectsIndex)
  if (opts.publishedChanged || opts.featuredChanged || opts.slugChanged || opts.coreChanged) t.add(tag.featuredProjects)
  return { tags: [...t] }
}

export function tagsForPostSave(slug: string, opts: { publishedChanged?: boolean; slugChanged?: boolean }): TagSet {
  const t = new Set<string>([tag.post(slug)])
  if (opts.publishedChanged || opts.slugChanged) { t.add(tag.sitemap); t.add(tag.postsIndex) }
  return { tags: [...t] }
}
```

- [ ] **Step 2: commit**

```bash
git add lib/cache/tags.ts && git commit -m "feat(cache): central tag taxonomy"
```

---

### Task 6: revalidate runner with retry

**Files:**
- Create: `lib/cache/revalidate.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { revalidateTag } from 'next/cache'
import { db } from '@/db/client'
import { notificationFailures } from '@/db/schema'

export async function safeRevalidate(tags: string[]): Promise<void> {
  await Promise.allSettled(tags.map(async (t) => {
    try { revalidateTag(t) }
    catch (err) {
      await db.insert(notificationFailures).values({
        kind: 'revalidate_failed', payload: { tag: t, error: String(err) },
        nextRetryAt: new Date(Date.now() + 30_000),
      }).catch(() => {})    // never throw from revalidate
    }
  }))
}
```

- [ ] **Step 2: commit**

---

### Task 7: media_references diff helpers

**Files:**
- Create: `lib/cms/mediaRefs.ts`, `tests/unit/mediaRefs.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'

describe('collectMediaPaths', () => {
  it('finds media_id at top + array nesting', () => {
    const out = collectMediaPaths({
      image: { media_id: 7, alt: 'a' },
      gallery: [{ media_id: 8, alt: 'g0' }, { media_id: 9, alt: 'g1' }],
    })
    expect(out).toEqual([
      { mediaId: 7, field: 'image' },
      { mediaId: 8, field: 'gallery[0]' },
      { mediaId: 9, field: 'gallery[1]' },
    ])
  })
})
```

- [ ] **Step 2: implement**

```ts
import 'server-only'
export interface MediaRefPath { mediaId: number; field: string }

export function collectMediaPaths(value: unknown, prefix = ''): MediaRefPath[] {
  const out: MediaRefPath[] = []
  walk(value, prefix, out)
  return out
}
function walk(v: unknown, path: string, out: MediaRefPath[]): void {
  if (v == null || typeof v !== 'object') return
  if (Array.isArray(v)) {
    v.forEach((item, i) => walk(item, `${path}[${i}]`, out))
    return
  }
  const obj = v as Record<string, unknown>
  if (typeof obj.media_id === 'number') out.push({ mediaId: obj.media_id, field: path || 'media_id' })
  for (const [k, val] of Object.entries(obj)) walk(val, path ? `${path}.${k}` : k, out)
}
```

- [ ] **Step 3: commit**

```bash
git add lib/cms/mediaRefs.ts tests/unit/mediaRefs.test.ts && git commit -m "feat(cms): collectMediaPaths walker"
```

---

### Task 8: Save flow — PATCH block

**Files:**
- Create: `lib/cms/saveBlock.ts`, `app/api/cms/blocks/[id]/route.ts`, `tests/integration/saveBlock.test.ts`

- [ ] **Step 1: write `lib/cms/saveBlock.ts`**

```ts
import 'server-only'
import { db } from '@/db/client'
import { contentBlocks, pages, mediaReferences, auditLog } from '@/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { parseAndSanitize } from './parse'
import { collectMediaPaths } from './mediaRefs'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import diff from 'microdiff'

const SENSITIVE_FIELDS = new Set<string>([])     // none on content_blocks

export class StaleVersionError extends Error { constructor() { super('stale_version') } }
export class NotFoundError extends Error { constructor() { super('not_found') } }

export async function saveBlock(args: {
  blockId: number; userId: number; ip: string | null
  expectedVersion: number; data: unknown
}): Promise<{ version: number }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute(sql`SELECT * FROM content_blocks WHERE id = ${args.blockId} AND deleted_at IS NULL FOR UPDATE`) as unknown as Array<{ id: number; page_id: number; block_type: string; data: unknown; version: number }>
    if (!row) throw new NotFoundError()
    if (row.version !== args.expectedVersion) throw new StaleVersionError()
    const parsed = parseAndSanitize(row.block_type, args.data)

    // Update row
    const newVersion = row.version + 1
    await tx.execute(sql`UPDATE content_blocks SET data=${JSON.stringify(parsed)}, version=${newVersion}, updated_by=${args.userId} WHERE id = ${args.blockId}`)

    // Media references diff
    const oldRefs = collectMediaPaths(row.data)
    const newRefs = collectMediaPaths(parsed)
    const oldSet = new Set(oldRefs.map(r => `${r.mediaId}::${r.field}`))
    const newSet = new Set(newRefs.map(r => `${r.mediaId}::${r.field}`))
    for (const r of oldRefs) {
      if (!newSet.has(`${r.mediaId}::${r.field}`)) {
        await tx.execute(sql`DELETE FROM media_references WHERE media_id=${r.mediaId} AND referent_type='content_block' AND referent_id=${args.blockId} AND field=${r.field}`)
      }
    }
    for (const r of newRefs) {
      if (!oldSet.has(`${r.mediaId}::${r.field}`)) {
        await tx.execute(sql`INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field) VALUES (${r.mediaId}, 'content_block', ${args.blockId}, ${r.field})`)
      }
    }

    // Audit log
    const patch = diff(row.data as object, parsed as object)
    await tx.insert(auditLog).values({
      userId: args.userId, action: 'update',
      resourceType: 'content_block', resourceId: String(args.blockId),
      diff: patch, ip: args.ip,
    })

    // Cache invalidation outside TX
    const [page] = await tx.execute(sql`SELECT slug FROM pages WHERE id = ${row.page_id}`) as unknown as Array<{ slug: string }>
    queueMicrotask(() => safeRevalidate(tagsForBlockSave(page.slug).tags))
    return { version: newVersion }
  })
}
```

- [ ] **Step 2: write `app/api/cms/blocks/[id]/route.ts`**

```ts
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/db/client'
import { saveBlock, StaleVersionError, NotFoundError } from '@/lib/cms/saveBlock'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { cookies } from 'next/headers'

const PatchBody = z.object({ expectedVersion: z.number().int().nonnegative(), data: z.unknown() })

export const PATCH = withError(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin','editor'])
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  const csrfCookie = c.get('__Host-cavecms_csrf')?.value ?? ''
  if (csrfHeader !== csrfCookie || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const body = PatchBody.parse(await req.json())
  try {
    const { version } = await saveBlock({
      blockId: Number(id), userId: ctx.userId, ip: req.headers.get('x-real-ip'),
      expectedVersion: body.expectedVersion, data: body.data,
    })
    return new Response(JSON.stringify({ version }), { status: 200, headers: { 'content-type': 'application/json' } })
  } catch (e) {
    if (e instanceof StaleVersionError) throw new HttpError(409, 'stale_version')
    if (e instanceof NotFoundError)     throw new HttpError(404, 'not_found')
    throw e
  }
})
```

- [ ] **Step 3: integration test**

```ts
// tests/integration/saveBlock.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { saveBlock, StaleVersionError } from '@/lib/cms/saveBlock'

describe('saveBlock', () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE content_blocks`)
    await db.execute(sql`TRUNCATE TABLE pages`)
    await db.execute(sql`TRUNCATE TABLE media_references`)
    await db.execute(sql`TRUNCATE TABLE audit_log`)
    await db.execute(sql`INSERT INTO pages (id, slug, version) VALUES (1, 'home', 0)`)
    await db.execute(sql`INSERT INTO content_blocks (id, page_id, block_key, block_type, position, data, version) VALUES (1, 1, 'hero', 'hero', 1000, ${JSON.stringify({ title: 'A', image: { media_id: 1, alt: 'a' } })}, 5)`)
  })
  it('saves with correct version', async () => {
    const { version } = await saveBlock({
      blockId: 1, userId: 1, ip: '127.0.0.1', expectedVersion: 5,
      data: { title: 'B', image: { media_id: 2, alt: 'b' } },
    })
    expect(version).toBe(6)
  })
  it('throws StaleVersionError on mismatch', async () => {
    await expect(saveBlock({
      blockId: 1, userId: 1, ip: null, expectedVersion: 99,
      data: { title: 'C', image: { media_id: 1, alt: 'a' } },
    })).rejects.toBeInstanceOf(StaleVersionError)
  })
})
```

- [ ] **Step 4: commit**

```bash
git add lib/cms/saveBlock.ts app/api/cms/blocks/\[id\]/route.ts tests/integration/saveBlock.test.ts \
  && git commit -m "feat(cms): PATCH /api/cms/blocks/[id] with optimistic lock + audit + cache"
```

---

### Task 9: Create / delete / restore freeform blocks

**Files:**
- Create: `app/api/cms/blocks/route.ts` (POST create)
- Create: `app/api/cms/blocks/[id]/restore/route.ts` (POST restore)
- Modify: `app/api/cms/blocks/[id]/route.ts` (add DELETE)

- [ ] **Step 1: POST create**

```ts
import { z } from 'zod'
import { db } from '@/db/client'
import { contentBlocks } from '@/db/schema'
import { sql } from 'drizzle-orm'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { cookies } from 'next/headers'
import { parseAndSanitize } from '@/lib/cms/parse'
import { blockSchemas } from '@/lib/cms/block-registry'

const Body = z.object({
  pageId: z.number().int().positive(),
  blockType: z.string().refine(t => t in blockSchemas, 'unknown_block_type'),
  data: z.unknown(),
})

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin','editor'])
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  if (csrfHeader !== c.get('__Host-cavecms_csrf')?.value || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const body = Body.parse(await req.json())
  const parsed = parseAndSanitize(body.blockType, body.data)
  const [{ maxPos }] = await db.execute(sql`SELECT COALESCE(MAX(position), 0) AS maxPos FROM content_blocks WHERE page_id=${body.pageId} AND deleted_at IS NULL`) as unknown as Array<{ maxPos: number }>
  const [{ insertId }] = await db.execute(sql`INSERT INTO content_blocks (page_id, block_type, position, data, version, updated_by) VALUES (${body.pageId}, ${body.blockType}, ${maxPos + 1000}, ${JSON.stringify(parsed)}, 0, ${ctx.userId})`) as unknown as Array<{ insertId: number }>
  return new Response(JSON.stringify({ id: insertId, version: 0 }), { status: 201, headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 2: DELETE — soft delete, fixed blocks rejected**

Add to `app/api/cms/blocks/[id]/route.ts`:

```ts
export const DELETE = withError(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin','editor'])
  // CSRF check (same as PATCH)
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  if (csrfHeader !== c.get('__Host-cavecms_csrf')?.value || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) throw new HttpError(403, 'csrf_invalid')
  const [row] = await db.execute(sql`SELECT block_key, page_id FROM content_blocks WHERE id=${Number(id)} AND deleted_at IS NULL`) as unknown as Array<{ block_key: string | null; page_id: number }>
  if (!row) throw new HttpError(404, 'not_found')
  if (row.block_key !== null) throw new HttpError(409, 'cannot_delete_fixed_block')
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE content_blocks SET deleted_at = NOW(3) WHERE id = ${Number(id)}`)
    await tx.execute(sql`DELETE FROM media_references WHERE referent_type='content_block' AND referent_id=${Number(id)}`)
    await tx.insert(auditLog).values({ userId: ctx.userId, action: 'delete', resourceType: 'content_block', resourceId: String(id), ip: req.headers.get('x-real-ip') })
  })
  return new Response(null, { status: 204 })
})
```

(Adjust imports at top of the file accordingly.)

- [ ] **Step 3: POST restore**

```ts
// app/api/cms/blocks/[id]/restore/route.ts
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { cookies } from 'next/headers'

export const POST = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin','editor'])
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  if (csrfHeader !== c.get('__Host-cavecms_csrf')?.value || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) throw new HttpError(403, 'csrf_invalid')
  await db.execute(sql`UPDATE content_blocks SET deleted_at = NULL, position = COALESCE((SELECT mx FROM (SELECT MAX(position)+1000 AS mx FROM content_blocks WHERE page_id = (SELECT page_id FROM content_blocks WHERE id=${Number(id)}) AND deleted_at IS NULL) AS t), 1000) WHERE id = ${Number(id)}`)
  return new Response(JSON.stringify({ restored: true }), { status: 200 })
})
```

- [ ] **Step 4: commit**

```bash
git add app/api/cms/blocks && git commit -m "feat(cms): create/delete/restore freeform blocks"
```

---

### Task 10: Reorder endpoint

**Files:**
- Create: `app/api/cms/blocks/reorder/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { cookies } from 'next/headers'

const Body = z.object({
  pageId: z.number().int().positive(),
  blocks: z.array(z.object({ id: z.number().int().positive(), expectedVersion: z.number().int().nonnegative() })).min(1).max(200),
})

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin','editor'])
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  if (csrfHeader !== c.get('__Host-cavecms_csrf')?.value || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) throw new HttpError(403, 'csrf_invalid')
  const body = Body.parse(await req.json())
  return await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT id, version FROM content_blocks WHERE page_id=${body.pageId} AND deleted_at IS NULL FOR UPDATE`) as unknown as Array<{ id: number; version: number }>
    const livingIds = new Set(rows.map(r => r.id))
    const submittedIds = new Set(body.blocks.map(b => b.id))
    if (livingIds.size !== submittedIds.size) throw new HttpError(409, 'drift')
    for (const id of submittedIds) if (!livingIds.has(id)) throw new HttpError(409, 'drift')
    const byId = new Map(rows.map(r => [r.id, r]))
    for (const b of body.blocks) {
      const cur = byId.get(b.id)!
      if (cur.version !== b.expectedVersion) throw new HttpError(409, 'stale_version')
    }
    let pos = 1000
    const result: Array<{ id: number; version: number }> = []
    for (const b of body.blocks) {
      await tx.execute(sql`UPDATE content_blocks SET position=${pos}, version=version+1, updated_by=${ctx.userId} WHERE id=${b.id}`)
      result.push({ id: b.id, version: b.expectedVersion + 1 })
      pos += 1000
    }
    return new Response(JSON.stringify({ blocks: result }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/cms/blocks/reorder && git commit -m "feat(cms): POST /api/cms/blocks/reorder with drift detection + per-row version"
```

---

### Task 11: Media upload — atomic pipeline

**Files:**
- Create: `lib/media/storage.ts`, `lib/media/sharp.ts`, `app/api/cms/media/route.ts`

- [ ] **Step 1: `lib/media/storage.ts`**

```ts
import 'server-only'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const UPLOADS_ROOT = process.env.UPLOADS_ROOT ?? '/opt/cavecms/uploads'

export const PATHS = {
  tmp: path.join(UPLOADS_ROOT, '.tmp'),
  originals: path.join(UPLOADS_ROOT, 'originals'),
  variants: path.join(UPLOADS_ROOT, 'variants'),
  brochures: path.join(UPLOADS_ROOT, 'brochures-private'),
}

export async function assertSameFs(): Promise<void> {
  if (process.env.NODE_ENV === 'development') return
  const dirs = Object.values(PATHS)
  const stats = await Promise.all(dirs.map(d => stat(d)))
  for (let i = 1; i < stats.length; i++) {
    if (stats[i].dev !== stats[0].dev) throw new Error('uploads_fs_misconfig')
  }
}

export async function tmpDirFor(uuid: string): Promise<string> {
  const dir = path.join(PATHS.tmp, uuid)
  await mkdir(dir, { recursive: true, mode: 0o750 })
  return dir
}

export async function writeFinal(srcPath: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true, mode: 0o750 })
  await rename(srcPath, destPath)
}

export async function cleanupTmp(uuid: string): Promise<void> {
  await rm(path.join(PATHS.tmp, uuid), { recursive: true, force: true })
}
```

- [ ] **Step 2: `lib/media/sharp.ts`**

```ts
import 'server-only'
import sharp from 'sharp'

sharp.cache({ memory: 100 })
sharp.concurrency(2)

const WIDTHS = { thumb: 320, md: 768, lg: 1600 } as const

export async function processImage(buf: Buffer, tmpDir: string, uuid: string): Promise<{
  width: number; height: number;
  variants: { thumb: string; md: string; lg: string; og: string };
}> {
  const meta = await sharp(buf, { limitInputPixels: 24_000_000 }).rotate().metadata()
  if (!meta.width || !meta.height) throw new Error('bad_image')
  const pipe = sharp(buf, { limitInputPixels: 24_000_000 }).rotate().withMetadata({ exif: {} as never })
  const outDir = (kind: string) => `${tmpDir}/${kind}.webp`
  for (const [name, w] of Object.entries(WIDTHS)) {
    await pipe.clone().resize({ width: w, withoutEnlargement: true }).webp({ quality: 82 }).toFile(outDir(name))
  }
  const ogPath = `${tmpDir}/og.jpg`
  await pipe.clone().resize({ width: 1200, height: 630, fit: 'cover' }).jpeg({ quality: 86 }).toFile(ogPath)
  return {
    width: meta.width, height: meta.height,
    variants: {
      thumb: `/uploads/variants/${uuid}-thumb.webp`,
      md:    `/uploads/variants/${uuid}-md.webp`,
      lg:    `/uploads/variants/${uuid}-lg.webp`,
      og:    `/uploads/variants/${uuid}-og.jpg`,
    },
  }
}
```

- [ ] **Step 3: route**

```ts
// app/api/cms/media/route.ts
import { randomUUID } from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'
import { db } from '@/db/client'
import { media } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { cookies } from 'next/headers'
import { PATHS, assertSameFs, cleanupTmp, tmpDirFor, writeFinal } from '@/lib/media/storage'
import { processImage } from '@/lib/media/sharp'
import { env } from '@/lib/env'
import { eq, sql } from 'drizzle-orm'

const MAX_IMAGE = 10 * 1024 * 1024, MAX_PDF = 25 * 1024 * 1024
const ALLOWED_IMG = new Set(['image/jpeg','image/png','image/webp','image/avif'])

// crude in-process semaphore = 1
let busy = false

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin','editor'])
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  if (csrfHeader !== c.get('__Host-cavecms_csrf')?.value || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) throw new HttpError(403, 'csrf_invalid')
  if (busy) return new Response(JSON.stringify({ error: 'busy' }), { status: 429, headers: { 'retry-after': '5' } })
  busy = true
  try {
    await assertSameFs()
    const form = await req.formData()
    const file = form.get('file')
    const altText = String(form.get('alt') ?? '').slice(0, 320)
    if (!altText) throw new HttpError(400, 'alt_required')
    if (!(file instanceof File)) throw new HttpError(400, 'file_required')
    const buf = Buffer.from(await file.arrayBuffer())
    const sniff = await fileTypeFromBuffer(buf)
    if (!sniff) throw new HttpError(400, 'mime_unknown')
    const isPdf = sniff.mime === 'application/pdf'
    if (!isPdf && !ALLOWED_IMG.has(sniff.mime)) throw new HttpError(400, 'mime_rejected')
    if ((isPdf && buf.byteLength > MAX_PDF) || (!isPdf && buf.byteLength > MAX_IMAGE)) throw new HttpError(413, 'too_large')

    const uuid = randomUUID()
    const tmpDir = await tmpDirFor(uuid)

    // Insert media row first (variants null)
    const [{ insertId }] = await db.execute(sql`INSERT INTO media (filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, uploaded_by) VALUES (${uuid}, ${file.name ?? null}, ${sniff.mime}, ${altText}, ${null}, ${null}, ${buf.byteLength}, ${ctx.userId})`) as unknown as Array<{ insertId: number }>

    if (isPdf) {
      const dest = `${PATHS.brochures}/${uuid}.pdf`
      await import('node:fs/promises').then(fs => fs.writeFile(`${tmpDir}/upload.pdf`, buf))
      await writeFinal(`${tmpDir}/upload.pdf`, dest)
      await db.execute(sql`UPDATE media SET variants=${JSON.stringify({ pdf: `/api/brochure/by-uuid/${uuid}` })} WHERE id=${insertId}`)
    } else {
      const { width, height, variants } = await processImage(buf, tmpDir, uuid)
      // Move originals + variants
      await import('node:fs/promises').then(async fs => {
        await fs.writeFile(`${tmpDir}/original`, buf)
        await writeFinal(`${tmpDir}/original`, `${PATHS.originals}/${uuid}`)
        for (const v of ['thumb','md','lg'] as const) await writeFinal(`${tmpDir}/${v}.webp`, `${PATHS.variants}/${uuid}-${v}.webp`)
        await writeFinal(`${tmpDir}/og.jpg`, `${PATHS.variants}/${uuid}-og.jpg`)
      })
      await db.execute(sql`UPDATE media SET width=${width}, height=${height}, variants=${JSON.stringify(variants)} WHERE id=${insertId}`)
    }

    await cleanupTmp(uuid)
    return new Response(JSON.stringify({ id: insertId, uuid }), { status: 201, headers: { 'content-type': 'application/json' } })
  } finally { busy = false }
})
```

- [ ] **Step 4: commit**

```bash
git add lib/media app/api/cms/media/route.ts && git commit -m "feat(media): atomic upload pipeline (DB-first + temp+rename)"
```

---

### Task 12: Hydrate (two-phase) — TDD

**Files:**
- Create: `lib/cms/hydrate.ts`, `tests/integration/hydrate.test.ts`

- [ ] **Step 1: integration test**

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { hydratePage } from '@/lib/cms/hydrate'

beforeAll(async () => {
  await db.execute(sql`TRUNCATE TABLE content_blocks`)
  await db.execute(sql`TRUNCATE TABLE pages`)
  await db.execute(sql`TRUNCATE TABLE media`)
  await db.execute(sql`INSERT INTO pages (id, slug, version) VALUES (1, 'home', 0)`)
  await db.execute(sql`INSERT INTO media (id, filename_uuid, mime_type, alt_text, byte_size, variants) VALUES (1, 'u1', 'image/webp', 'a', 1, ${JSON.stringify({ md: '/uploads/variants/u1-md.webp' })})`)
  await db.execute(sql`INSERT INTO content_blocks (id, page_id, block_key, block_type, position, data, version) VALUES (1, 1, 'hero', 'hero', 1000, ${JSON.stringify({ title: 'A', image: { media_id: 1, alt: 'a' } })}, 0)`)
})

describe('hydratePage', () => {
  it('returns blocks with resolved media', async () => {
    const out = await hydratePage(1)
    expect(out.blocks).toHaveLength(1)
    expect(out.media.get(1)?.variants).toMatchObject({ md: expect.stringContaining('-md.webp') })
  })
})
```

- [ ] **Step 2: implement**

```ts
import 'server-only'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { parseForRead } from './parse'
import { collectMediaPaths } from './mediaRefs'

export async function hydratePage(pageId: number) {
  const blocks = (await db.execute(sql`SELECT id, block_key, block_type, position, data, version FROM content_blocks WHERE page_id=${pageId} AND deleted_at IS NULL ORDER BY position`)) as unknown as Array<{ id: number; block_key: string | null; block_type: string; position: number; data: unknown; version: number }>

  // Phase 1
  const mediaIds = new Set<number>()
  const projectIds = new Set<number>()
  const teamIds = new Set<number>()
  const parsed = blocks.map(b => {
    const d = parseForRead(b.block_type, b.data)
    collectMediaPaths(d).forEach(p => mediaIds.add(p.mediaId))
    if (typeof d === 'object' && d) {
      const dd = d as Record<string, unknown>
      const arr = dd.project_ids
      if (Array.isArray(arr)) arr.forEach((id: unknown) => typeof id === 'number' && projectIds.add(id))
      const tm = dd.member_ids
      if (Array.isArray(tm)) tm.forEach((id: unknown) => typeof id === 'number' && teamIds.add(id))
    }
    return { ...b, data: d }
  })

  // Phase 2
  const projects = projectIds.size
    ? (await db.execute(sql`SELECT id, slug, name, tagline, hero_image_id, og_image_id, status FROM projects WHERE id IN (${[...projectIds]}) AND published=TRUE AND deleted_at IS NULL`)) as unknown as Array<{ id: number; slug: string; name: string; tagline: string; hero_image_id: number | null; og_image_id: number | null }>
    : []
  for (const p of projects) { if (p.hero_image_id) mediaIds.add(p.hero_image_id); if (p.og_image_id) mediaIds.add(p.og_image_id) }
  const team = teamIds.size
    ? (await db.execute(sql`SELECT id, name, role, photo_id FROM team_members WHERE id IN (${[...teamIds]}) AND published=TRUE`)) as unknown as Array<{ id: number; name: string; role: string; photo_id: number | null }>
    : []
  for (const t of team) if (t.photo_id) mediaIds.add(t.photo_id)

  // Phase 3
  const mediaRows = mediaIds.size
    ? (await db.execute(sql`SELECT id, alt_text, variants FROM media WHERE id IN (${[...mediaIds]})`)) as unknown as Array<{ id: number; alt_text: string; variants: unknown }>
    : []
  const media = new Map(mediaRows.map(r => [r.id, r]))
  return { blocks: parsed, projects: new Map(projects.map(p => [p.id, p])), team: new Map(team.map(t => [t.id, t])), media }
}
```

- [ ] **Step 3: commit**

```bash
git add lib/cms/hydrate.ts tests/integration/hydrate.test.ts && git commit -m "feat(cms): two-phase page hydration"
```

---

### Task 13: Reject media soft-delete with refs

**Files:**
- Create: `app/api/cms/media/[id]/route.ts`

```ts
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { cookies } from 'next/headers'

export const DELETE = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin'])
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  if (csrfHeader !== c.get('__Host-cavecms_csrf')?.value || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) throw new HttpError(403, 'csrf_invalid')
  return db.transaction(async (tx) => {
    const refs = await tx.execute(sql`SELECT 1 FROM media_references WHERE media_id=${Number(id)} LIMIT 1 FOR UPDATE`) as unknown as Array<unknown>
    if (refs.length > 0) throw new HttpError(409, 'still_referenced')
    await tx.execute(sql`UPDATE media SET deleted_at = NOW(3) WHERE id = ${Number(id)} AND deleted_at IS NULL`)
    return new Response(null, { status: 204 })
  })
})
```

Commit:

```bash
git add app/api/cms/media/\[id\]/route.ts && git commit -m "feat(media): admin soft-delete rejects when referenced"
```

---

### Task 14: GET /api/cms/media — list

```ts
// app/api/cms/media/route.ts (add GET alongside POST)
export const GET = withError(async (req) => {
  const ctx = await requireRole(['admin','editor'])
  const url = new URL(req.url)
  const cursor = url.searchParams.get('cursor')
  const limit = Math.min(50, Number(url.searchParams.get('limit') ?? 30))
  const rows = await db.execute(sql`
    SELECT id, filename_uuid, mime_type, alt_text, width, height, byte_size, variants, created_at
    FROM media WHERE deleted_at IS NULL ${cursor ? sql`AND id < ${Number(cursor)}` : sql``}
    ORDER BY id DESC LIMIT ${limit}
  `) as unknown as Array<Record<string, unknown>>
  return new Response(JSON.stringify({ items: rows }), { status: 200, headers: { 'content-type': 'application/json' } })
})
```

Commit:

```bash
git add app/api/cms/media/route.ts && git commit -m "feat(media): GET /api/cms/media list with cursor pagination"
```

---

### Task 15: Definition of done

- [ ] `pnpm test` — all unit + integration tests pass.
- [ ] Manual: POST a block update with a stale `expectedVersion` → 409.
- [ ] Manual: upload a JPG → 4 variants appear under `/opt/cavecms/uploads/variants/`; `media.variants` JSON populated.
- [ ] Manual: trying to delete a referenced media row → 409.
- [ ] Manual: trying to delete a fixed-key block (e.g. hero) → 409.
- [ ] Commit: `git commit --allow-empty -m "chore: Plan 02 complete — CMS Core"`.

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-10-cavecms-02-cms-core.md`. Pick subagent-driven or inline execution. After Plan 02 green, proceed to Plan 03 (Inline Edit UX).
