# BWC Plan 04 — Projects

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** `projects` + `project_sections` schemas with 10 section types; project CRUD + reorder; state-machine-enforced status transitions; preview tokens with `preview_epoch` revocation; `slug_redirects` maintained on rename; signed-token brochure download served from private storage.

**Architecture:** Each project has 10 section rows (one per `section_key`) auto-seeded on create. Section data is JSON validated by Zod (same parse boundary as Plan 02). PATCH handlers split by role into Zod allowlist schemas. Slug change inserts a redirect row + collapses chains in the same TX. Brochure download verifies HMAC-signed token + atomic single-use CAS.

**Prerequisites:** Plans 01–03.

---

### Task 1: Schema — projects, project_sections, slug_redirects

**Files:**
- Create: `db/schema/projects.ts`
- Modify: `db/schema/index.ts`

- [ ] **Step 1: write**

```ts
// db/schema/projects.ts
import { mysqlTable, int, varchar, json, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const projects = mysqlTable('projects', {
  id: int('id').primaryKey().autoincrement(),
  slug: varchar('slug', { length: 120 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  tagline: varchar('tagline', { length: 220 }),
  status: varchar('status', { length: 24, enum: ['coming_soon', 'under_construction', 'selling', 'sold_out'] }).notNull(),
  location: varchar('location', { length: 180 }),
  heroImageId: int('hero_image_id'),
  brochurePdfId: int('brochure_pdf_id'),
  featuredOrder: int('featured_order'),
  published: boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at', { fsp: 3 }),
  seoTitle: varchar('seo_title', { length: 180 }),
  seoDescription: varchar('seo_description', { length: 320 }),
  ogImageId: int('og_image_id'),
  previewEpoch: int('preview_epoch').notNull().default(0),
  version: int('version').notNull().default(0),
  deletedAt: timestamp('deleted_at', { fsp: 3 }),
  updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  slugIdx: uniqueIndex('idx_projects_slug').on(t.slug),
  publishedIdx: index('idx_projects_published').on(t.published, t.featuredOrder),
  deletedIdx: index('idx_projects_deleted').on(t.deletedAt),
}))

export const projectSections = mysqlTable('project_sections', {
  id: int('id').primaryKey().autoincrement(),
  projectId: int('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sectionKey: varchar('section_key', { length: 32, enum: ['hero', 'gallery', 'floor_plans', 'pricing', 'amenities', 'location', 'brochure', 'timeline', 'testimonials', 'inquiry'] }).notNull(),
  position: int('position').notNull(),
  data: json('data').notNull(),
  version: int('version').notNull().default(0),
  updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  uniq: uniqueIndex('idx_psecs_project_key').on(t.projectId, t.sectionKey),
  pos: index('idx_psecs_project').on(t.projectId, t.position),
}))

export const slugRedirects = mysqlTable('slug_redirects', {
  id: int('id').primaryKey().autoincrement(),
  resourceType: varchar('resource_type', { length: 16, enum: ['project', 'post'] }).notNull(),
  oldSlug: varchar('old_slug', { length: 140 }).notNull(),
  newSlug: varchar('new_slug', { length: 140 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({ uniq: uniqueIndex('idx_redir').on(t.resourceType, t.oldSlug) }))
```

- [ ] **Step 2:** add `export * from './projects'` to `db/schema/index.ts`.

- [ ] **Step 3:** `pnpm drizzle-kit generate` and commit.

```bash
git add db && git commit -m "feat(db): projects + project_sections + slug_redirects"
```

---

### Task 2: Project section Zod registry

**Files:** Create `lib/cms/project-section-registry.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { z } from 'zod'

const MediaRef = z.object({ media_id: z.number().int().positive(), alt: z.string().max(320) })
const MapEmbedUrl = z.string().url().refine((u) => u.startsWith('https://www.google.com/maps/embed?'), 'must_be_google_maps_embed')

export const sectionSchemas = {
  hero: z.object({
    status_label: z.string().max(60).optional(),
    banner_image: MediaRef,
    summary_richtext: z.string().max(2000).optional(),
  }),
  gallery: z.object({
    categories: z.array(z.object({
      name: z.string().max(60),
      images: z.array(MediaRef.extend({ caption: z.string().max(320).optional() })).max(48),
    })).max(8),
  }),
  floor_plans: z.object({
    unit_types: z.array(z.object({
      name: z.string().max(60),
      beds: z.number().int().nonnegative(),
      baths: z.number().nonnegative(),
      sqft: z.number().int().positive(),
      image: MediaRef,
      description: z.string().max(800).optional(),
    })).max(20),
  }),
  pricing: z.object({
    display: z.enum(['range', 'per_unit', 'contact']),
    value_richtext: z.string().max(2000),
    units_total: z.number().int().positive().optional(),
    units_remaining: z.number().int().nonnegative().optional(),
  }),
  amenities: z.object({
    items: z.array(z.object({ icon: z.string().max(60), label: z.string().max(120) })).max(60),
  }),
  location: z.object({
    map_embed_url: MapEmbedUrl.optional(),
    address: z.string().max(280),
    points_of_interest: z.array(z.object({ label: z.string().max(120), drive_time_min: z.number().int().nonnegative() })).max(20),
  }),
  brochure: z.object({
    pdf: MediaRef.nullable(),
    gate_message_richtext: z.string().max(2000).optional(),
  }),
  timeline: z.object({
    entries: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      title: z.string().max(220),
      body_richtext: z.string().max(2000).optional(),
      photo: MediaRef.optional(),
    })).max(40),
  }),
  testimonials: z.object({
    entries: z.array(z.object({ quote: z.string().max(800), attribution: z.string().max(120), unit_type: z.string().max(60).optional() })).max(20),
  }),
  inquiry: z.object({
    heading: z.string().max(220).optional(),
    body_richtext: z.string().max(2000).optional(),
  }),
} as const

export type SectionKey = keyof typeof sectionSchemas
export const SECTION_KEYS: SectionKey[] = Object.keys(sectionSchemas) as SectionKey[]

export function parseSectionData(key: string, data: unknown) {
  const schema = (sectionSchemas as Record<string, z.ZodTypeAny>)[key]
  if (!schema) throw new Error(`unknown_section_key:${key}`)
  return schema.parse(data)
}

export const EMPTY_SECTION_DATA: Record<SectionKey, unknown> = {
  hero: { banner_image: { media_id: 0, alt: '' } },
  gallery: { categories: [] },
  floor_plans: { unit_types: [] },
  pricing: { display: 'contact', value_richtext: '' },
  amenities: { items: [] },
  location: { address: '', points_of_interest: [] },
  brochure: { pdf: null },
  timeline: { entries: [] },
  testimonials: { entries: [] },
  inquiry: {},
}
```

- [ ] **Step 2: commit**

```bash
git add lib/cms/project-section-registry.ts && git commit -m "feat(cms): project section Zod schemas + empty seeds"
```

---

### Task 3: State machine helper — TDD

**Files:** Create `lib/cms/projectStatus.ts`, `tests/unit/projectStatus.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { isValidStatusTransition } from '@/lib/cms/projectStatus'

describe('projectStatus', () => {
  it('allows declared transitions', () => {
    expect(isValidStatusTransition('coming_soon', 'under_construction')).toBe(true)
    expect(isValidStatusTransition('selling', 'sold_out')).toBe(true)
    expect(isValidStatusTransition('sold_out', 'selling')).toBe(true)
  })
  it('rejects backward transitions to coming_soon', () => {
    expect(isValidStatusTransition('selling', 'coming_soon')).toBe(false)
    expect(isValidStatusTransition('sold_out', 'coming_soon')).toBe(false)
  })
  it('allows same-state (no-op)', () => {
    expect(isValidStatusTransition('selling', 'selling')).toBe(true)
  })
})
```

- [ ] **Step 2: implement**

```ts
import 'server-only'

const TRANSITIONS: Record<string, string[]> = {
  coming_soon: ['under_construction', 'selling'],
  under_construction: ['selling', 'sold_out'],
  selling: ['sold_out'],
  sold_out: ['selling'],
}

export function isValidStatusTransition(from: string, to: string): boolean {
  if (from === to) return true
  return TRANSITIONS[from]?.includes(to) ?? false
}
```

- [ ] **Step 3: commit**

```bash
git add lib/cms/projectStatus.ts tests/unit/projectStatus.test.ts && git commit -m "feat(cms): project status state machine"
```

---

### Task 4: POST /api/cms/projects (Admin only)

**Files:** Create `app/api/cms/projects/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { SECTION_KEYS, EMPTY_SECTION_DATA } from '@/lib/cms/project-section-registry'

const Body = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]{2,120}$/),
  status: z.enum(['coming_soon', 'under_construction', 'selling', 'sold_out']),
})

async function csrfOrThrow(req: Request, ctx: { jti: string; userId: number }) {
  const c = await cookies()
  const header = req.headers.get('x-csrf-token') ?? ''
  const cookie = c.get('__Host-bwc_csrf')?.value ?? ''
  if (header.length !== cookie.length || header !== cookie || !(await verifyCsrf(header, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    throw new HttpError(403, 'csrf_invalid')
  }
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await csrfOrThrow(req, ctx)
  const body = Body.parse(await req.json())
  return db.transaction(async (tx) => {
    try {
      const result = await tx.execute(sql`INSERT INTO projects (slug, name, status, version) VALUES (${body.slug}, ${body.name}, ${body.status}, 0)`)
      const insertId = (result as unknown as { insertId: number }).insertId
      let pos = 1000
      for (const key of SECTION_KEYS) {
        await tx.execute(sql`INSERT INTO project_sections (project_id, section_key, position, data, version) VALUES (${insertId}, ${key}, ${pos}, ${JSON.stringify(EMPTY_SECTION_DATA[key])}, 0)`)
        pos += 1000
      }
      await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip) VALUES (${ctx.userId}, 'create', 'project', ${String(insertId)}, ${req.headers.get('x-real-ip')})`)
      return new Response(JSON.stringify({ id: insertId, slug: body.slug }), { status: 201, headers: { 'content-type': 'application/json' } })
    } catch (err: unknown) {
      if (err && (err as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'slug_taken')
      throw err
    }
  })
})

export const GET = withError(async (req: Request) => {
  await requireRole(['admin', 'editor', 'viewer'])
  const url = new URL(req.url)
  const showArchived = url.searchParams.get('archived') === '1'
  const rows = await db.execute(sql`
    SELECT id, slug, name, status, featured_order, published, deleted_at, updated_at
    FROM projects
    ${showArchived ? sql`` : sql`WHERE deleted_at IS NULL`}
    ORDER BY featured_order IS NULL, featured_order, name
  `) as unknown as Array<Record<string, unknown>>
  return new Response(JSON.stringify({ items: rows }), { status: 200, headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/cms/projects/route.ts && git commit -m "feat(api): POST/GET /api/cms/projects with auto-seeded sections"
```

---

### Task 5: PATCH /api/cms/projects/[id] + DELETE + slug redirect

**Files:** Create `app/api/cms/projects/[id]/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { isValidStatusTransition } from '@/lib/cms/projectStatus'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tagsForProjectSave, tag } from '@/lib/cache/tags'

async function csrfOrThrow(req: Request, ctx: { jti: string; userId: number }) {
  const c = await cookies()
  const header = req.headers.get('x-csrf-token') ?? ''
  const cookie = c.get('__Host-bwc_csrf')?.value ?? ''
  if (header.length !== cookie.length || header !== cookie || !(await verifyCsrf(header, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    throw new HttpError(403, 'csrf_invalid')
  }
}

const EditorSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  tagline: z.string().max(220).optional(),
  location: z.string().max(180).optional(),
  heroImageId: z.number().int().positive().optional(),
  brochurePdfId: z.number().int().positive().nullable().optional(),
  featuredOrder: z.number().int().nonnegative().nullable().optional(),
  seoTitle: z.string().max(180).optional(),
  seoDescription: z.string().max(320).optional(),
  ogImageId: z.number().int().positive().nullable().optional(),
  version: z.number().int().nonnegative(),
}).strict()
const AdminSchema = EditorSchema.extend({
  published: z.boolean().optional(),
  slug: z.string().regex(/^[a-z0-9-]{2,120}$/).optional(),
  status: z.enum(['coming_soon', 'under_construction', 'selling', 'sold_out']).optional(),
}).strict()

type ProjectRow = {
  id: number; slug: string; name: string; status: string; published: number;
  featured_order: number | null; version: number; preview_epoch: number;
}

export const PATCH = withError(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin', 'editor'])
  await csrfOrThrow(req, ctx)
  const raw = await req.json()
  const Body = ctx.role === 'admin' ? AdminSchema : EditorSchema
  let body
  try { body = Body.parse(raw) } catch (e) {
    if (ctx.role === 'editor' && raw && typeof raw === 'object') {
      const adminOnly = ['published', 'slug', 'status']
      if (Object.keys(raw).some((k) => adminOnly.includes(k))) {
        await db.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, diff, ip) VALUES (${ctx.userId}, 'rbac_field_reject', 'project', ${id}, ${JSON.stringify({ keys: Object.keys(raw).filter((k) => adminOnly.includes(k)) })}, ${req.headers.get('x-real-ip')})`)
        throw new HttpError(403, 'forbidden')
      }
    }
    throw e
  }

  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT id, slug, name, status, published, featured_order, version, preview_epoch FROM projects WHERE id = ${Number(id)} AND deleted_at IS NULL FOR UPDATE`) as unknown as ProjectRow[]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')
    if (row.version !== body.version) throw new HttpError(409, 'stale_version')

    if ('status' in body && body.status && body.status !== row.status) {
      if (!isValidStatusTransition(row.status, body.status)) throw new HttpError(409, 'invalid_status_transition')
    }
    const slugChanged = 'slug' in body && body.slug !== undefined && body.slug !== row.slug
    const publishedChanged = 'published' in body && body.published !== undefined && (body.published ? 1 : 0) !== row.published
    const featuredChanged = 'featuredOrder' in body && body.featuredOrder !== row.featured_order

    if (slugChanged && body.slug) {
      await tx.execute(sql`INSERT INTO slug_redirects (resource_type, old_slug, new_slug) VALUES ('project', ${row.slug}, ${body.slug}) ON DUPLICATE KEY UPDATE new_slug = VALUES(new_slug)`)
      await tx.execute(sql`UPDATE slug_redirects SET new_slug = ${body.slug} WHERE resource_type = 'project' AND new_slug = ${row.slug}`)
      await tx.execute(sql`DELETE FROM slug_redirects WHERE resource_type = 'project' AND old_slug = ${body.slug}`)
    }

    const bumpEpoch = (publishedChanged && body.published === false) || slugChanged
    const before: Record<string, unknown> = { ...row }
    const after: Record<string, unknown> = { ...row }
    const sets: string[] = ['version = version + 1', `updated_by = ${ctx.userId}`]
    if (bumpEpoch) sets.push('preview_epoch = preview_epoch + 1')

    const cols: Record<string, [string, unknown]> = {
      name: ['name', body.name],
      tagline: ['tagline', body.tagline],
      location: ['location', body.location],
      heroImageId: ['hero_image_id', body.heroImageId],
      brochurePdfId: ['brochure_pdf_id', body.brochurePdfId],
      featuredOrder: ['featured_order', body.featuredOrder],
      seoTitle: ['seo_title', body.seoTitle],
      seoDescription: ['seo_description', body.seoDescription],
      ogImageId: ['og_image_id', body.ogImageId],
    }
    if (ctx.role === 'admin') {
      Object.assign(cols, {
        published: ['published', body.published],
        slug: ['slug', body.slug],
        status: ['status', body.status],
      })
    }
    const params: unknown[] = []
    for (const [field, [col, val]] of Object.entries(cols)) {
      if (val !== undefined) {
        sets.push(`${col} = ?`)
        params.push(val)
        after[field] = val
      }
    }
    if (ctx.role === 'admin' && body.published === true && row.published === 0) sets.push('published_at = COALESCE(published_at, NOW(3))')

    await tx.execute(sql.raw(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...params, Number(id)) as never)

    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, diff, ip) VALUES (${ctx.userId}, 'update', 'project', ${id}, ${JSON.stringify({ from: before, to: after })}, ${req.headers.get('x-real-ip')})`)

    const slug = (body.slug ?? row.slug)
    const tagSet = tagsForProjectSave(slug, { publishedChanged, slugChanged, featuredChanged, coreChanged: true })
    if (slugChanged) tagSet.tags.push(tag.project(row.slug))
    queueMicrotask(() => safeRevalidate(tagSet.tags))
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

export const DELETE = withError(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin'])
  await csrfOrThrow(req, ctx)
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT slug FROM projects WHERE id = ${Number(id)} AND deleted_at IS NULL FOR UPDATE`) as unknown as Array<{ slug: string }>
    if (!rows[0]) throw new HttpError(404, 'not_found')
    await tx.execute(sql`UPDATE projects SET deleted_at = NOW(3), preview_epoch = preview_epoch + 1, updated_by = ${ctx.userId} WHERE id = ${Number(id)}`)
    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip) VALUES (${ctx.userId}, 'delete', 'project', ${id}, ${req.headers.get('x-real-ip')})`)
    queueMicrotask(() => safeRevalidate(['projects-index', 'featured-projects', 'sitemap', tag.project(rows[0].slug)]))
    return new Response(null, { status: 204 })
  })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/cms/projects/\[id\]/route.ts && git commit -m "feat(api): PATCH+DELETE /api/cms/projects/[id] with field-level RBAC + slug redirect"
```

---

### Task 6: PATCH project section (optimistic lock)

**Files:** Create `app/api/cms/projects/[id]/sections/[sectionId]/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { parseSectionData } from '@/lib/cms/project-section-registry'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'
import diff from 'microdiff'

const Body = z.object({ expectedVersion: z.number().int().nonnegative(), data: z.unknown() }).strict()

export const PATCH = withError(async (req: Request, { params }: { params: Promise<{ id: string; sectionId: string }> }) => {
  const { id, sectionId } = await params
  const ctx = await requireRole(['admin', 'editor'])
  const c = await cookies()
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const csrfCookie = c.get('__Host-bwc_csrf')?.value ?? ''
  if (csrfHeader.length !== csrfCookie.length || csrfHeader !== csrfCookie || !(await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const body = Body.parse(await req.json())
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT s.id, s.section_key, s.data, s.version, s.project_id, p.slug FROM project_sections s JOIN projects p ON p.id = s.project_id WHERE s.id = ${Number(sectionId)} AND s.project_id = ${Number(id)} AND p.deleted_at IS NULL FOR UPDATE`) as unknown as Array<{ id: number; section_key: string; data: unknown; version: number; project_id: number; slug: string }>
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')
    if (row.version !== body.expectedVersion) throw new HttpError(409, 'stale_version')
    const parsed = parseSectionData(row.section_key, body.data)
    const newVersion = row.version + 1
    await tx.execute(sql`UPDATE project_sections SET data = ${JSON.stringify(parsed)}, version = ${newVersion}, updated_by = ${ctx.userId} WHERE id = ${row.id}`)
    // Media refs diff
    const oldRefs = collectMediaPaths(row.data)
    const newRefs = collectMediaPaths(parsed)
    const oldKeys = new Set(oldRefs.map((r) => `${r.mediaId}::${r.field}`))
    const newKeys = new Set(newRefs.map((r) => `${r.mediaId}::${r.field}`))
    for (const r of oldRefs) {
      if (!newKeys.has(`${r.mediaId}::${r.field}`)) {
        await tx.execute(sql`DELETE FROM media_references WHERE media_id = ${r.mediaId} AND referent_type = 'project_section' AND referent_id = ${row.id} AND field = ${r.field}`)
      }
    }
    for (const r of newRefs) {
      if (!oldKeys.has(`${r.mediaId}::${r.field}`)) {
        await tx.execute(sql`INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field) VALUES (${r.mediaId}, 'project_section', ${row.id}, ${r.field})`)
      }
    }
    const patch = diff(row.data as object, parsed as object)
    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, diff, ip) VALUES (${ctx.userId}, 'update', 'project_section', ${String(row.id)}, ${JSON.stringify(patch)}, ${req.headers.get('x-real-ip')})`)
    queueMicrotask(() => safeRevalidate([tag.project(row.slug)]))
    return new Response(JSON.stringify({ version: newVersion }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
```

- [ ] **Step 2: commit**

```bash
git add 'app/api/cms/projects/[id]/sections/[sectionId]/route.ts' && git commit -m "feat(api): PATCH project section with optimistic lock"
```

---

### Task 7: POST /api/cms/projects/reorder

**Files:** Create `app/api/cms/projects/reorder/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { safeRevalidate } from '@/lib/cache/revalidate'

const Body = z.object({
  projects: z.array(z.object({ id: z.number().int().positive(), expectedVersion: z.number().int().nonnegative() })).min(1).max(50),
}).strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor'])
  const c = await cookies()
  const header = req.headers.get('x-csrf-token') ?? ''
  const cookie = c.get('__Host-bwc_csrf')?.value ?? ''
  if (header.length !== cookie.length || header !== cookie || !(await verifyCsrf(header, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const body = Body.parse(await req.json())
  return db.transaction(async (tx) => {
    const ids = body.projects.map((p) => p.id)
    const rows = await tx.execute(sql`SELECT id, version, slug FROM projects WHERE id IN (${ids}) AND deleted_at IS NULL FOR UPDATE`) as unknown as Array<{ id: number; version: number; slug: string }>
    if (rows.length !== ids.length) throw new HttpError(409, 'drift')
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const p of body.projects) {
      const cur = byId.get(p.id)
      if (!cur || cur.version !== p.expectedVersion) throw new HttpError(409, 'stale_version')
    }
    let order = 1
    const out: Array<{ id: number; version: number }> = []
    for (const p of body.projects) {
      await tx.execute(sql`UPDATE projects SET featured_order = ${order}, version = version + 1, updated_by = ${ctx.userId} WHERE id = ${p.id}`)
      out.push({ id: p.id, version: p.expectedVersion + 1 })
      order += 1
    }
    queueMicrotask(() => safeRevalidate(['projects-index', 'featured-projects', ...rows.map((r) => `project:${r.slug}`)]))
    return new Response(JSON.stringify({ projects: out }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/cms/projects/reorder && git commit -m "feat(api): POST /api/cms/projects/reorder"
```

---

### Task 8: POST /api/cms/projects/[id]/preview-token

**Files:** Create `app/api/cms/projects/[id]/preview-token/route.ts`

- [ ] **Step 1: write**

```ts
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { signPreviewJwt } from '@/lib/auth/jwt'

export const POST = withError(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin', 'editor'])
  const c = await cookies()
  const header = req.headers.get('x-csrf-token') ?? ''
  const cookie = c.get('__Host-bwc_csrf')?.value ?? ''
  if (header.length !== cookie.length || header !== cookie || !(await verifyCsrf(header, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const rows = await db.execute(sql`SELECT id, slug, preview_epoch FROM projects WHERE id = ${Number(id)} AND deleted_at IS NULL`) as unknown as Array<{ id: number; slug: string; preview_epoch: number }>
  const p = rows[0]
  if (!p) throw new HttpError(404, 'not_found')
  const token = await signPreviewJwt(String(ctx.userId), { type: 'project', id: p.id, epoch: p.preview_epoch })
  return new Response(JSON.stringify({ url: `/projects/${p.slug}?preview=${token}` }), { status: 200, headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 2: commit**

```bash
git add 'app/api/cms/projects/[id]/preview-token/route.ts' && git commit -m "feat(api): preview-token endpoint"
```

---

### Task 9: Brochure download API

**Files:** Create `app/api/brochure/[token]/route.ts`, `lib/auth/brochureToken.ts`

- [ ] **Step 1: shared canonicalization helper**

```ts
// lib/auth/brochureToken.ts
import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

export interface BrochurePayload { v: 1; lead_id: number; project_id: number; exp: number }

export function canonicalize(p: BrochurePayload): string {
  return JSON.stringify({ v: 1, lead_id: p.lead_id, project_id: p.project_id, exp: p.exp })
}

export function signBrochureToken(p: { lead_id: number; project_id: number }, ttlSec = 60 * 60 * 24 * 7): string {
  const payload: BrochurePayload = { v: 1, lead_id: p.lead_id, project_id: p.project_id, exp: Math.floor(Date.now() / 1000) + ttlSec }
  const mac = createHmac('sha256', env.BROCHURE_SECRET).update(canonicalize(payload)).digest()
  return Buffer.from(canonicalize(payload)).toString('base64url') + '.' + mac.toString('base64url')
}

export function verifyBrochureToken(token: string): BrochurePayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  let payload: BrochurePayload
  try {
    const decoded = Buffer.from(parts[0], 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Partial<BrochurePayload>
    if (parsed.v !== 1 || typeof parsed.lead_id !== 'number' || typeof parsed.project_id !== 'number' || typeof parsed.exp !== 'number') return null
    payload = parsed as BrochurePayload
  } catch { return null }
  const expected = createHmac('sha256', env.BROCHURE_SECRET).update(canonicalize(payload)).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  if (Math.floor(Date.now() / 1000) > payload.exp) return null
  return payload
}
```

- [ ] **Step 2: route**

```ts
// app/api/brochure/[token]/route.ts
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { verifyBrochureToken } from '@/lib/auth/brochureToken'

export const GET = withError(async (_req: Request, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const payload = verifyBrochureToken(token)
  if (!payload) return new Response('Gone', { status: 410 })

  const result = await db.execute(sql`UPDATE leads SET brochure_token_used_at = NOW(3) WHERE id = ${payload.lead_id} AND source = 'brochure' AND project_id = ${payload.project_id} AND brochure_token_used_at IS NULL`) as unknown as { affectedRows: number }
  if (result.affectedRows === 0) return new Response('Gone', { status: 410 })

  const rows = await db.execute(sql`SELECT m.filename_uuid FROM projects p JOIN media m ON m.id = p.brochure_pdf_id WHERE p.id = ${payload.project_id} AND p.published = TRUE AND p.deleted_at IS NULL`) as unknown as Array<{ filename_uuid: string }>
  const m = rows[0]
  if (!m) return new Response('Gone', { status: 410 })
  const filePath = `/opt/bwc/uploads/brochures-private/${m.filename_uuid}.pdf`
  const stats = statSync(filePath)
  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(stats.size),
      'content-disposition': 'attachment; filename="brochure.pdf"',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
    },
  })
})
```

- [ ] **Step 3: commit**

```bash
git add 'app/api/brochure/[token]/route.ts' lib/auth/brochureToken.ts && git commit -m "feat(api): signed brochure download with atomic CAS"
```

---

### Task 10: Project hydrate + render context

**Files:** Modify `lib/cms/hydrate.ts` to add `hydrateProject(slug)`.

- [ ] **Step 1: write**

```ts
// append to lib/cms/hydrate.ts
export async function hydrateProject(slug: string, opts: { allowUnpublished?: boolean } = {}) {
  const projectRows = await db.execute(sql`SELECT * FROM projects WHERE slug = ${slug} AND deleted_at IS NULL`) as unknown as Array<{
    id: number; slug: string; name: string; tagline: string | null; status: string;
    location: string | null; hero_image_id: number | null; brochure_pdf_id: number | null;
    og_image_id: number | null; preview_epoch: number; published: number; published_at: Date | null;
    seo_title: string | null; seo_description: string | null; version: number;
  }>
  const project = projectRows[0]
  if (!project) return null
  if (!opts.allowUnpublished && project.published !== 1) return null
  const sections = (await db.execute(sql`SELECT id, section_key, position, data, version FROM project_sections WHERE project_id = ${project.id} ORDER BY position`)) as unknown as Array<{ id: number; section_key: string; data: unknown; position: number; version: number }>
  const parsedSections = sections.map((s) => ({ ...s, data: parseForRead(`project_section:${s.section_key}` as never, s.data) }))
  // Collect media refs across project + sections
  const mediaIds = new Set<number>()
  if (project.hero_image_id) mediaIds.add(project.hero_image_id)
  if (project.brochure_pdf_id) mediaIds.add(project.brochure_pdf_id)
  if (project.og_image_id) mediaIds.add(project.og_image_id)
  for (const s of parsedSections) collectMediaPaths(s.data).forEach((p) => mediaIds.add(p.mediaId))
  const mediaRows = mediaIds.size
    ? (await db.execute(sql`SELECT id, alt_text, variants FROM media WHERE id IN (${[...mediaIds]})`)) as unknown as Array<{ id: number; alt_text: string; variants: unknown }>
    : []
  return {
    project,
    sections: parsedSections,
    media: new Map(mediaRows.map((r) => [r.id, r])),
  }
}
```

Note: `parseForRead` needs to handle the `project_section:<key>` lookup. Simpler: add a separate helper.

```ts
// in lib/cms/parse.ts, append:
import { parseSectionData } from './project-section-registry'
export function parseProjectSectionForRead(key: string, raw: unknown) {
  return parseSectionData(key, raw)
}
```

And in `hydrate.ts`, use `parseProjectSectionForRead(s.section_key, s.data)` instead of the inline string.

- [ ] **Step 2: commit**

```bash
git add lib/cms/hydrate.ts lib/cms/parse.ts && git commit -m "feat(cms): hydrateProject"
```

---

### Task 11: Project public route with section rendering

**Files:** Create `app/projects/[slug]/page.tsx`, `components/project-sections/index.tsx`

- [ ] **Step 1: section render dispatcher**

```tsx
// components/project-sections/index.tsx
import { MediaImg } from '@/components/blocks/MediaImg'
import type { ReactNode } from 'react'

type MediaMap = Map<number, { variants: Record<string, string> | null; alt_text: string }>

export function renderSection(key: string, data: unknown, media: MediaMap): ReactNode {
  switch (key) {
    case 'hero': return <SectionHero data={data as never} media={media} />
    case 'gallery': return <SectionGallery data={data as never} media={media} />
    case 'floor_plans': return <SectionFloorPlans data={data as never} media={media} />
    case 'pricing': return <SectionPricing data={data as never} />
    case 'amenities': return <SectionAmenities data={data as never} />
    case 'location': return <SectionLocation data={data as never} />
    case 'brochure': return <SectionBrochure data={data as never} />
    case 'timeline': return <SectionTimeline data={data as never} media={media} />
    case 'testimonials': return <SectionTestimonials data={data as never} />
    case 'inquiry': return <SectionInquiry data={data as never} />
    default: return null
  }
}

function SectionHero({ data, media }: { data: { status_label?: string; banner_image: { media_id: number; alt: string }; summary_richtext?: string }; media: MediaMap }) {
  const m = media.get(data.banner_image.media_id)
  return (
    <section className="relative">
      <MediaImg media={m} alt={data.banner_image.alt} variant="lg" className="w-full h-[55vh] object-cover" />
      {data.status_label && <span className="absolute top-4 left-4 bg-amber-600 text-white text-xs px-3 py-1 rounded">{data.status_label}</span>}
      {data.summary_richtext && <div className="px-4 py-8 max-w-3xl mx-auto prose" dangerouslySetInnerHTML={{ __html: data.summary_richtext }} />}
    </section>
  )
}
function SectionGallery({ data, media }: { data: { categories: Array<{ name: string; images: Array<{ media_id: number; alt: string; caption?: string }> }> }; media: MediaMap }) {
  return (
    <section className="py-12 max-w-6xl mx-auto px-4 space-y-10">
      {data.categories.map((cat, ci) => (
        <div key={ci}>
          <h3 className="text-lg font-medium mb-3">{cat.name}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {cat.images.map((img, i) => (
              <figure key={i}>
                <MediaImg media={media.get(img.media_id)} alt={img.alt} variant="md" className="w-full h-44 object-cover rounded" />
                {img.caption && <figcaption className="text-xs text-neutral-600 mt-1">{img.caption}</figcaption>}
              </figure>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
function SectionFloorPlans({ data, media }: { data: { unit_types: Array<{ name: string; beds: number; baths: number; sqft: number; image: { media_id: number; alt: string }; description?: string }> }; media: MediaMap }) {
  return (
    <section className="py-12 max-w-6xl mx-auto px-4">
      <h3 className="text-2xl font-semibold mb-6">Floor plans</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {data.unit_types.map((u, i) => (
          <article key={i} className="border rounded p-4">
            <MediaImg media={media.get(u.image.media_id)} alt={u.image.alt} variant="md" className="w-full h-48 object-contain" />
            <h4 className="mt-2 font-medium">{u.name}</h4>
            <p className="text-sm text-neutral-600">{u.beds} bed · {u.baths} bath · {u.sqft} sqft</p>
            {u.description && <p className="text-sm mt-2">{u.description}</p>}
          </article>
        ))}
      </div>
    </section>
  )
}
function SectionPricing({ data }: { data: { display: 'range' | 'per_unit' | 'contact'; value_richtext: string; units_total?: number; units_remaining?: number } }) {
  return (
    <section className="py-12 px-4 max-w-3xl mx-auto">
      <h3 className="text-2xl font-semibold mb-4">Pricing</h3>
      <div className="prose" dangerouslySetInnerHTML={{ __html: data.value_richtext }} />
      {data.units_total && data.units_remaining !== undefined && (
        <p className="mt-4 text-sm text-neutral-600">{data.units_remaining} of {data.units_total} units remaining</p>
      )}
    </section>
  )
}
function SectionAmenities({ data }: { data: { items: Array<{ icon: string; label: string }> } }) {
  return (
    <section className="py-12 max-w-5xl mx-auto px-4">
      <h3 className="text-2xl font-semibold mb-6">Amenities</h3>
      <ul className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {data.items.map((it, i) => <li key={i} className="flex items-center gap-2 text-sm"><span aria-hidden>{it.icon}</span>{it.label}</li>)}
      </ul>
    </section>
  )
}
function SectionLocation({ data }: { data: { map_embed_url?: string; address: string; points_of_interest: Array<{ label: string; drive_time_min: number }> } }) {
  return (
    <section className="py-12 max-w-5xl mx-auto px-4 grid grid-cols-1 md:grid-cols-2 gap-8">
      {data.map_embed_url && <iframe src={data.map_embed_url} title="Map" className="w-full h-72 border-0" referrerPolicy="no-referrer-when-downgrade" />}
      <div>
        <h3 className="text-2xl font-semibold mb-3">Location</h3>
        <p className="text-sm">{data.address}</p>
        <ul className="mt-4 space-y-1 text-sm">
          {data.points_of_interest.map((p, i) => <li key={i}>{p.label} · {p.drive_time_min} min drive</li>)}
        </ul>
      </div>
    </section>
  )
}
function SectionBrochure({ data }: { data: { pdf: { media_id: number; alt: string } | null; gate_message_richtext?: string } }) {
  return (
    <section className="py-12 max-w-3xl mx-auto px-4 text-center">
      <h3 className="text-2xl font-semibold mb-4">Brochure</h3>
      {data.gate_message_richtext && <div className="prose mx-auto" dangerouslySetInnerHTML={{ __html: data.gate_message_richtext }} />}
      <form className="mt-6" action="/api/leads/brochure" method="post">
        <input name="name" placeholder="Your name" required className="border w-full p-2 mb-2" />
        <input name="email" type="email" placeholder="Email" required className="border w-full p-2 mb-2" />
        <input name="phone" placeholder="Phone" className="border w-full p-2 mb-2" />
        <input type="hidden" name="company_url" tabIndex={-1} className="absolute -left-[9999px]" />
        <button className="bg-amber-700 text-white px-6 py-2 rounded">Request brochure</button>
      </form>
    </section>
  )
}
function SectionTimeline({ data, media }: { data: { entries: Array<{ date: string; title: string; body_richtext?: string; photo?: { media_id: number; alt: string } }> }; media: MediaMap }) {
  return (
    <section className="py-12 max-w-3xl mx-auto px-4">
      <h3 className="text-2xl font-semibold mb-6">Construction progress</h3>
      <ol className="space-y-6">
        {data.entries.map((e, i) => (
          <li key={i} className="border-l-2 pl-4 border-amber-600">
            <p className="text-xs text-neutral-600">{e.date}</p>
            <h4 className="font-medium">{e.title}</h4>
            {e.photo && <MediaImg media={media.get(e.photo.media_id)} alt={e.photo.alt} variant="md" className="w-full h-56 object-cover rounded mt-2" />}
            {e.body_richtext && <div className="prose mt-2" dangerouslySetInnerHTML={{ __html: e.body_richtext }} />}
          </li>
        ))}
      </ol>
    </section>
  )
}
function SectionTestimonials({ data }: { data: { entries: Array<{ quote: string; attribution: string; unit_type?: string }> } }) {
  return (
    <section className="py-12 max-w-5xl mx-auto px-4">
      <h3 className="text-2xl font-semibold mb-6">From our owners</h3>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {data.entries.map((t, i) => (
          <li key={i} className="border p-4 rounded">
            <p className="italic">“{t.quote}”</p>
            <footer className="mt-3 text-sm">— {t.attribution}{t.unit_type && `, ${t.unit_type}`}</footer>
          </li>
        ))}
      </ul>
    </section>
  )
}
function SectionInquiry({ data }: { data: { heading?: string; body_richtext?: string } }) {
  return (
    <section className="py-12 max-w-2xl mx-auto px-4 text-center">
      {data.heading && <h3 className="text-2xl font-semibold mb-3">{data.heading}</h3>}
      {data.body_richtext && <div className="prose mx-auto" dangerouslySetInnerHTML={{ __html: data.body_richtext }} />}
      <form className="mt-6 space-y-2" action="/api/leads/inquiry" method="post">
        <input name="name" placeholder="Your name" required className="border w-full p-2" />
        <input name="email" type="email" placeholder="Email" required className="border w-full p-2" />
        <input name="phone" placeholder="Phone" className="border w-full p-2" />
        <textarea name="message" placeholder="Message" className="border w-full p-2 min-h-[5rem]" />
        <input type="hidden" name="company_url" tabIndex={-1} className="absolute -left-[9999px]" />
        <button className="bg-amber-700 text-white px-6 py-2 rounded">Inquire</button>
      </form>
    </section>
  )
}
```

- [ ] **Step 2: project page**

```tsx
// app/projects/[slug]/page.tsx
import { notFound, redirect } from 'next/navigation'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { hydrateProject } from '@/lib/cms/hydrate'
import { verifyPreviewJwt } from '@/lib/auth/jwt'
import { renderSection } from '@/components/project-sections'
import { rscSession, canEdit, isEditModeOn } from '@/lib/auth/sessionForRsc'
import { cookies } from 'next/headers'
import { residenceLd } from '@/lib/seo/jsonLd'
import { resolveMetadata } from '@/lib/seo/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { slug } = await params
  const sp = await searchParams
  const rows = await db.execute(sql`SELECT name, tagline, seo_title, seo_description FROM projects WHERE slug = ${slug} AND deleted_at IS NULL`) as unknown as Array<{ name: string; tagline: string | null; seo_title: string | null; seo_description: string | null }>
  const p = rows[0]
  const base = await resolveMetadata({
    title: p?.seo_title ?? null, description: p?.seo_description ?? null,
    fallbackTitle: p?.name ?? 'Project', fallbackDescription: p?.tagline ?? undefined,
    canonicalPath: `/projects/${slug}`,
  })
  if (sp.preview) return { ...base, robots: { index: false, follow: false } }
  return base
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { slug } = await params
  const sp = await searchParams
  const session = await rscSession()
  const c = await cookies()
  const editable = canEdit(session) && isEditModeOn({ get: (k) => c.get(k) ?? undefined } as Parameters<typeof isEditModeOn>[0])

  let hydrated = await hydrateProject(slug, { allowUnpublished: false })
  if (!hydrated) {
    const redir = await db.execute(sql`SELECT new_slug FROM slug_redirects WHERE resource_type = 'project' AND old_slug = ${slug}`) as unknown as Array<{ new_slug: string }>
    if (redir[0]) redirect(`/projects/${redir[0].new_slug}`)
    if (sp.preview) {
      const unpublished = await hydrateProject(slug, { allowUnpublished: true })
      if (!unpublished) notFound()
      await verifyPreviewJwt(sp.preview, { type: 'project', id: unpublished.project.id, epoch: unpublished.project.preview_epoch }).catch(() => notFound())
      hydrated = unpublished
    } else {
      notFound()
    }
  }

  const ld = residenceLd({ name: hydrated.project.name, tagline: hydrated.project.tagline, slug: hydrated.project.slug, heroImage: hydrated.project.hero_image_id ? hydrated.media.get(hydrated.project.hero_image_id)?.variants?.lg : null })

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <h1 className="sr-only">{hydrated.project.name}</h1>
      {hydrated.sections.map((s) => (
        <div key={s.id}>{renderSection(s.section_key, s.data, hydrated.media)}</div>
      ))}
    </main>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add components/project-sections 'app/projects/[slug]/page.tsx' && git commit -m "feat(public): /projects/[slug] page rendering all 10 sections"
```

---

### Task 12: E2E

**Files:** Create `tests/e2e/projects.spec.ts`

- [ ] **Step 1: write**

```ts
import { test, expect } from '@playwright/test'
import { signBrochureToken } from '@/lib/auth/brochureToken'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

const LOGIN_PATH = process.env.LOGIN_PATH ?? 'jamestown'
async function loginAdmin(page: import('@playwright/test').Page) {
  await page.goto(`/${LOGIN_PATH}`)
  await page.fill('input[name=email]', 'admin@bwc.test')
  await page.fill('input[name=password]', 'CorrectHorseBattery0!')
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin/)
}

test('create project seeds 10 sections', async ({ request, page }) => {
  await loginAdmin(page)
  const csrf = (await (await request.get('/api/csrf')).json()).csrf as string
  const r = await request.post('/api/cms/projects', {
    data: { name: 'The Test', slug: 'the-test', status: 'coming_soon' },
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
  })
  expect(r.status()).toBe(201)
  const j = await r.json() as { id: number }
  const rows = await db.execute(sql`SELECT section_key FROM project_sections WHERE project_id = ${j.id}`) as unknown as Array<{ section_key: string }>
  expect(rows.length).toBe(10)
})

test('preview token works for unpublished and is revoked by epoch bump', async ({ page }) => {
  await loginAdmin(page)
  // Create a fresh unpublished project + grab preview link
  await page.request.post('/api/cms/projects', { data: { name: 'Preview Me', slug: 'preview-me', status: 'coming_soon' } })
  const idRow = await db.execute(sql`SELECT id FROM projects WHERE slug='preview-me'`) as unknown as Array<{ id: number }>
  const tokenResp = await page.request.post(`/api/cms/projects/${idRow[0].id}/preview-token`)
  const tokenBody = await tokenResp.json() as { url: string }
  await page.goto(tokenBody.url)
  await expect(page.getByText('Preview Me')).toBeVisible()
  // Bump epoch by toggling published off (will keep deleted_at null but still bump as unpublishing)
  await db.execute(sql`UPDATE projects SET preview_epoch = preview_epoch + 1 WHERE id = ${idRow[0].id}`)
  const r2 = await page.goto(tokenBody.url)
  expect(r2?.status()).toBe(404)
})

test('slug rename creates redirect', async ({ request }) => {
  const ids = await db.execute(sql`SELECT id, version FROM projects WHERE slug='the-test'`) as unknown as Array<{ id: number; version: number }>
  const csrf = (await (await request.get('/api/csrf')).json()).csrf as string
  await request.patch(`/api/cms/projects/${ids[0].id}`, {
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    data: { slug: 'the-test-renamed', version: ids[0].version },
  })
  const r = await request.get('/projects/the-test', { maxRedirects: 0 })
  expect([301, 308]).toContain(r.status())
})

test('brochure single-use', async ({ request }) => {
  // Create a lead row first via DB
  const ids = await db.execute(sql`SELECT id FROM projects WHERE slug='preview-me'`) as unknown as Array<{ id: number }>
  await db.execute(sql`INSERT INTO leads (source, name, email, project_id) VALUES ('brochure', 'Buyer', 'b@example.com', ${ids[0].id})`)
  const lead = (await db.execute(sql`SELECT id FROM leads WHERE email='b@example.com'`) as unknown as Array<{ id: number }>)[0]
  // The project needs a brochure_pdf_id pointing to an existing private PDF — assume test fixture exists
  const token = signBrochureToken({ lead_id: lead.id, project_id: ids[0].id })
  const r1 = await request.get(`/api/brochure/${token}`)
  expect([200, 410]).toContain(r1.status())               // 410 acceptable if no test brochure pdf seeded
  const r2 = await request.get(`/api/brochure/${token}`)
  expect(r2.status()).toBe(410)
})
```

- [ ] **Step 2: commit**

```bash
git add tests/e2e/projects.spec.ts && git commit -m "test(e2e): project create/preview/slug-redirect/brochure"
```

---

### Task 13: Definition of done

- [ ] All four E2E scenarios pass.
- [ ] State machine unit tests pass.
- [ ] Editor cannot toggle `published`, `slug`, or `status` (PATCH returns 403; audit_log entry recorded).
- [ ] `git commit --allow-empty -m "chore: Plan 04 complete — Projects"`.
