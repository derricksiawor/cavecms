# CaveCMS Plan 05 — Marketing Pages + SEO

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Render `/about`, `/services`, `/contact`, `/projects` (index), `/blog` (index — stub), full SEO infrastructure (`sitemap.xml`, `robots.txt`, JSON-LD on every public route), metadata fallback chain, OG image generation.

**Architecture:** Each page is a server component using `hydratePage(...)` from Plan 02. Metadata via `generateMetadata` → `lib/seo/resolve.ts`. Sitemap + robots are dynamic Next.js routes. Settings (org info, default SEO, footer) cached via `unstable_cache` with `'settings'` tag.

**Prerequisites:** Plans 01–04.

---

### Task 1: settings schema + seed

**Files:**
- Create: `db/schema/settings.ts`
- Modify: `db/schema/index.ts`, `db/seed.ts`

- [ ] **Step 1: schema**

```ts
// db/schema/settings.ts
import { mysqlTable, varchar, json, int, timestamp } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 60 }).primaryKey(),
  value: json('value').notNull(),
  version: int('version').notNull().default(0),
  updatedBy: int('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
})
```

- [ ] **Step 2: seed**

Append to `db/seed.ts`:

```ts
import { settings } from './schema'
import { eq } from 'drizzle-orm'

const SETTINGS_DEFAULTS = {
  contact_info: { phone: '+233 24 297 7639', email: 'info@bestworldcompany.com', address: 'Nuumo Kofi Anum Link, Okpegon-Ledzokuku, Accra', hours: 'Mon-Fri 09:00-17:00' },
  social_links: [],
  default_seo: { title: 'Best World Properties', description: 'Luxury residential development in Accra, Ghana.', ogImagePath: null },
  footer: { tagline: 'Building homes that reflect your aspirations.', columns: [] },
  organization_json_ld: { name: 'Best World Properties', logoUrl: '/brand/logo.svg', sameAs: [] },
}

export async function seedSettingsIfEmpty(): Promise<void> {
  const rows = await db.select({ key: settings.key }).from(settings)
  const have = new Set(rows.map((r) => r.key))
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    if (!have.has(key)) {
      await db.insert(settings).values({ key, value })
    }
  }
}
```

Modify `scripts/seed-admin.ts` to also call `seedSettingsIfEmpty()` at the end.

- [ ] **Step 3:** generate migration + commit

```bash
pnpm drizzle-kit generate && git add db scripts && git commit -m "feat(db): settings table + default seeds"
```

---

### Task 2: settings registry

**Files:** Create `lib/cms/settings-registry.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { z } from 'zod'

const contactInfo = z.object({
  phone: z.string().max(40),
  email: z.string().email(),
  address: z.string().max(280),
  hours: z.string().max(120),
})
const socialLinks = z.array(z.object({ platform: z.string().max(40), url: z.string().url() })).max(20)
const defaultSeo = z.object({
  title: z.string().max(180),
  description: z.string().max(320),
  ogImagePath: z.string().nullable().optional(),
})
const footer = z.object({
  tagline: z.string().max(220),
  columns: z.array(z.object({
    label: z.string().max(60),
    links: z.array(z.object({ text: z.string().max(60), href: z.string().max(500) })).max(20),
  })).max(6),
})
const organizationJsonLd = z.object({
  name: z.string().max(180),
  altName: z.string().max(180).optional(),
  logoUrl: z.string().max(500),
  foundingDate: z.string().optional(),
  sameAs: z.array(z.string().url()).max(20).optional(),
})

export const registry = {
  contact_info: { schema: contactInfo, default: { phone: '', email: 'info@example.com', address: '', hours: '' } },
  social_links: { schema: socialLinks, default: [] as Array<{ platform: string; url: string }> },
  default_seo: { schema: defaultSeo, default: { title: 'Best World Properties', description: '', ogImagePath: null } },
  footer: { schema: footer, default: { tagline: '', columns: [] } },
  organization_json_ld: { schema: organizationJsonLd, default: { name: 'Best World Properties', logoUrl: '/brand/logo.svg', sameAs: [] } },
} as const

export type SettingsKey = keyof typeof registry
```

- [ ] **Step 2: commit**

```bash
git add lib/cms/settings-registry.ts && git commit -m "feat(cms): settings registry with Zod schemas + defaults"
```

---

### Task 3: getSetting + cache

**Files:** Create `lib/cms/getSettings.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { unstable_cache } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { settings } from '@/db/schema'
import { registry, type SettingsKey } from './settings-registry'

async function readSetting<K extends SettingsKey>(key: K) {
  const rows = await db.select().from(settings).where(eq(settings.key, key))
  const row = rows[0]
  if (!row) return registry[key].default
  return registry[key].schema.parse(row.value)
}

export const getSetting = <K extends SettingsKey>(key: K) =>
  unstable_cache(() => readSetting(key), ['settings', key], { tags: ['settings'] })()
```

- [ ] **Step 2: commit**

```bash
git add lib/cms/getSettings.ts && git commit -m "feat(cms): cached getSetting"
```

---

### Task 4: SEO resolver + JSON-LD builders

**Files:** Create `lib/seo/resolve.ts`, `lib/seo/jsonLd.ts`

- [ ] **Step 1: resolver**

```ts
import 'server-only'
import type { Metadata } from 'next'
import { getSetting } from '@/lib/cms/getSettings'

export interface SeoInput {
  title?: string | null
  description?: string | null
  fallbackTitle?: string
  fallbackDescription?: string
  ogImagePath?: string | null
  canonicalPath: string
}

export async function resolveMetadata(input: SeoInput): Promise<Metadata> {
  const defaultSeo = await getSetting('default_seo')
  const title = input.title || input.fallbackTitle || defaultSeo.title
  const description = input.description || input.fallbackDescription || defaultSeo.description
  const og = input.ogImagePath || defaultSeo.ogImagePath || null
  return {
    title, description,
    alternates: { canonical: input.canonicalPath },
    openGraph: {
      title, description, url: input.canonicalPath,
      images: og ? [{ url: og, width: 1200, height: 630 }] : undefined,
      siteName: defaultSeo.title,
    },
    twitter: { card: 'summary_large_image', title, description, images: og ? [og] : undefined },
  }
}
```

- [ ] **Step 2: JSON-LD**

```ts
import 'server-only'
import { getSetting } from '@/lib/cms/getSettings'

export async function organizationLd() {
  const org = await getSetting('organization_json_ld')
  const contact = await getSetting('contact_info')
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: org.name,
    alternateName: org.altName,
    logo: org.logoUrl,
    address: { '@type': 'PostalAddress', streetAddress: contact.address, addressCountry: 'GH' },
    telephone: contact.phone,
    email: contact.email,
    sameAs: org.sameAs ?? [],
  }
}

export function residenceLd(p: { name: string; tagline?: string | null; slug: string; heroImage?: string | null }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Residence',
    name: p.name,
    description: p.tagline ?? undefined,
    url: `https://bestworldcompany.com/projects/${p.slug}`,
    image: p.heroImage ?? undefined,
  }
}

export function blogPostingLd(p: { title: string; slug: string; publishedAt: Date; excerpt?: string | null; heroImage?: string | null; author: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    datePublished: p.publishedAt.toISOString(),
    description: p.excerpt ?? undefined,
    image: p.heroImage ?? undefined,
    author: { '@type': 'Person', name: p.author },
    mainEntityOfPage: `https://bestworldcompany.com/blog/${p.slug}`,
  }
}

export function breadcrumbLd(items: Array<{ name: string; url: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((i, idx) => ({ '@type': 'ListItem', position: idx + 1, name: i.name, item: i.url })),
  }
}
```

- [ ] **Step 3: commit**

```bash
git add lib/seo && git commit -m "feat(seo): metadata resolver + JSON-LD builders"
```

---

### Task 5: shared page-from-CMS helper

**Files:** Create `app/_shared/cmsPage.tsx`

- [ ] **Step 1: write**

```tsx
// app/_shared/cmsPage.tsx
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { hydratePage } from '@/lib/cms/hydrate'
import { renderBlock } from '@/components/blocks'
import { rscSession, canEdit, isEditModeOn } from '@/lib/auth/sessionForRsc'
import { EditableBlock } from '@/components/inline-edit/EditableBlock'
import { OutlinePanel } from '@/components/inline-edit/OutlinePanel'
import { EditModePill } from '@/components/inline-edit/EditModePill'
import { organizationLd } from '@/lib/seo/jsonLd'

export async function renderCmsPage(slug: 'home' | 'about' | 'services' | 'contact') {
  const session = await rscSession()
  const c = await cookies()
  const editable = canEdit(session) && isEditModeOn({ get: (k) => c.get(k) ?? undefined } as Parameters<typeof isEditModeOn>[0])
  const [pageRow] = (await db.execute(sql`SELECT id FROM pages WHERE slug = ${slug}`)) as unknown as Array<{ id: number }>
  if (!pageRow) throw new Error(`page_not_seeded:${slug}`)
  const { blocks, media, projects, team } = await hydratePage(pageRow.id)
  const ld = await organizationLd()
  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      {blocks.map((b) => {
        const node = renderBlock(b.blockType, b.data, { media, projects, team })
        return editable
          ? <EditableBlock key={b.id} blockId={b.id} blockType={b.blockType} pageSlug={slug} initialData={b.data} initialVersion={b.version} fixedKey={b.blockKey}>{node}</EditableBlock>
          : <div key={b.id}>{node}</div>
      })}
      {canEdit(session) && <EditModePill on={editable} />}
      {editable && <OutlinePanel pageId={pageRow.id} initial={blocks.map((b) => ({ id: b.id, blockKey: b.blockKey, blockType: b.blockType, version: b.version }))} />}
    </main>
  )
}
```

- [ ] **Step 2: commit**

```bash
git add app/_shared && git commit -m "feat(public): shared CMS page renderer"
```

---

### Task 6: /, /about, /services, /contact

**Files:** Create one `page.tsx` per route.

- [ ] **Step 1: `app/page.tsx`** (replaces stub)

```tsx
import { renderCmsPage } from './_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const [p] = (await db.execute(sql`SELECT seo_title, seo_description FROM pages WHERE slug='home'`)) as unknown as Array<{ seo_title: string | null; seo_description: string | null }>
  return resolveMetadata({ title: p?.seo_title, description: p?.seo_description, canonicalPath: '/', fallbackTitle: 'Best World Properties' })
}

export default async function HomePage() { return renderCmsPage('home') }
```

- [ ] **Step 2: `app/about/page.tsx`**

```tsx
import { renderCmsPage } from '../_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const [p] = (await db.execute(sql`SELECT seo_title, seo_description FROM pages WHERE slug='about'`)) as unknown as Array<{ seo_title: string | null; seo_description: string | null }>
  return resolveMetadata({ title: p?.seo_title, description: p?.seo_description, canonicalPath: '/about', fallbackTitle: 'About — Best World Properties' })
}

export default async function AboutPage() { return renderCmsPage('about') }
```

- [ ] **Step 3: `app/services/page.tsx`**

```tsx
import { renderCmsPage } from '../_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const [p] = (await db.execute(sql`SELECT seo_title, seo_description FROM pages WHERE slug='services'`)) as unknown as Array<{ seo_title: string | null; seo_description: string | null }>
  return resolveMetadata({ title: p?.seo_title, description: p?.seo_description, canonicalPath: '/services', fallbackTitle: 'Services — Best World Properties' })
}

export default async function ServicesPage() { return renderCmsPage('services') }
```

- [ ] **Step 4: `app/contact/page.tsx`**

```tsx
import { renderCmsPage } from '../_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { getSetting } from '@/lib/cms/getSettings'
import { ensurePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const [p] = (await db.execute(sql`SELECT seo_title, seo_description FROM pages WHERE slug='contact'`)) as unknown as Array<{ seo_title: string | null; seo_description: string | null }>
  return resolveMetadata({ title: p?.seo_title, description: p?.seo_description, canonicalPath: '/contact', fallbackTitle: 'Contact — Best World Properties' })
}

export default async function ContactPage() {
  const contact = await getSetting('contact_info')
  const csrf = await ensurePublicPreCsrf()
  return (
    <>
      <div>{await (await import('../_shared/cmsPage')).renderCmsPage('contact')}</div>
      <section className="py-12 max-w-3xl mx-auto px-4">
        <h2 className="text-2xl font-semibold mb-4">Reach us</h2>
        <p className="text-sm">{contact.address}</p>
        <p className="text-sm mt-1"><a href={`tel:${contact.phone.replace(/\s/g, '')}`}>{contact.phone}</a></p>
        <p className="text-sm mt-1"><a href={`mailto:${contact.email}`}>{contact.email}</a></p>
        <form method="post" action="/api/leads/contact" className="mt-6 space-y-2">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="company_url" tabIndex={-1} className="absolute -left-[9999px]" />
          <input name="name" required placeholder="Your name" className="border w-full p-2" />
          <input name="email" type="email" required placeholder="Email" className="border w-full p-2" />
          <input name="phone" placeholder="Phone" className="border w-full p-2" />
          <textarea name="message" required placeholder="Message" className="border w-full p-2 min-h-[6rem]" />
          <button className="bg-amber-700 text-white px-6 py-2 rounded">Send</button>
        </form>
      </section>
    </>
  )
}
```

Note: `ensurePublicPreCsrf` is created in Plan 07 Task 2; if Plan 05 runs first, stub it temporarily as a helper that issues a fresh nonce + cookie (same code).

- [ ] **Step 5: commit**

```bash
git add app/page.tsx app/about app/services app/contact && git commit -m "feat(public): home/about/services/contact rendered from CMS"
```

---

### Task 7: /projects index

**Files:** Create `app/projects/page.tsx`

- [ ] **Step 1: write**

```tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { resolveMetadata } from '@/lib/seo/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return resolveMetadata({ canonicalPath: '/projects', fallbackTitle: 'Projects — Best World Properties', fallbackDescription: 'Our luxury residential projects in Accra.' })
}

export default async function ProjectsIndex() {
  const projects = (await db.execute(sql`SELECT p.slug, p.name, p.tagline, p.status, p.hero_image_id, m.variants FROM projects p LEFT JOIN media m ON m.id = p.hero_image_id WHERE p.published = TRUE AND p.deleted_at IS NULL ORDER BY p.featured_order IS NULL, p.featured_order, p.name`)) as unknown as Array<{ slug: string; name: string; tagline: string | null; status: string; hero_image_id: number | null; variants: { md?: string } | null }>
  return (
    <main className="py-12 px-4 max-w-6xl mx-auto">
      <h1 className="text-3xl font-semibold mb-8">Our projects</h1>
      {projects.length === 0 ? (
        <p>More coming soon.</p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {projects.map((p) => (
            <li key={p.slug}>
              <a href={`/projects/${p.slug}`} className="block group">
                {p.variants?.md ? <img src={p.variants.md} alt={p.name} className="w-full h-56 object-cover rounded" /> : <div className="w-full h-56 bg-neutral-100" />}
                <h2 className="mt-3 font-medium">{p.name}</h2>
                {p.tagline && <p className="text-sm text-neutral-600">{p.tagline}</p>}
                <span className="text-[10px] uppercase tracking-wide text-amber-700 mt-1 inline-block">{p.status.replace(/_/g, ' ')}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 2: commit**

```bash
git add app/projects/page.tsx && git commit -m "feat(public): /projects index"
```

---

### Task 8: /sitemap.xml + /robots.txt

**Files:** Create `app/sitemap.ts`, `app/robots.ts`

- [ ] **Step 1: sitemap**

```ts
import type { MetadataRoute } from 'next'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = 'https://bestworldcompany.com'
  const staticPaths = ['/', '/about', '/services', '/contact', '/projects', '/blog']
  const projects = (await db.execute(sql`SELECT slug, updated_at FROM projects WHERE published = TRUE AND deleted_at IS NULL`)) as unknown as Array<{ slug: string; updated_at: Date }>
  const posts = (await db.execute(sql`SELECT slug, updated_at FROM posts WHERE published = TRUE AND deleted_at IS NULL`).catch(() => [])) as unknown as Array<{ slug: string; updated_at: Date }>
  return [
    ...staticPaths.map((p) => ({ url: `${base}${p}`, lastModified: new Date() })),
    ...projects.map((p) => ({ url: `${base}/projects/${p.slug}`, lastModified: p.updated_at })),
    ...posts.map((p) => ({ url: `${base}/blog/${p.slug}`, lastModified: p.updated_at })),
  ]
}
```

- [ ] **Step 2: robots**

```ts
import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'

export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = (await headers()).get('host') ?? ''
  if (host.startsWith('staging.')) {
    return { rules: [{ userAgent: '*', disallow: '/' }], host: `https://${host}` }
  }
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/'] }],
    sitemap: 'https://bestworldcompany.com/sitemap.xml',
    host: 'https://bestworldcompany.com',
  }
}
```

- [ ] **Step 3: commit**

```bash
git add app/sitemap.ts app/robots.ts && git commit -m "feat(seo): sitemap + robots (host-aware)"
```

---

### Task 9: E2E + unit

**Files:** Create `tests/e2e/seo.spec.ts`, `tests/unit/seo-resolve.test.ts`

- [ ] **Step 1: unit (metadata fallback)**

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/cms/getSettings', () => ({
  getSetting: vi.fn(async (k: string) => ({
    default_seo: { title: 'DefT', description: 'DefD', ogImagePath: '/og-default.jpg' },
    organization_json_ld: { name: 'Org', logoUrl: '/logo.svg', sameAs: [] },
    contact_info: { phone: '1', email: 'e@e.com', address: 'A', hours: 'H' },
    footer: { tagline: 't', columns: [] },
    social_links: [],
  } as Record<string, unknown>)[k]),
}))

import { resolveMetadata } from '@/lib/seo/resolve'

describe('resolveMetadata fallback chain', () => {
  it('uses entity title when provided', async () => {
    const m = await resolveMetadata({ title: 'Entity', canonicalPath: '/x' })
    expect(m.title).toBe('Entity')
  })
  it('falls back to fallbackTitle then default', async () => {
    const m1 = await resolveMetadata({ fallbackTitle: 'FB', canonicalPath: '/x' })
    expect(m1.title).toBe('FB')
    const m2 = await resolveMetadata({ canonicalPath: '/x' })
    expect(m2.title).toBe('DefT')
  })
  it('canonical URL set from path', async () => {
    const m = await resolveMetadata({ canonicalPath: '/about' })
    expect(m.alternates?.canonical).toBe('/about')
  })
})
```

- [ ] **Step 2: E2E**

```ts
import { test, expect } from '@playwright/test'

test('home page has OG + canonical + Organization JSON-LD', async ({ page }) => {
  await page.goto('/')
  const ogTitle = await page.getAttribute('meta[property="og:title"]', 'content')
  expect(ogTitle).toBeTruthy()
  const canonical = await page.getAttribute('link[rel=canonical]', 'href')
  expect(canonical).toBe('/')
  const ld = await page.locator('script[type="application/ld+json"]').first().textContent()
  expect(ld).toContain('"@type":"Organization"')
})

test('sitemap.xml lists static + published projects', async ({ request }) => {
  const r = await request.get('/sitemap.xml')
  expect(r.status()).toBe(200)
  const body = await r.text()
  expect(body).toContain('<urlset')
  expect(body).toContain('/projects')
})

test('robots blocks staging host, allows apex', async ({ request }) => {
  const staging = await request.get('/robots.txt', { headers: { host: 'staging.bestworldcompany.com' } })
  expect(await staging.text()).toContain('Disallow: /')

  const apex = await request.get('/robots.txt', { headers: { host: 'bestworldcompany.com' } })
  const text = await apex.text()
  expect(text).toContain('Disallow: /admin')
  expect(text).toContain('Disallow: /api/')
  expect(text).not.toMatch(new RegExp(process.env.LOGIN_PATH ?? 'jamestown', 'i'))
})

test('slug redirect: old project URL 301s to new', async ({ request }) => {
  const r = await request.get('/projects/the-test', { maxRedirects: 0 })
  expect([301, 308]).toContain(r.status())
})
```

- [ ] **Step 3: commit**

```bash
git add tests/unit/seo-resolve.test.ts tests/e2e/seo.spec.ts && git commit -m "test: SEO unit + E2E"
```

---

### Task 10: Definition of done

- [ ] `/`, `/about`, `/services`, `/contact`, `/projects` render with edit chrome for admins, plain for anon.
- [ ] Every public route emits `<meta property="og:*">`, canonical link, Organization JSON-LD.
- [ ] `/sitemap.xml` lists all published projects + posts.
- [ ] `/robots.txt` is host-aware.
- [ ] `git commit --allow-empty -m "chore: Plan 05 complete — Marketing + SEO"`.
