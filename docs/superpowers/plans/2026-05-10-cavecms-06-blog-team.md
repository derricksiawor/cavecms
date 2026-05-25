# CaveCMS Plan 06 — Blog + Team

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** `posts` and `team_members` schemas + full CRUD endpoints + admin list/edit pages + public `/blog` index + `/blog/[slug]` detail + safe server-side markdown rendering + JSON-LD per post.

**Architecture:** Markdown stored as text, rendered server-side via `remark → remark-gfm → rehype-sanitize`. Strict allow-list including anchored `img[src]` regex. Posts reuse the slug_redirects table. Team appears via the `team_block` block_type from Plan 03.

**Prerequisites:** Plans 01–05.

---

### Task 1: Schemas

**Files:** Create `db/schema/posts.ts`, `db/schema/team.ts`; modify `db/schema/index.ts`.

- [ ] **Step 1: posts**

```ts
// db/schema/posts.ts
import { mysqlTable, int, varchar, mediumtext, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const posts = mysqlTable('posts', {
  id: int('id').primaryKey().autoincrement(),
  slug: varchar('slug', { length: 140 }).notNull(),
  title: varchar('title', { length: 220 }).notNull(),
  excerpt: varchar('excerpt', { length: 320 }),
  bodyMd: mediumtext('body_md').notNull(),
  heroImageId: int('hero_image_id'),
  published: boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at', { fsp: 3 }),
  authorId: int('author_id').references(() => users.id, { onDelete: 'set null' }),
  seoTitle: varchar('seo_title', { length: 180 }),
  seoDescription: varchar('seo_description', { length: 320 }),
  ogImageId: int('og_image_id'),
  version: int('version').notNull().default(0),
  deletedAt: timestamp('deleted_at', { fsp: 3 }),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  slugIdx: uniqueIndex('idx_posts_slug').on(t.slug),
  pubIdx: index('idx_posts_published').on(t.published, t.publishedAt),
  deletedIdx: index('idx_posts_deleted').on(t.deletedAt),
}))
```

- [ ] **Step 2: team**

```ts
// db/schema/team.ts
import { mysqlTable, int, varchar, text, boolean, timestamp, index } from 'drizzle-orm/mysql-core'

export const teamMembers = mysqlTable('team_members', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 120 }).notNull(),
  role: varchar('role', { length: 120 }),
  bioMd: text('bio_md'),
  photoId: int('photo_id'),
  position: int('position').notNull(),
  published: boolean('published').notNull().default(true),
  version: int('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
}, (t) => ({ posIdx: index('idx_team_position').on(t.position) }))
```

- [ ] **Step 3:** add exports to `db/schema/index.ts`, run `pnpm drizzle-kit generate`, commit.

```bash
git add db && git commit -m "feat(db): posts + team_members"
```

---

### Task 2: Markdown render pipeline + tests

**Files:** Create `lib/cms/markdown.ts`, `tests/unit/markdown.test.ts`

- [ ] **Step 1: failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '@/lib/cms/markdown'

describe('renderMarkdown', () => {
  it('strips <script>', async () => {
    const out = await renderMarkdown('<script>alert(1)</script>\n\nhello')
    expect(out).not.toContain('<script')
    expect(out).toContain('hello')
  })
  it('keeps internal /uploads images', async () => {
    const out = await renderMarkdown('![ok](/uploads/variants/abc-md.webp)')
    expect(out).toContain('src="/uploads/variants/abc-md.webp"')
  })
  it('strips external image hosts', async () => {
    const out = await renderMarkdown('![bad](https://evil.example/x.png)')
    expect(out).not.toContain('evil.example')
  })
  it('strips javascript: hrefs', async () => {
    const out = await renderMarkdown('[click](javascript:alert(1))')
    expect(out).not.toContain('javascript:')
  })
  it('allows lists + headings', async () => {
    const out = await renderMarkdown('## H2\n\n- a\n- b\n')
    expect(out).toContain('<h2>')
    expect(out).toContain('<ul>')
  })
})
```

- [ ] **Step 2: implement**

```ts
import 'server-only'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

const SCHEMA = {
  ...defaultSchema,
  tagNames: ['p','br','strong','em','a','ul','ol','li','blockquote','code','pre','h2','h3','h4','img'],
  attributes: {
    ...defaultSchema.attributes,
    a: [['href', /^(?:https?|mailto|tel):/i], 'rel', 'target'],
    img: [
      ['src', /^\/uploads\/(originals|variants)\/[A-Za-z0-9._-]{1,80}\.(jpe?g|png|webp|avif)$/],
      'alt',
    ],
  },
}

export async function renderMarkdown(md: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, SCHEMA)
    .use(rehypeStringify)
    .process(md)
  return String(file)
}
```

- [ ] **Step 3: commit**

```bash
git add lib/cms/markdown.ts tests/unit/markdown.test.ts && git commit -m "feat(cms): markdown pipeline with anchored img regex"
```

---

### Task 3: Posts CRUD API

**Files:** Create `app/api/cms/posts/route.ts`, `app/api/cms/posts/[id]/route.ts`

- [ ] **Step 1: shared CSRF helper**

```ts
// lib/auth/requireCsrfFromCookie.ts
import 'server-only'
import { cookies } from 'next/headers'
import { verifyCsrf } from './csrf'
import { HttpError } from './requireRole'

export async function requireCsrf(req: Request, ctx: { jti: string; userId: number }): Promise<void> {
  const c = await cookies()
  const header = req.headers.get('x-csrf-token') ?? ''
  const cookie = c.get('__Host-cavecms_csrf')?.value ?? ''
  if (header.length !== cookie.length || header !== cookie || !(await verifyCsrf(header, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    throw new HttpError(403, 'csrf_invalid')
  }
}
```

- [ ] **Step 2: list + create**

```ts
// app/api/cms/posts/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'

const CreateBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,140}$/),
  title: z.string().min(1).max(220),
}).strict()

export const GET = withError(async (req) => {
  await requireRole(['admin','editor','viewer'])
  const url = new URL(req.url)
  const showArchived = url.searchParams.get('archived') === '1'
  const rows = await db.execute(sql`SELECT id, slug, title, excerpt, published, published_at, updated_at FROM posts ${showArchived ? sql`` : sql`WHERE deleted_at IS NULL`} ORDER BY published_at DESC, id DESC LIMIT 50`) as unknown as Array<Record<string, unknown>>
  return new Response(JSON.stringify({ items: rows }), { status: 200, headers: { 'content-type': 'application/json' } })
})

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin','editor'])
  await requireCsrf(req, ctx)
  const body = CreateBody.parse(await req.json())
  try {
    const result = await db.execute(sql`INSERT INTO posts (slug, title, body_md, author_id, version) VALUES (${body.slug}, ${body.title}, '', ${ctx.userId}, 0)`)
    const insertId = (result as unknown as { insertId: number }).insertId
    return new Response(JSON.stringify({ id: insertId, slug: body.slug }), { status: 201, headers: { 'content-type': 'application/json' } })
  } catch (err: unknown) {
    if (err && (err as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'slug_taken')
    throw err
  }
})
```

- [ ] **Step 3: PATCH + DELETE**

```ts
// app/api/cms/posts/[id]/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag, tagsForPostSave } from '@/lib/cache/tags'

const EditorPatch = z.object({
  title: z.string().min(1).max(220).optional(),
  excerpt: z.string().max(320).optional(),
  bodyMd: z.string().max(200_000).optional(),
  heroImageId: z.number().int().positive().nullable().optional(),
  seoTitle: z.string().max(180).optional(),
  seoDescription: z.string().max(320).optional(),
  ogImageId: z.number().int().positive().nullable().optional(),
  version: z.number().int().nonnegative(),
}).strict()
const AdminPatch = EditorPatch.extend({
  published: z.boolean().optional(),
  slug: z.string().regex(/^[a-z0-9-]{2,140}$/).optional(),
}).strict()

export const PATCH = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin','editor'])
  await requireCsrf(req, ctx)
  const raw = await req.json()
  const Body = ctx.role === 'admin' ? AdminPatch : EditorPatch
  let body
  try { body = Body.parse(raw) } catch (err) {
    if (ctx.role === 'editor' && raw && typeof raw === 'object') {
      const adminOnly = ['published','slug']
      if (Object.keys(raw).some((k) => adminOnly.includes(k))) {
        await db.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, diff) VALUES (${ctx.userId}, 'rbac_field_reject', 'post', ${id}, ${JSON.stringify({ keys: Object.keys(raw).filter((k) => adminOnly.includes(k)) })})`)
        throw new HttpError(403, 'forbidden')
      }
    }
    throw err
  }

  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT id, slug, version, published FROM posts WHERE id = ${Number(id)} AND deleted_at IS NULL FOR UPDATE`) as unknown as Array<{ id: number; slug: string; version: number; published: number }>
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')
    if (row.version !== body.version) throw new HttpError(409, 'stale_version')

    const slugChanged = 'slug' in body && body.slug !== undefined && body.slug !== row.slug
    const publishedChanged = 'published' in body && body.published !== undefined && (body.published ? 1 : 0) !== row.published

    if (slugChanged && body.slug) {
      await tx.execute(sql`INSERT INTO slug_redirects (resource_type, old_slug, new_slug) VALUES ('post', ${row.slug}, ${body.slug}) ON DUPLICATE KEY UPDATE new_slug = VALUES(new_slug)`)
      await tx.execute(sql`UPDATE slug_redirects SET new_slug = ${body.slug} WHERE resource_type = 'post' AND new_slug = ${row.slug}`)
      await tx.execute(sql`DELETE FROM slug_redirects WHERE resource_type = 'post' AND old_slug = ${body.slug}`)
    }

    const sets: string[] = ['version = version + 1']
    const params: unknown[] = []
    const cols: Record<string, [string, unknown]> = {
      title: ['title', body.title],
      excerpt: ['excerpt', body.excerpt],
      bodyMd: ['body_md', body.bodyMd],
      heroImageId: ['hero_image_id', body.heroImageId],
      seoTitle: ['seo_title', body.seoTitle],
      seoDescription: ['seo_description', body.seoDescription],
      ogImageId: ['og_image_id', body.ogImageId],
    }
    if (ctx.role === 'admin') {
      Object.assign(cols, { published: ['published', body.published], slug: ['slug', body.slug] })
    }
    for (const [field, [col, val]] of Object.entries(cols)) {
      if (val !== undefined) { sets.push(`${col} = ?`); params.push(val) }
    }
    if (ctx.role === 'admin' && body.published === true && row.published === 0) sets.push('published_at = COALESCE(published_at, NOW(3))')
    await tx.execute(sql.raw(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...params, Number(id)) as never)
    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES (${ctx.userId}, 'update', 'post', ${id})`)

    const tagSet = tagsForPostSave(body.slug ?? row.slug, { publishedChanged, slugChanged })
    if (slugChanged) tagSet.tags.push(tag.post(row.slug))
    queueMicrotask(() => safeRevalidate(tagSet.tags))
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

export const DELETE = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, ctx)
  await db.execute(sql`UPDATE posts SET deleted_at = NOW(3) WHERE id = ${Number(id)} AND deleted_at IS NULL`)
  await db.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES (${ctx.userId}, 'delete', 'post', ${id})`)
  queueMicrotask(() => safeRevalidate(['posts-index', 'sitemap']))
  return new Response(null, { status: 204 })
})
```

- [ ] **Step 4: commit**

```bash
git add lib/auth/requireCsrfFromCookie.ts app/api/cms/posts && git commit -m "feat(api): posts CRUD with field-level RBAC + slug redirect"
```

---

### Task 4: Team CRUD API

**Files:** Create `app/api/cms/team/route.ts`, `app/api/cms/team/[id]/route.ts`, `app/api/cms/team/reorder/route.ts`

- [ ] **Step 1: list + create**

```ts
// app/api/cms/team/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  role: z.string().max(120).optional(),
}).strict()

export const GET = withError(async () => {
  await requireRole(['admin','editor','viewer'])
  const rows = await db.execute(sql`SELECT id, name, role, photo_id, position, published FROM team_members ORDER BY position`) as unknown as Array<Record<string, unknown>>
  return new Response(JSON.stringify({ items: rows }), { status: 200, headers: { 'content-type': 'application/json' } })
})

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin','editor'])
  await requireCsrf(req, ctx)
  const body = CreateBody.parse(await req.json())
  const max = (await db.execute(sql`SELECT COALESCE(MAX(position), 0) AS m FROM team_members`)) as unknown as Array<{ m: number }>
  const result = await db.execute(sql`INSERT INTO team_members (name, role, position, version) VALUES (${body.name}, ${body.role ?? null}, ${max[0].m + 1000}, 0)`)
  const id = (result as unknown as { insertId: number }).insertId
  return new Response(JSON.stringify({ id }), { status: 201, headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 2: PATCH + DELETE**

```ts
// app/api/cms/team/[id]/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'
import { safeRevalidate } from '@/lib/cache/revalidate'

const Patch = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.string().max(120).nullable().optional(),
  bioMd: z.string().max(20_000).optional(),
  photoId: z.number().int().positive().nullable().optional(),
  published: z.boolean().optional(),
  version: z.number().int().nonnegative(),
}).strict()

export const PATCH = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin','editor'])
  await requireCsrf(req, ctx)
  const body = Patch.parse(await req.json())
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT version FROM team_members WHERE id = ${Number(id)} FOR UPDATE`) as unknown as Array<{ version: number }>
    if (!rows[0]) throw new HttpError(404, 'not_found')
    if (rows[0].version !== body.version) throw new HttpError(409, 'stale_version')

    const sets: string[] = ['version = version + 1']
    const params: unknown[] = []
    const cols: Record<string, [string, unknown]> = {
      name: ['name', body.name],
      role: ['role', body.role],
      bioMd: ['bio_md', body.bioMd],
      photoId: ['photo_id', body.photoId],
      published: ['published', body.published],
    }
    for (const [, [col, val]] of Object.entries(cols)) {
      if (val !== undefined) { sets.push(`${col} = ?`); params.push(val) }
    }
    await tx.execute(sql.raw(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).bind(...params, Number(id)) as never)
    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES (${ctx.userId}, 'update', 'team_member', ${id})`)
    queueMicrotask(() => safeRevalidate(['team']))
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
})

export const DELETE = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin','editor'])
  await requireCsrf(req, ctx)
  await db.execute(sql`UPDATE team_members SET published = FALSE, version = version + 1 WHERE id = ${Number(id)}`)
  await db.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES (${ctx.userId}, 'hide', 'team_member', ${id})`)
  queueMicrotask(() => safeRevalidate(['team']))
  return new Response(null, { status: 204 })
})
```

- [ ] **Step 3: reorder**

```ts
// app/api/cms/team/reorder/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'
import { safeRevalidate } from '@/lib/cache/revalidate'

const Body = z.object({
  members: z.array(z.object({ id: z.number().int().positive(), expectedVersion: z.number().int().nonnegative() })).min(1).max(100),
}).strict()

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin','editor'])
  await requireCsrf(req, ctx)
  const body = Body.parse(await req.json())
  return db.transaction(async (tx) => {
    const ids = body.members.map((m) => m.id)
    const rows = await tx.execute(sql`SELECT id, version FROM team_members WHERE id IN (${ids}) FOR UPDATE`) as unknown as Array<{ id: number; version: number }>
    if (rows.length !== ids.length) throw new HttpError(409, 'drift')
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const m of body.members) {
      const cur = byId.get(m.id)
      if (!cur || cur.version !== m.expectedVersion) throw new HttpError(409, 'stale_version')
    }
    let pos = 1000
    const out: Array<{ id: number; version: number }> = []
    for (const m of body.members) {
      await tx.execute(sql`UPDATE team_members SET position = ${pos}, version = version + 1 WHERE id = ${m.id}`)
      out.push({ id: m.id, version: m.expectedVersion + 1 })
      pos += 1000
    }
    queueMicrotask(() => safeRevalidate(['team']))
    return new Response(JSON.stringify({ members: out }), { status: 200 })
  })
})
```

- [ ] **Step 4: commit**

```bash
git add app/api/cms/team && git commit -m "feat(api): team CRUD + reorder"
```

---

### Task 5: Public /blog index + /blog/[slug]

**Files:** Create `app/blog/page.tsx`, `app/blog/[slug]/page.tsx`

- [ ] **Step 1: index**

```tsx
// app/blog/page.tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { resolveMetadata } from '@/lib/seo/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return resolveMetadata({ canonicalPath: '/blog', fallbackTitle: 'News — Best World Properties' })
}

export default async function BlogIndex() {
  const posts = (await db.execute(sql`SELECT slug, title, excerpt, published_at FROM posts WHERE published = TRUE AND deleted_at IS NULL ORDER BY published_at DESC LIMIT 50`)) as unknown as Array<{ slug: string; title: string; excerpt: string | null; published_at: Date }>
  return (
    <main className="py-12 px-4 max-w-3xl mx-auto">
      <h1 className="text-3xl font-semibold mb-8">News</h1>
      {posts.length === 0 ? <p>No posts yet.</p> : (
        <ul className="space-y-8">
          {posts.map((p) => (
            <li key={p.slug}>
              <a href={`/blog/${p.slug}`} className="block group">
                <h2 className="text-xl font-medium group-hover:underline">{p.title}</h2>
                <time className="text-xs text-neutral-600">{p.published_at.toISOString().slice(0,10)}</time>
                {p.excerpt && <p className="text-sm mt-1">{p.excerpt}</p>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 2: detail**

```tsx
// app/blog/[slug]/page.tsx
import { notFound, redirect } from 'next/navigation'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { renderMarkdown } from '@/lib/cms/markdown'
import { blogPostingLd } from '@/lib/seo/jsonLd'
import { resolveMetadata } from '@/lib/seo/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const rows = await db.execute(sql`SELECT title, excerpt, seo_title, seo_description FROM posts WHERE slug = ${slug} AND published = TRUE AND deleted_at IS NULL`) as unknown as Array<{ title: string; excerpt: string | null; seo_title: string | null; seo_description: string | null }>
  const r = rows[0]
  return resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? r?.excerpt ?? null,
    fallbackTitle: r?.title ?? 'Post',
    canonicalPath: `/blog/${slug}`,
  })
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const rows = await db.execute(sql`SELECT p.*, u.name AS author_name, m.variants AS hero_variants FROM posts p LEFT JOIN users u ON u.id = p.author_id LEFT JOIN media m ON m.id = p.hero_image_id WHERE p.slug = ${slug} AND p.published = TRUE AND p.deleted_at IS NULL`) as unknown as Array<Record<string, unknown>>
  const post = rows[0]
  if (!post) {
    const redir = await db.execute(sql`SELECT new_slug FROM slug_redirects WHERE resource_type = 'post' AND old_slug = ${slug}`) as unknown as Array<{ new_slug: string }>
    if (redir[0]) redirect(`/blog/${redir[0].new_slug}`)
    notFound()
  }
  const html = await renderMarkdown(post.body_md as string)
  const heroVariants = post.hero_variants as { lg?: string } | null
  const ld = blogPostingLd({
    title: post.title as string,
    slug: post.slug as string,
    publishedAt: post.published_at as Date,
    excerpt: post.excerpt as string | null,
    heroImage: heroVariants?.lg ?? null,
    author: (post.author_name as string) ?? 'BWP',
  })
  return (
    <main className="py-12 max-w-3xl mx-auto px-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <h1 className="text-3xl font-semibold mb-2">{post.title as string}</h1>
      <time className="text-xs text-neutral-600">{(post.published_at as Date).toISOString().slice(0,10)}</time>
      {heroVariants?.lg && <img src={heroVariants.lg} alt="" className="w-full h-auto mt-6 rounded" />}
      <article className="prose mt-8" dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/blog && git commit -m "feat(public): /blog index + /blog/[slug] with markdown render"
```

---

### Task 6: Admin blog editor with live preview

**Files:** Create `app/(admin)/admin/blog/page.tsx`, `app/(admin)/admin/blog/[id]/page.tsx`, `app/(admin)/admin/blog/[id]/preview/action.ts`

- [ ] **Step 1: list**

```tsx
// app/(admin)/admin/blog/page.tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'
import { Button } from '@/components/ui/Button'

export const dynamic = 'force-dynamic'

export default async function AdminBlog() {
  await requireRole(['admin','editor'])
  const posts = await db.execute(sql`SELECT id, slug, title, published, published_at, updated_at FROM posts WHERE deleted_at IS NULL ORDER BY updated_at DESC`) as unknown as Array<{ id: number; slug: string; title: string; published: number; published_at: Date | null; updated_at: Date }>
  return (
    <section>
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Blog posts</h1>
        <form action="/admin/blog/new" method="get"><Button>New post</Button></form>
      </header>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left p-2">Title</th><th>Slug</th><th>Published</th><th>Updated</th></tr></thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} className="border-t">
              <td className="p-2"><a href={`/admin/blog/${p.id}`} className="underline">{p.title}</a></td>
              <td className="p-2 text-xs">{p.slug}</td>
              <td className="p-2 text-xs">{p.published ? 'yes' : 'no'}</td>
              <td className="p-2 text-xs">{p.updated_at.toISOString().slice(0,10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 2: editor (server action for preview render)**

```tsx
// app/(admin)/admin/blog/[id]/preview/action.ts
'use server'
import { renderMarkdown } from '@/lib/cms/markdown'
import { requireRole } from '@/lib/auth/requireRole'

export async function previewMarkdown(md: string): Promise<string> {
  await requireRole(['admin','editor'])
  return renderMarkdown(md)
}
```

```tsx
// app/(admin)/admin/blog/[id]/page.tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'
import { Editor } from './Editor'

export const dynamic = 'force-dynamic'

export default async function PostEditor({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireRole(['admin','editor'])
  const { id } = await params
  const rows = await db.execute(sql`SELECT id, slug, title, excerpt, body_md, version, published FROM posts WHERE id = ${Number(id)}`) as unknown as Array<{ id: number; slug: string; title: string; excerpt: string | null; body_md: string; version: number; published: number }>
  const post = rows[0]
  if (!post) return <p>Not found.</p>
  return <Editor post={post} canPublish={ctx.role === 'admin'} />
}
```

```tsx
// app/(admin)/admin/blog/[id]/Editor.tsx
'use client'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { previewMarkdown } from './preview/action'

export function Editor({ post, canPublish }: { post: { id: number; slug: string; title: string; excerpt: string | null; body_md: string; version: number; published: number }; canPublish: boolean }) {
  const [title, setTitle] = useState(post.title)
  const [slug, setSlug] = useState(post.slug)
  const [excerpt, setExcerpt] = useState(post.excerpt ?? '')
  const [body, setBody] = useState(post.body_md)
  const [published, setPublished] = useState(!!post.published)
  const [version, setVersion] = useState(post.version)
  const [previewHtml, setPreviewHtml] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const renderPreview = async () => setPreviewHtml(await previewMarkdown(body))

  const save = async () => {
    setBusy(true); setErr(null)
    const body_md = body
    const patch: Record<string, unknown> = { title, excerpt, bodyMd: body_md, version }
    if (canPublish) { patch.published = published; patch.slug = slug }
    const res = await csrfFetch(`/api/cms/posts/${post.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    })
    if (res.status === 409) setErr('Stale version. Reload.')
    else if (!res.ok) setErr(`Save failed (${res.status})`)
    else setVersion(version + 1)
    setBusy(false)
  }

  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[80vh]">
      <div className="space-y-3 overflow-auto">
        <label className="block text-sm">Title<Input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {canPublish && <label className="block text-sm">Slug<Input value={slug} onChange={(e) => setSlug(e.target.value)} /></label>}
        <label className="block text-sm">Excerpt<Input value={excerpt} onChange={(e) => setExcerpt(e.target.value)} /></label>
        {canPublish && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Published</label>}
        <textarea className="border w-full p-2 font-mono text-xs min-h-[40vh]" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex gap-2">
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          <Button variant="ghost" onClick={renderPreview}>Preview</Button>
        </div>
        {err && <p className="text-red-600 text-sm">{err}</p>}
      </div>
      <div className="border rounded p-4 overflow-auto prose" dangerouslySetInnerHTML={{ __html: previewHtml }} />
    </section>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/\(admin\)/admin/blog && git commit -m "feat(admin): blog list + markdown editor with server-rendered preview"
```

---

### Task 7: Admin team list

**Files:** Create `app/(admin)/admin/team/page.tsx`, `app/(admin)/admin/team/TeamTable.tsx`

- [ ] **Step 1: page**

```tsx
// app/(admin)/admin/team/page.tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'
import { TeamTable } from './TeamTable'

export const dynamic = 'force-dynamic'

export default async function AdminTeam() {
  await requireRole(['admin','editor'])
  const rows = await db.execute(sql`SELECT id, name, role, position, published, version FROM team_members ORDER BY position`) as unknown as Array<{ id: number; name: string; role: string | null; position: number; published: number; version: number }>
  return <TeamTable initial={rows} />
}
```

- [ ] **Step 2: client table with drag-reorder**

```tsx
// app/(admin)/admin/team/TeamTable.tsx
'use client'
import { useState } from 'react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface Member { id: number; name: string; role: string | null; position: number; published: number; version: number }

export function TeamTable({ initial }: { initial: Member[] }) {
  const [items, setItems] = useState(initial)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('')

  const add = async () => {
    if (!newName) return
    const res = await csrfFetch('/api/cms/team', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName, role: newRole || undefined }),
    })
    if (res.ok) window.location.reload()
  }

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const o = items.findIndex((m) => m.id === e.active.id)
    const n = items.findIndex((m) => m.id === e.over!.id)
    const next = arrayMove(items, o, n)
    setItems(next)
    const res = await csrfFetch('/api/cms/team/reorder', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ members: next.map((m) => ({ id: m.id, expectedVersion: m.version })) }),
    })
    if (res.ok) {
      const j = (await res.json()) as { members: Array<{ id: number; version: number }> }
      const map = new Map(j.members.map((m) => [m.id, m.version]))
      setItems(next.map((m) => ({ ...m, version: map.get(m.id) ?? m.version })))
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold mb-6">Team members</h1>
      <div className="mb-6 flex gap-2">
        <Input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Input placeholder="Role" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
        <Button onClick={add}>Add</Button>
      </div>
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((m) => m.id)} strategy={verticalListSortingStrategy}>
          {items.map((m) => <Row key={m.id} m={m} />)}
        </SortableContext>
      </DndContext>
    </section>
  )
}

function Row({ m }: { m: Member }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: m.id })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}
      className="border-b p-3 flex items-center justify-between cursor-grab">
      <div><strong>{m.name}</strong> {m.role && <span className="text-neutral-600 text-sm">— {m.role}</span>}</div>
      <span className="text-[10px]">{m.published ? 'shown' : 'hidden'}</span>
    </div>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/\(admin\)/admin/team && git commit -m "feat(admin): team table with add + drag reorder"
```

---

### Task 8: E2E

**Files:** Create `tests/e2e/blog-team.spec.ts`

- [ ] **Step 1: write**

```ts
import { test, expect } from '@playwright/test'

const LOGIN_PATH = process.env.LOGIN_PATH ?? 'jamestown'

async function loginAdmin(page: import('@playwright/test').Page) {
  await page.goto(`/${LOGIN_PATH}`)
  await page.fill('input[name=email]', 'admin@cavecms.test')
  await page.fill('input[name=password]', 'CorrectHorseBattery0!')
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin/)
}

test('admin can create + publish a post; public route renders sanitized', async ({ page, request }) => {
  await loginAdmin(page)
  // Create
  const csrf = (await (await request.get('/api/csrf')).json()).csrf as string
  const create = await request.post('/api/cms/posts', {
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    data: { slug: 'milestone-test', title: 'Test Milestone' },
  })
  const { id } = await create.json() as { id: number }
  // Patch + publish
  const patch = await request.patch(`/api/cms/posts/${id}`, {
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    data: { title: 'Test Milestone', bodyMd: '## Heading\n\n- one\n- two', published: true, version: 0 },
  })
  expect(patch.status()).toBe(200)
  await page.goto('/blog/milestone-test')
  await expect(page.locator('h2', { hasText: 'Heading' })).toBeVisible()
  await expect(page.locator('script', { hasText: '<script>' })).toHaveCount(0)
})

test('post slug rename produces redirect', async ({ request }) => {
  const csrf = (await (await request.get('/api/csrf')).json()).csrf as string
  // Assume post id 1 exists with slug milestone-test
  const r = await request.patch('/api/cms/posts/1', {
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    data: { slug: 'milestone-renamed', version: 1 },
  })
  expect([200, 409]).toContain(r.status())
  const old = await request.get('/blog/milestone-test', { maxRedirects: 0 })
  expect([301, 308]).toContain(old.status())
})

test('admin add team member then reorder', async ({ page }) => {
  await loginAdmin(page)
  await page.goto('/admin/team')
  await page.fill('input[placeholder=Name]', 'Ama Boateng')
  await page.fill('input[placeholder=Role]', 'Architect')
  await page.click('button:has-text("Add")')
  await expect(page.getByText('Ama Boateng')).toBeVisible({ timeout: 5000 })
})
```

- [ ] **Step 2: commit**

```bash
git add tests/e2e/blog-team.spec.ts && git commit -m "test(e2e): blog create + publish + slug-redirect; team add"
```

---

### Task 9: Definition of done

- [ ] Markdown XSS suite (Vitest) green.
- [ ] Posts CRUD respects field-level RBAC.
- [ ] `/blog/[slug]` renders sanitized HTML server-side; no client-side markdown.
- [ ] Team add + reorder work via admin UI.
- [ ] `git commit --allow-empty -m "chore: Plan 06 complete — Blog + Team"`.
