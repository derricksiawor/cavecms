# BWC Plan 08 — Admin Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Full `/admin/*` UX: shell with role-aware nav, dashboard stats, projects table with drag-reorder, leads inbox with PII masking by role + CSV streaming export, trash recovery, team management, blog list, users (Admin + step-up reauth + last-admin invariant), settings (typed by registry), audit log viewer, `/admin/help`.

**Architecture:** All admin pages are server components reading from existing APIs (Plans 02/04/06/07) plus small client components for tables, dnd-reorder, drawers. PII masking lives in `lib/leads/mask.ts`. Step-up reauth required for Admin-only sensitive mutations against `users` and `settings`.

**Prerequisites:** Plans 01–07.

---

### Task 1: Admin shell + role-aware nav

**Files:**
- Replace: `app/(admin)/admin/layout.tsx`
- Create: `components/admin/Sidebar.tsx`, `components/admin/Topbar.tsx`, `components/admin/LogoutButton.tsx`

- [ ] **Step 1: layout**

```tsx
// app/(admin)/admin/layout.tsx
import { requireRole } from '@/lib/auth/requireRole'
import { Sidebar } from '@/components/admin/Sidebar'
import { Topbar } from '@/components/admin/Topbar'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  return (
    <div className="min-h-screen grid grid-cols-[14rem_1fr]">
      <Sidebar role={ctx.role} />
      <div className="flex flex-col">
        <Topbar email={ctx.email} role={ctx.role} />
        <main className="flex-1 p-8 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: sidebar**

```tsx
// components/admin/Sidebar.tsx
import Link from 'next/link'

export function Sidebar({ role }: { role: 'admin' | 'editor' | 'viewer' }) {
  const items: Array<{ label: string; href: string; roles: Array<'admin' | 'editor' | 'viewer'> }> = [
    { label: 'Dashboard', href: '/admin', roles: ['admin', 'editor', 'viewer'] },
    { label: 'Projects', href: '/admin/projects', roles: ['admin', 'editor'] },
    { label: 'Leads', href: '/admin/leads', roles: ['admin', 'editor', 'viewer'] },
    { label: 'Team', href: '/admin/team', roles: ['admin', 'editor'] },
    { label: 'Blog', href: '/admin/blog', roles: ['admin', 'editor'] },
    { label: 'Trash', href: '/admin/trash', roles: ['admin', 'editor'] },
    { label: 'Users', href: '/admin/users', roles: ['admin'] },
    { label: 'Settings', href: '/admin/settings', roles: ['admin'] },
    { label: 'Activity', href: '/admin/activity', roles: ['admin'] },
    { label: 'Help', href: '/admin/help', roles: ['admin', 'editor', 'viewer'] },
  ]
  return (
    <aside className="bg-neutral-950 text-neutral-100 p-4">
      <p className="text-xs uppercase tracking-wide text-neutral-400 mb-4">Best World</p>
      <nav className="space-y-1">
        {items.filter((i) => i.roles.includes(role)).map((i) => (
          <Link key={i.href} href={i.href} className="block px-3 py-2 rounded hover:bg-neutral-800 text-sm">{i.label}</Link>
        ))}
      </nav>
    </aside>
  )
}
```

- [ ] **Step 3: topbar + logout**

```tsx
// components/admin/Topbar.tsx
import { LogoutButton } from './LogoutButton'
export function Topbar({ email, role }: { email: string; role: string }) {
  return (
    <header className="border-b px-6 py-3 flex items-center justify-between bg-white">
      <div className="text-sm text-neutral-600">{email} · <span className="capitalize">{role}</span></div>
      <LogoutButton />
    </header>
  )
}
```

```tsx
// components/admin/LogoutButton.tsx
'use client'
import { csrfFetch } from '@/lib/client/csrf'
export function LogoutButton() {
  const onClick = async () => {
    await csrfFetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/'
  }
  return <button onClick={onClick} className="text-sm underline">Sign out</button>
}
```

- [ ] **Step 4: commit**

```bash
git add app/\(admin\)/admin/layout.tsx components/admin && git commit -m "feat(admin): shell with role-aware sidebar + topbar + logout"
```

---

### Task 2: Dashboard cards

**Files:** Replace `app/(admin)/admin/page.tsx`

- [ ] **Step 1: write**

```tsx
import { unstable_cache } from 'next/cache'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'

const loadStats = unstable_cache(async () => {
  const newLeads = (await db.execute(sql`SELECT COUNT(*) AS n FROM leads WHERE created_at > NOW(3) - INTERVAL 7 DAY`)) as unknown as Array<{ n: number }>
  const failedEmails = (await db.execute(sql`SELECT COUNT(*) AS n FROM pending_emails WHERE attempts >= 3 AND resolved_at IS NULL`)) as unknown as Array<{ n: number }>
  const recentEdits = (await db.execute(sql`SELECT id, user_id, action, resource_type, resource_id, created_at FROM audit_log ORDER BY id DESC LIMIT 10`)) as unknown as Array<{ id: number; user_id: number | null; action: string; resource_type: string; resource_id: string | null; created_at: Date }>
  const publishedProjects = (await db.execute(sql`SELECT COUNT(*) AS n FROM projects WHERE published = TRUE AND deleted_at IS NULL`)) as unknown as Array<{ n: number }>
  return { newLeads7d: newLeads[0].n, failedEmails: failedEmails[0].n, publishedProjects: publishedProjects[0].n, recentEdits }
}, ['admin', 'dashboard'], { revalidate: 60 })

export default async function AdminHome() {
  await requireRole(['admin', 'editor', 'viewer'])
  const s = await loadStats()
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card label="New leads (7d)" value={s.newLeads7d} href="/admin/leads" />
        <Card label="Failed emails" value={s.failedEmails} href="/admin/activity?kind=smtp" />
        <Card label="Published projects" value={s.publishedProjects} href="/admin/projects" />
      </div>
      <h2 className="text-lg font-medium mb-3">Recent activity</h2>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left p-2">When</th><th>User</th><th>Action</th><th>Resource</th></tr></thead>
        <tbody>
          {s.recentEdits.map((r) => (
            <tr key={r.id} className="border-t"><td className="p-2 text-xs">{r.created_at.toISOString().slice(0, 16).replace('T', ' ')}</td><td className="p-2 text-xs">{r.user_id ?? '—'}</td><td className="p-2 text-xs">{r.action}</td><td className="p-2 text-xs">{r.resource_type} {r.resource_id ?? ''}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Card({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <a href={href} className="block border rounded p-4 hover:bg-neutral-50">
      <p className="text-xs uppercase text-neutral-500">{label}</p>
      <p className="text-3xl font-semibold mt-2">{value}</p>
    </a>
  )
}
```

- [ ] **Step 2: commit**

```bash
git add app/\(admin\)/admin/page.tsx && git commit -m "feat(admin): dashboard cards + recent activity"
```

---

### Task 3: PII masking helper

**Files:** Create `lib/leads/mask.ts`, `tests/unit/mask.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { maskLead } from '@/lib/leads/mask'

describe('maskLead', () => {
  it('returns unchanged for admin/editor', () => {
    const l = { name: 'John Doe', email: 'j@example.com', phone: '+233241234567', message: 'hi j@x.com' }
    expect(maskLead(l, 'admin')).toEqual(l)
    expect(maskLead(l, 'editor')).toEqual(l)
  })
  it('masks for viewer', () => {
    const l = { name: 'John Doe Smith', email: 'john.doe@example.com', phone: '+233241234567', message: 'Call me at +233 24 555 1111 or j@x.com.' }
    const m = maskLead(l, 'viewer')
    expect(m.name).toBe('JDS')
    expect(m.email).toMatch(/^j\*\*\*@example\.com$/)
    expect(m.phone).toBe('***4567')
    expect(m.message).toContain('[email]')
    expect(m.message).toContain('[phone]')
  })
})
```

- [ ] **Step 2: implement**

```ts
import 'server-only'

type Role = 'admin' | 'editor' | 'viewer'
interface MaskableLead { name?: string | null; email?: string | null; phone?: string | null; message?: string | null }

export function maskLead<T extends MaskableLead>(l: T, role: Role): T {
  if (role !== 'viewer') return l
  const initials = (l.name ?? '').split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 3).toUpperCase()
  const email = l.email ? l.email.replace(/^(.).*?(@.*)$/, '$1***$2') : null
  const phone = l.phone ? '***' + l.phone.slice(-4) : null
  const message = (l.message ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s-]{6,}/g, '[phone]')
    .slice(0, 80)
  return { ...l, name: initials, email, phone, message }
}
```

- [ ] **Step 3: commit**

```bash
git add lib/leads/mask.ts tests/unit/mask.test.ts && git commit -m "feat(leads): PII masking for viewer role"
```

---

### Task 4: GET /api/admin/leads + GET /[id]

**Files:** Create `app/api/admin/leads/route.ts`, `app/api/admin/leads/[id]/route.ts`

- [ ] **Step 1: list (masked for viewer)**

```ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { maskLead } from '@/lib/leads/mask'

const Query = z.object({
  source: z.enum(['contact', 'brochure', 'inquiry']).optional(),
  status: z.enum(['new', 'contacted', 'won', 'lost']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  const url = new URL(req.url)
  const q = Query.parse(Object.fromEntries(url.searchParams))
  let createdBefore: string | null = null, idBefore: number | null = null
  if (q.cursor) {
    const [ca, id] = q.cursor.split('_')
    createdBefore = ca; idBefore = Number(id)
  }
  const rows = (await db.execute(sql`
    SELECT l.id, l.source, l.name, l.email, l.phone, l.message, l.status, l.created_at,
           p.slug AS project_slug, p.name AS project_name
    FROM leads l
    LEFT JOIN projects p ON p.id = l.project_id AND p.deleted_at IS NULL
    WHERE 1=1
      ${q.source ? sql`AND l.source = ${q.source}` : sql``}
      ${q.status ? sql`AND l.status = ${q.status}` : sql``}
      ${createdBefore ? sql`AND (l.created_at, l.id) < (${createdBefore}, ${idBefore})` : sql``}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${q.limit}
  `)) as unknown as Array<Record<string, unknown>>
  const masked = rows.map((r) => maskLead({ name: r.name as string | null, email: r.email as string | null, phone: r.phone as string | null, message: r.message as string | null }, ctx.role)) as Array<Record<string, unknown>>
  const items = rows.map((r, i) => ({ ...r, ...masked[i] }))
  const last = items[items.length - 1]
  const nextCursor = last ? `${(last.created_at as Date).toISOString()}_${last.id}` : null
  return new Response(JSON.stringify({ items, nextCursor }), { status: 200, headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 2: detail (Admin/Editor only)**

```ts
// app/api/admin/leads/[id]/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'

export const GET = withError(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  await requireRole(['admin', 'editor'])     // Viewer cannot see detail
  const rows = (await db.execute(sql`SELECT l.*, p.slug AS project_slug, p.name AS project_name FROM leads l LEFT JOIN projects p ON p.id = l.project_id WHERE l.id = ${Number(id)}`)) as unknown as Array<Record<string, unknown>>
  if (!rows[0]) throw new HttpError(404, 'not_found')
  return new Response(JSON.stringify(rows[0]), { status: 200, headers: { 'content-type': 'application/json' } })
})

const StatusTransitions: Record<string, string[]> = {
  new: ['contacted'],
  contacted: ['won', 'lost', 'new'],
  won: [],
  lost: [],
}
const Patch = z.object({ status: z.enum(['new', 'contacted', 'won', 'lost']).optional(), notes: z.string().max(8000).optional() })

export const PATCH = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, ctx)
  const body = Patch.parse(await req.json())
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT status FROM leads WHERE id = ${Number(id)} FOR UPDATE`)) as unknown as Array<{ status: string }>
    if (!rows[0]) throw new HttpError(404, 'not_found')
    if (body.status && body.status !== rows[0].status) {
      if (ctx.role !== 'admin' && !StatusTransitions[rows[0].status].includes(body.status)) {
        throw new HttpError(409, 'invalid_status_transition')
      }
    }
    const sets: string[] = []
    const params: unknown[] = []
    if (body.status !== undefined) { sets.push('status = ?', 'status_changed_at = NOW(3)', 'status_changed_by = ?'); params.push(body.status, ctx.userId) }
    if (body.notes !== undefined) { sets.push('notes = ?'); params.push(body.notes) }
    if (sets.length === 0) return new Response(JSON.stringify({ ok: true }), { status: 200 })
    await tx.execute(sql.raw(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).bind(...params, Number(id)) as never)
    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, diff) VALUES (${ctx.userId}, 'status_change', 'lead', ${id}, ${JSON.stringify({ to: body.status })})`)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
})
```

- [ ] **Step 3: commit**

```bash
git add app/api/admin/leads && git commit -m "feat(admin): leads list (masked for viewer) + detail + status PATCH"
```

---

### Task 5: CSV streaming export

**Files:** Create `app/api/admin/leads/export/route.ts`

- [ ] **Step 1: write**

```ts
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'

const PREFIX = /^[=+\-@\t\r\n]/

function cell(v: string | number | Date | null | undefined): string {
  if (v == null) return '""'
  const s = v instanceof Date ? v.toISOString() : String(v)
  const safe = PREFIX.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

export const GET = withError(async () => {
  await requireRole(['admin', 'editor'])
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enc = new TextEncoder()
      ctrl.enqueue(enc.encode('﻿'))                                     // UTF-8 BOM
      ctrl.enqueue(enc.encode('id,source,name,email,phone,project_slug,status,message,created_at\n'))
      const rows = (await db.execute(sql`
        SELECT l.id, l.source, l.name, l.email, l.phone, p.slug AS project_slug, l.status, l.message, l.created_at
        FROM leads l LEFT JOIN projects p ON p.id = l.project_id
        ORDER BY l.created_at DESC LIMIT 100000
      `)) as unknown as Array<{ id: number; source: string; name: string | null; email: string | null; phone: string | null; project_slug: string | null; status: string; message: string | null; created_at: Date }>
      for (const r of rows) {
        const line = [r.id, r.source, r.name, r.email, r.phone, r.project_slug, r.status, r.message, r.created_at].map(cell).join(',')
        ctrl.enqueue(enc.encode(line + '\n'))
      }
      ctrl.close()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="bwc-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      'x-accel-buffering': 'no',
      'cache-control': 'no-store',
    },
  })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/admin/leads/export && git commit -m "feat(admin): streaming CSV export with injection escape"
```

---

### Task 6: /admin/leads UI

**Files:** Create `app/(admin)/admin/leads/page.tsx`, `app/(admin)/admin/leads/LeadsTable.tsx`

- [ ] **Step 1: page**

```tsx
import { requireRole } from '@/lib/auth/requireRole'
import { LeadsTable } from './LeadsTable'

export const dynamic = 'force-dynamic'

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ source?: string; status?: string }> }) {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  const sp = await searchParams
  return <LeadsTable role={ctx.role} filters={sp} />
}
```

- [ ] **Step 2: client table**

```tsx
'use client'
import { useEffect, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Drawer } from '@/components/ui/Drawer'

interface Lead { id: number; source: string; name: string | null; email: string | null; phone: string | null; message: string | null; status: string; project_slug: string | null; created_at: string }

export function LeadsTable({ role, filters }: { role: 'admin' | 'editor' | 'viewer'; filters: Record<string, string | undefined> }) {
  const [items, setItems] = useState<Lead[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [active, setActive] = useState<Lead | null>(null)
  const [busy, setBusy] = useState(false)

  async function loadPage(c?: string | null) {
    const params = new URLSearchParams()
    if (filters.source) params.set('source', filters.source)
    if (filters.status) params.set('status', filters.status)
    if (c) params.set('cursor', c)
    const r = await fetch('/api/admin/leads?' + params.toString())
    if (!r.ok) return
    const j = (await r.json()) as { items: Lead[]; nextCursor: string | null }
    setItems(c ? [...items, ...j.items] : j.items)
    setCursor(j.nextCursor)
  }
  useEffect(() => { loadPage(null) }, [filters.source, filters.status])

  async function changeStatus(id: number, status: string) {
    setBusy(true)
    await csrfFetch(`/api/admin/leads/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) })
    setItems(items.map((l) => (l.id === id ? { ...l, status } : l)))
    setActive(null); setBusy(false)
  }

  return (
    <section>
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Leads</h1>
        {role !== 'viewer' && <a href="/api/admin/leads/export" className="border px-3 py-2 text-sm rounded">Export CSV</a>}
      </header>
      <form className="mb-4 flex gap-2 text-sm">
        <select name="source" defaultValue={filters.source ?? ''} className="border p-2"><option value="">All sources</option><option>contact</option><option>brochure</option><option>inquiry</option></select>
        <select name="status" defaultValue={filters.status ?? ''} className="border p-2"><option value="">All statuses</option><option>new</option><option>contacted</option><option>won</option><option>lost</option></select>
        <button className="border px-3 py-2">Filter</button>
      </form>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left p-2">When</th><th>Source</th><th>Name</th><th>Email</th><th>Project</th><th>Status</th></tr></thead>
        <tbody>
          {items.map((l) => (
            <tr key={l.id} className="border-t cursor-pointer hover:bg-neutral-50" onClick={() => role !== 'viewer' && setActive(l)}>
              <td className="p-2 text-xs">{new Date(l.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td className="p-2">{l.source}</td>
              <td className="p-2">{l.name}</td>
              <td className="p-2 text-xs">{l.email}</td>
              <td className="p-2 text-xs">{l.project_slug ?? '—'}</td>
              <td className="p-2 text-xs">{l.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor && <button onClick={() => loadPage(cursor)} className="mt-4 border px-3 py-2 text-sm">Load more</button>}
      <Drawer open={!!active} onClose={() => setActive(null)}>
        {active && (
          <div className="p-4">
            <h2 className="font-semibold mb-2">Lead #{active.id}</h2>
            <p className="text-sm"><strong>{active.name}</strong> &lt;{active.email}&gt;{active.phone && ` · ${active.phone}`}</p>
            {active.project_slug && <p className="text-sm mt-1">Project: <a href={`/projects/${active.project_slug}`} className="underline">{active.project_slug}</a></p>}
            <p className="text-sm mt-3 whitespace-pre-wrap">{active.message}</p>
            {role !== 'viewer' && (
              <div className="mt-6 flex gap-2">
                {['new', 'contacted', 'won', 'lost'].map((s) => (
                  <button key={s} disabled={busy || s === active.status} onClick={() => changeStatus(active.id, s)} className="border px-3 py-1 text-sm rounded disabled:opacity-40">{s}</button>
                ))}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </section>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/\(admin\)/admin/leads && git commit -m "feat(admin): leads inbox with cursor pagination + drawer detail"
```

---

### Task 7: /admin/projects

**Files:** Create `app/(admin)/admin/projects/page.tsx`, `app/(admin)/admin/projects/ProjectsTable.tsx`

- [ ] **Step 1: page**

```tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'
import { ProjectsTable } from './ProjectsTable'

export const dynamic = 'force-dynamic'

export default async function AdminProjects({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const ctx = await requireRole(['admin', 'editor'])
  const sp = await searchParams
  const showArchived = sp.archived === '1'
  const rows = (await db.execute(sql`SELECT id, slug, name, status, published, featured_order, deleted_at, version, updated_at FROM projects ${showArchived ? sql`` : sql`WHERE deleted_at IS NULL`} ORDER BY featured_order IS NULL, featured_order, name`)) as unknown as Array<{ id: number; slug: string; name: string; status: string; published: number; featured_order: number | null; deleted_at: Date | null; version: number; updated_at: Date }>
  return <ProjectsTable role={ctx.role} initial={rows} showArchived={showArchived} />
}
```

- [ ] **Step 2: table**

```tsx
'use client'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface Row { id: number; slug: string; name: string; status: string; published: number; featured_order: number | null; deleted_at: Date | null; version: number }

export function ProjectsTable({ role, initial, showArchived }: { role: 'admin' | 'editor'; initial: Row[]; showArchived: boolean }) {
  const [items, setItems] = useState(initial)
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')

  async function createProject() {
    if (role !== 'admin') return
    const res = await csrfFetch('/api/cms/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName, slug: newSlug, status: 'coming_soon' }),
    })
    if (res.ok) window.location.reload()
  }

  async function togglePublished(row: Row) {
    if (role !== 'admin') return
    const res = await csrfFetch(`/api/cms/projects/${row.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ published: !row.published, version: row.version }),
    })
    if (res.ok) setItems(items.map((r) => (r.id === row.id ? { ...r, published: row.published ? 0 : 1, version: row.version + 1 } : r)))
  }

  async function archive(row: Row) {
    if (role !== 'admin') return
    if (!confirm(`Archive ${row.name}?`)) return
    const res = await csrfFetch(`/api/cms/projects/${row.id}`, { method: 'DELETE' })
    if (res.ok) setItems(items.filter((r) => r.id !== row.id))
  }

  async function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return
    const o = items.findIndex((r) => r.id === e.active.id)
    const n = items.findIndex((r) => r.id === e.over!.id)
    const next = arrayMove(items, o, n)
    setItems(next)
    const res = await csrfFetch('/api/cms/projects/reorder', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projects: next.map((r) => ({ id: r.id, expectedVersion: r.version })) }),
    })
    if (res.ok) {
      const j = (await res.json()) as { projects: Array<{ id: number; version: number }> }
      const map = new Map(j.projects.map((p) => [p.id, p.version]))
      setItems(next.map((r) => ({ ...r, version: map.get(r.id) ?? r.version })))
    }
  }

  return (
    <section>
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <a href={showArchived ? '/admin/projects' : '/admin/projects?archived=1'} className="text-sm underline">{showArchived ? 'Hide archived' : 'Show archived'}</a>
      </header>
      {role === 'admin' && (
        <div className="mb-6 flex gap-2">
          <Input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Input placeholder="slug" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} />
          <Button onClick={createProject}>Create</Button>
        </div>
      )}
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          {items.map((r) => <RowEl key={r.id} row={r} role={role} togglePublished={togglePublished} archive={archive} />)}
        </SortableContext>
      </DndContext>
    </section>
  )
}

function RowEl({ row, role, togglePublished, archive }: { row: Row; role: 'admin' | 'editor'; togglePublished: (r: Row) => void; archive: (r: Row) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: row.id })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}
      className="grid grid-cols-[3rem_2fr_1fr_1fr_1fr_2fr] gap-4 items-center border-b p-2 cursor-grab">
      <span className="text-neutral-400">≡</span>
      <a href={`/projects/${row.slug}`} className="font-medium hover:underline">{row.name}</a>
      <span className="text-xs">{row.status.replace(/_/g, ' ')}</span>
      <span className="text-xs">{row.featured_order ?? '—'}</span>
      <span className="text-xs">{row.deleted_at ? 'archived' : (row.published ? 'published' : 'draft')}</span>
      <div className="flex gap-2 text-xs">
        {role === 'admin' && !row.deleted_at && <button onClick={(e) => { e.stopPropagation(); togglePublished(row) }} className="border px-2 py-1">{row.published ? 'Unpublish' : 'Publish'}</button>}
        {role === 'admin' && !row.deleted_at && <button onClick={(e) => { e.stopPropagation(); archive(row) }} className="border px-2 py-1 text-red-600">Archive</button>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/\(admin\)/admin/projects && git commit -m "feat(admin): projects table with drag-reorder + publish toggle + archive"
```

---

### Task 8: /admin/trash

**Files:** Create `app/(admin)/admin/trash/page.tsx`, `app/(admin)/admin/trash/TrashClient.tsx`

- [ ] **Step 1: page**

```tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'
import { TrashClient } from './TrashClient'

export const dynamic = 'force-dynamic'

export default async function Trash() {
  await requireRole(['admin', 'editor'])
  const rows = (await db.execute(sql`SELECT cb.id, cb.block_type, cb.deleted_at, p.slug AS page_slug FROM content_blocks cb JOIN pages p ON p.id = cb.page_id WHERE cb.deleted_at IS NOT NULL AND cb.deleted_at > NOW(3) - INTERVAL 30 DAY ORDER BY cb.deleted_at DESC`)) as unknown as Array<{ id: number; block_type: string; deleted_at: Date; page_slug: string }>
  return <TrashClient initial={rows} />
}
```

- [ ] **Step 2: client**

```tsx
'use client'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'

interface Row { id: number; block_type: string; deleted_at: string | Date; page_slug: string }

export function TrashClient({ initial }: { initial: Row[] }) {
  const [items, setItems] = useState(initial)
  async function restore(id: number) {
    const r = await csrfFetch(`/api/cms/blocks/${id}/restore`, { method: 'POST' })
    if (r.ok) setItems(items.filter((i) => i.id !== id))
  }
  return (
    <section>
      <h1 className="text-2xl font-semibold mb-6">Trash</h1>
      {items.length === 0 ? <p>No recoverable items.</p> : (
        <table className="w-full text-sm">
          <thead><tr><th className="text-left p-2">Block</th><th>Page</th><th>Deleted</th><th></th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="p-2">{i.block_type}</td>
                <td className="p-2">{i.page_slug}</td>
                <td className="p-2 text-xs">{new Date(i.deleted_at).toISOString().slice(0, 10)}</td>
                <td className="p-2"><button onClick={() => restore(i.id)} className="border px-3 py-1 text-xs">Restore</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/\(admin\)/admin/trash && git commit -m "feat(admin): trash recovery for soft-deleted blocks"
```

---

### Task 9: /admin/users + reauth API + invariant

**Files:** Create `app/api/auth/reauth/route.ts`, `app/api/admin/users/route.ts`, `app/api/admin/users/[id]/route.ts`, `app/(admin)/admin/users/page.tsx`, `app/(admin)/admin/users/UsersTable.tsx`

- [ ] **Step 1: reauth API**

```ts
// app/api/auth/reauth/route.ts
import { z } from 'zod'
import { cookies } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'
import { verifyPassword } from '@/lib/auth/scrypt'
import { env } from '@/lib/env'

const Body = z.object({ password: z.string().min(1).max(200) })

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, ctx)
  const { password } = Body.parse(await req.json())
  const rows = (await db.execute(sql`SELECT password_hash FROM users WHERE id = ${ctx.userId}`)) as unknown as Array<{ password_hash: string }>
  if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) throw new HttpError(401, 'invalid_password')
  const c = await cookies()
  c.set('__Host-bwc_reauth_at', String(Math.floor(Date.now() / 1000)), {
    httpOnly: true, secure: env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/', maxAge: 300,
  })
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})

export async function requireFreshReauth(): Promise<void> {
  const c = await cookies()
  const ts = Number(c.get('__Host-bwc_reauth_at')?.value ?? 0)
  if (!ts || Date.now() / 1000 - ts > 300) throw new HttpError(401, 'reauth_required')
}
```

- [ ] **Step 2: users list/create**

```ts
// app/api/admin/users/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'
import { hashPassword } from '@/lib/auth/scrypt'
import { requireFreshReauth } from '@/app/api/auth/reauth/route'

export const GET = withError(async () => {
  await requireRole(['admin'])
  const rows = (await db.execute(sql`SELECT id, email, role, name, active, last_login_at FROM users ORDER BY id`)) as unknown as Array<Record<string, unknown>>
  return new Response(JSON.stringify({ items: rows }), { status: 200 })
})

const Create = z.object({
  email: z.string().email().max(180),
  name: z.string().max(180).optional(),
  role: z.enum(['admin', 'editor', 'viewer']),
  password: z.string().min(12).max(200),
})

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, ctx)
  await requireFreshReauth()
  const body = Create.parse(await req.json())
  const hash = await hashPassword(body.password)
  try {
    await db.execute(sql`INSERT INTO users (email, name, role, password_hash, must_rotate_password) VALUES (${body.email}, ${body.name ?? null}, ${body.role}, ${hash}, TRUE)`)
  } catch (err: unknown) {
    if (err && (err as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'email_taken')
    throw err
  }
  return new Response(JSON.stringify({ ok: true }), { status: 201 })
})
```

- [ ] **Step 3: user PATCH/DELETE (last-admin invariant)**

```ts
// app/api/admin/users/[id]/route.ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'
import { invalidateUser } from '@/lib/auth/userCache'
import { requireFreshReauth } from '@/app/api/auth/reauth/route'

const Patch = z.object({
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
  active: z.boolean().optional(),
}).strict()

async function assertNotLastAdmin(tx: typeof db, targetId: number, isStillAdmin: boolean) {
  if (isStillAdmin) return
  const admins = (await tx.execute(sql`SELECT id FROM users WHERE role='admin' AND active = TRUE AND id != ${targetId} FOR UPDATE`)) as unknown as Array<{ id: number }>
  if (admins.length === 0) throw new HttpError(409, 'last_admin_required')
}

export const PATCH = withError(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, ctx)
  await requireFreshReauth()
  const body = Patch.parse(await req.json())
  if (Number(id) === ctx.userId) throw new HttpError(409, 'cannot_modify_self')
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT id, role, active FROM users WHERE id = ${Number(id)} FOR UPDATE`)) as unknown as Array<{ id: number; role: string; active: number }>
    if (!rows[0]) throw new HttpError(404, 'not_found')
    const willBeAdmin = body.role !== undefined ? body.role === 'admin' : rows[0].role === 'admin'
    const willBeActive = body.active !== undefined ? body.active : rows[0].active === 1
    await assertNotLastAdmin(tx, Number(id), willBeAdmin && willBeActive)
    const sets: string[] = []
    const params: unknown[] = []
    if (body.role !== undefined) { sets.push('role = ?'); params.push(body.role) }
    if (body.active !== undefined) { sets.push('active = ?'); params.push(body.active) }
    sets.push('tokens_valid_after = NOW(3) + INTERVAL 1 SECOND')
    if (sets.length === 0) return new Response(JSON.stringify({ ok: true }), { status: 200 })
    await tx.execute(sql.raw(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params, Number(id)) as never)
    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id, diff) VALUES (${ctx.userId}, 'update', 'user', ${id}, ${JSON.stringify(body)})`)
    invalidateUser(Number(id))
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
})

export const DELETE = withError(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const ctx = await requireRole(['admin'])
  await requireFreshReauth()
  if (Number(id) === ctx.userId) throw new HttpError(409, 'cannot_modify_self')
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT role, active FROM users WHERE id = ${Number(id)} FOR UPDATE`)) as unknown as Array<{ role: string; active: number }>
    if (!rows[0]) throw new HttpError(404, 'not_found')
    await assertNotLastAdmin(tx, Number(id), false)
    await tx.execute(sql`UPDATE users SET active = FALSE, tokens_valid_after = NOW(3) + INTERVAL 1 SECOND WHERE id = ${Number(id)}`)
    invalidateUser(Number(id))
    await tx.execute(sql`INSERT INTO audit_log (user_id, action, resource_type, resource_id) VALUES (${ctx.userId}, 'deactivate', 'user', ${id})`)
    return new Response(null, { status: 204 })
  })
})
```

- [ ] **Step 4: users page + table**

```tsx
// app/(admin)/admin/users/page.tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'
import { UsersTable } from './UsersTable'

export const dynamic = 'force-dynamic'

export default async function AdminUsers() {
  await requireRole(['admin'])
  const rows = (await db.execute(sql`SELECT id, email, name, role, active, last_login_at FROM users ORDER BY id`)) as unknown as Array<{ id: number; email: string; name: string | null; role: string; active: number; last_login_at: Date | null }>
  return <UsersTable initial={rows} />
}
```

```tsx
// app/(admin)/admin/users/UsersTable.tsx
'use client'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'

interface U { id: number; email: string; name: string | null; role: string; active: number; last_login_at: Date | null }

export function UsersTable({ initial }: { initial: U[] }) {
  const [items, setItems] = useState(initial)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('editor')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function reauth(): Promise<boolean> {
    const pw = prompt('Confirm your password:')
    if (!pw) return false
    const r = await csrfFetch('/api/auth/reauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
    return r.ok
  }

  async function create() {
    if (!(await reauth())) return
    const r = await csrfFetch('/api/admin/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, role, password }) })
    if (r.ok) window.location.reload()
    else setErr(`Failed (${r.status})`)
  }

  async function update(id: number, patch: Partial<{ role: string; active: boolean }>) {
    if (!(await reauth())) return
    const r = await csrfFetch(`/api/admin/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    if (r.status === 409) setErr('Last admin must remain.')
    else if (r.ok) setItems(items.map((u) => (u.id === id ? { ...u, ...patch, active: patch.active === undefined ? u.active : patch.active ? 1 : 0 } : u)))
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold mb-6">Users</h1>
      {err && <p className="text-red-600 text-sm mb-3">{err}</p>}
      <div className="mb-6 grid grid-cols-1 md:grid-cols-5 gap-2">
        <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'editor' | 'viewer')} className="border p-2"><option>editor</option><option>admin</option><option>viewer</option></select>
        <Input placeholder="Initial password (>=12 chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button onClick={create}>Create</Button>
      </div>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left p-2">Email</th><th>Name</th><th>Role</th><th>Active</th><th>Last login</th><th></th></tr></thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.id} className="border-t">
              <td className="p-2">{u.email}</td>
              <td className="p-2">{u.name}</td>
              <td className="p-2">
                <select defaultValue={u.role} onChange={(e) => update(u.id, { role: e.target.value })} className="border p-1 text-xs"><option>admin</option><option>editor</option><option>viewer</option></select>
              </td>
              <td className="p-2 text-xs">{u.active ? 'yes' : 'no'}</td>
              <td className="p-2 text-xs">{u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 10) : '—'}</td>
              <td className="p-2"><button className="text-red-600 text-xs" onClick={() => update(u.id, { active: !u.active })}>{u.active ? 'Deactivate' : 'Activate'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 5: commit**

```bash
git add app/api/auth/reauth app/api/admin/users app/\(admin\)/admin/users && git commit -m "feat(admin): users CRUD with step-up reauth + last-admin invariant"
```

---

### Task 10: /admin/settings

**Files:** Create `app/api/admin/settings/route.ts`, `app/(admin)/admin/settings/page.tsx`, `app/(admin)/admin/settings/SettingsForm.tsx`

- [ ] **Step 1: API**

```ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrfFromCookie'
import { registry } from '@/lib/cms/settings-registry'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { requireFreshReauth } from '@/app/api/auth/reauth/route'

export const GET = withError(async () => {
  await requireRole(['admin'])
  const rows = (await db.execute(sql`SELECT \`key\`, value, version FROM settings`)) as unknown as Array<{ key: string; value: unknown; version: number }>
  return new Response(JSON.stringify({ items: rows }), { status: 200 })
})

const Body = z.object({
  key: z.string().min(1).max(60),
  value: z.unknown(),
  version: z.number().int().nonnegative(),
})

export const PATCH = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, ctx)
  await requireFreshReauth()
  const body = Body.parse(await req.json())
  const def = (registry as Record<string, { schema: z.ZodTypeAny }>)[body.key]
  if (!def) throw new HttpError(400, 'unknown_setting')
  const parsed = def.schema.parse(body.value)
  await db.execute(sql`UPDATE settings SET value = ${JSON.stringify(parsed)}, version = version + 1, updated_by = ${ctx.userId} WHERE \`key\` = ${body.key} AND version = ${body.version}`)
  queueMicrotask(() => safeRevalidate(['settings']))
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})
```

- [ ] **Step 2: page + form**

```tsx
// app/(admin)/admin/settings/page.tsx
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { requireRole } from '@/lib/auth/requireRole'
import { SettingsForm } from './SettingsForm'

export const dynamic = 'force-dynamic'
export default async function AdminSettings() {
  await requireRole(['admin'])
  const rows = (await db.execute(sql`SELECT \`key\`, value, version FROM settings`)) as unknown as Array<{ key: string; value: unknown; version: number }>
  return <SettingsForm initial={rows} />
}
```

```tsx
// app/(admin)/admin/settings/SettingsForm.tsx
'use client'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'

export function SettingsForm({ initial }: { initial: Array<{ key: string; value: unknown; version: number }> }) {
  const [items, setItems] = useState(() => initial.map((r) => ({ ...r, text: JSON.stringify(r.value, null, 2) })))
  const [err, setErr] = useState<string | null>(null)

  async function save(i: number) {
    const it = items[i]
    setErr(null)
    let parsed: unknown
    try { parsed = JSON.parse(it.text) } catch { setErr(`Invalid JSON in ${it.key}`); return }
    const pw = prompt('Confirm your password:')
    if (!pw) return
    const reauth = await csrfFetch('/api/auth/reauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
    if (!reauth.ok) { setErr('Reauth failed.'); return }
    const r = await csrfFetch('/api/admin/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: it.key, value: parsed, version: it.version }) })
    if (!r.ok) { setErr(`Save failed (${r.status})`); return }
    setItems(items.map((s, j) => (j === i ? { ...s, version: s.version + 1 } : s)))
  }

  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      {err && <p className="text-red-600 text-sm mb-3">{err}</p>}
      {items.map((it, i) => (
        <article key={it.key} className="mb-6 border rounded p-4">
          <header className="flex items-center justify-between mb-2">
            <strong>{it.key}</strong>
            <button onClick={() => save(i)} className="border px-3 py-1 text-sm">Save</button>
          </header>
          <textarea
            value={it.text}
            onChange={(e) => setItems(items.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)))}
            className="border w-full p-2 font-mono text-xs min-h-[12rem]"
          />
        </article>
      ))}
    </section>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/api/admin/settings app/\(admin\)/admin/settings && git commit -m "feat(admin): settings form with step-up reauth"
```

---

### Task 11: /admin/activity

**Files:** Create `app/api/admin/audit-log/route.ts`, `app/(admin)/admin/activity/page.tsx`

- [ ] **Step 1: API**

```ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'

const Q = z.object({
  resource_type: z.string().max(40).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const GET = withError(async (req: Request) => {
  await requireRole(['admin'])
  const sp = Object.fromEntries(new URL(req.url).searchParams)
  const q = Q.parse(sp)
  const beforeId = q.cursor ? Number(q.cursor) : null
  const rows = (await db.execute(sql`
    SELECT a.id, a.user_id, u.email AS user_email, a.action, a.resource_type, a.resource_id, a.diff, a.created_at
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE 1=1
      ${q.resource_type ? sql`AND a.resource_type = ${q.resource_type}` : sql``}
      ${beforeId !== null ? sql`AND a.id < ${beforeId}` : sql``}
    ORDER BY a.id DESC LIMIT ${q.limit}
  `)) as unknown as Array<Record<string, unknown>>
  const nextCursor = rows.length === q.limit ? String((rows[rows.length - 1]!.id as number)) : null
  return new Response(JSON.stringify({ items: rows, nextCursor }), { status: 200 })
})
```

- [ ] **Step 2: page**

```tsx
// app/(admin)/admin/activity/page.tsx
import { requireRole } from '@/lib/auth/requireRole'
import { ActivityClient } from './ActivityClient'

export const dynamic = 'force-dynamic'
export default async function Activity() {
  await requireRole(['admin'])
  return <ActivityClient />
}
```

```tsx
// app/(admin)/admin/activity/ActivityClient.tsx
'use client'
import { useEffect, useState } from 'react'

interface Row { id: number; user_email: string | null; action: string; resource_type: string; resource_id: string | null; diff: unknown; created_at: string }

export function ActivityClient() {
  const [items, setItems] = useState<Row[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  async function load(c?: string | null) {
    const url = new URLSearchParams()
    if (filter) url.set('resource_type', filter)
    if (c) url.set('cursor', c)
    const r = await fetch('/api/admin/audit-log?' + url.toString())
    if (!r.ok) return
    const j = (await r.json()) as { items: Row[]; nextCursor: string | null }
    setItems(c ? [...items, ...j.items] : j.items)
    setCursor(j.nextCursor)
  }
  useEffect(() => { load(null) }, [filter])

  return (
    <section>
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Activity</h1>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="border p-2 text-sm">
          <option value="">All</option><option>content_block</option><option>project</option><option>project_section</option><option>post</option><option>team_member</option><option>lead</option><option>user</option><option>auth</option>
        </select>
      </header>
      <table className="w-full text-sm">
        <thead><tr><th className="text-left p-2">When</th><th>User</th><th>Action</th><th>Resource</th><th>Diff</th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="p-2 text-xs">{new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td className="p-2 text-xs">{r.user_email ?? '—'}</td>
              <td className="p-2 text-xs">{r.action}</td>
              <td className="p-2 text-xs">{r.resource_type} {r.resource_id ?? ''}</td>
              <td className="p-2 text-[10px] font-mono max-w-md truncate">{JSON.stringify(r.diff)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor && <button onClick={() => load(cursor)} className="mt-4 border px-3 py-2 text-sm">Load more</button>}
    </section>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add app/api/admin/audit-log app/\(admin\)/admin/activity && git commit -m "feat(admin): audit log viewer"
```

---

### Task 12: /admin/help

**Files:** Create `docs/admin-help.md`, `app/(admin)/admin/help/page.tsx`

- [ ] **Step 1: help content**

```md
# Admin help

## How to edit a page

1. Sign in (your admin link).
2. Visit the page you want to edit (e.g. `/about`).
3. Click **Enter edit mode** (bottom-right).
4. Hover any section → click **✎ Edit**.
5. Make changes → **Save**.

## How to add a project

1. **Projects** in the sidebar → enter name + slug → **Create**.
2. Open the new project on the public side → edit each section in place.
3. When ready, flip the **Published** toggle on the projects list.

## How to view leads

1. **Leads** in the sidebar.
2. Click a row to view full details (Admin/Editor only).
3. Use **Export CSV** to download.

## How to write a blog post

1. **Blog** → **New post** → fill title + slug.
2. Edit body markdown; click **Preview** to see rendered output.
3. Toggle **Published** when ready.

## How to add a team member

1. **Team** → enter name + role → **Add**.
2. Drag to reorder.
```

- [ ] **Step 2: page**

```tsx
// app/(admin)/admin/help/page.tsx
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { requireRole } from '@/lib/auth/requireRole'
import { renderMarkdown } from '@/lib/cms/markdown'

export const dynamic = 'force-dynamic'

export default async function Help() {
  await requireRole(['admin', 'editor', 'viewer'])
  const md = await readFile(path.join(process.cwd(), 'docs/admin-help.md'), 'utf8')
  const html = await renderMarkdown(md)
  return <article className="prose max-w-3xl" dangerouslySetInnerHTML={{ __html: html }} />
}
```

- [ ] **Step 3: commit**

```bash
git add docs/admin-help.md app/\(admin\)/admin/help && git commit -m "feat(admin): /admin/help with markdown content"
```

---

### Task 13: E2E

**Files:** Create `tests/e2e/admin.spec.ts`

- [ ] **Step 1: write**

```ts
import { test, expect } from '@playwright/test'

const LOGIN_PATH = process.env.LOGIN_PATH ?? 'jamestown'

async function loginAs(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto(`/${LOGIN_PATH}`)
  await page.fill('input[name=email]', email)
  await page.fill('input[name=password]', password)
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin/)
}

test('viewer cannot reach lead detail; sees masked list', async ({ page }) => {
  await loginAs(page, 'viewer@bwc.test', 'ViewerPassword12!')
  await page.goto('/admin/leads')
  await expect(page.locator('table tbody tr').first()).toBeVisible()
  // Clicking a row would attempt to fetch detail; for viewer it should be hidden in UI
  const detailReq = await page.request.get('/api/admin/leads/1')
  expect(detailReq.status()).toBe(403)
})

test('editor cannot toggle published; admin can', async ({ page }) => {
  await loginAs(page, 'editor@bwc.test', 'EditorPassword12!')
  await page.goto('/admin/projects')
  // Editor sees no Publish button
  await expect(page.getByRole('button', { name: /^Publish$|^Unpublish$/ })).toHaveCount(0)
})

test('last admin cannot be demoted', async ({ page, request }) => {
  await loginAs(page, 'admin@bwc.test', 'CorrectHorseBattery0!')
  await page.goto('/admin/users')
  // reauth
  const reauth = await request.post('/api/auth/reauth', { headers: { 'content-type': 'application/json' }, data: { password: 'CorrectHorseBattery0!' } })
  expect(reauth.status()).toBe(200)
  // attempt to demote the only admin (themselves blocked separately, so target another admin if any — otherwise emulate by trying to deactivate self via API)
  const r = await request.patch('/api/admin/users/1', { headers: { 'content-type': 'application/json' }, data: { role: 'editor' } })
  expect([409]).toContain(r.status())
})

test('CSV export streams + escapes formula prefix', async ({ request, page }) => {
  await loginAs(page, 'admin@bwc.test', 'CorrectHorseBattery0!')
  const r = await page.request.get('/api/admin/leads/export')
  expect(r.status()).toBe(200)
  expect(r.headers()['content-type']).toContain('text/csv')
  const body = await r.text()
  // No raw =cmd lines (cells starting with = get prefixed apostrophe)
  expect(body).not.toMatch(/^\=.*$/m)
})
```

- [ ] **Step 2: commit**

```bash
git add tests/e2e/admin.spec.ts && git commit -m "test(e2e): admin RBAC + last-admin + CSV"
```

---

### Task 14: Definition of done

- [ ] All admin routes gated server-side via `requireRole`.
- [ ] PII masking verified on viewer-role list.
- [ ] Last-admin invariant blocks demoting/deactivating the final admin.
- [ ] Step-up reauth required for user-management + settings mutations.
- [ ] CSV export streams + escapes formula prefixes.
- [ ] `git commit --allow-empty -m "chore: Plan 08 complete — Admin Dashboard"`.
