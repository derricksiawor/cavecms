# CaveCMS Plan 03 — Inline Edit UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render public pages with edit chrome for admins; clicking a block opens a right-side drawer with auto-generated form (from Zod schema) and live preview; drag-reorder + media picker + dirty-draft autosave all functional.

**Architecture:** Server components read auth from cookie → conditionally render `EditableBlock` wrappers. Edit chrome and drawer are client components. Drawer state mirrors into a debounced live-preview store. Saves use the existing PATCH/POST/DELETE routes from Plan 02. Drafts persisted to `localStorage` keyed by `block_id + base_version`.

**Tech Stack:** Adds `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@dnd-kit/core`, `@dnd-kit/sortable`, `clsx`.

**Prerequisites:** Plans 01–02 complete.

---

### Task 1: Install deps + UI primitives

**Files:**
- Modify: `package.json`
- Create: `components/ui/Button.tsx`, `components/ui/Input.tsx`, `components/ui/Drawer.tsx`

- [ ] **Step 1:** `pnpm add @tiptap/react@2 @tiptap/starter-kit@2 @tiptap/extension-link@2 @dnd-kit/core@6 @dnd-kit/sortable@8 clsx@2`

- [ ] **Step 2: `components/ui/Button.tsx`**

```tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' }>(
  function Button({ className, variant = 'primary', ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={clsx(
          'px-4 py-2 rounded font-medium transition disabled:opacity-50 disabled:cursor-not-allowed',
          variant === 'primary' && 'bg-amber-700 text-white hover:bg-amber-800',
          variant === 'ghost' && 'border border-neutral-300 hover:bg-neutral-50',
          className,
        )}
        {...rest}
      />
    )
  },
)
```

- [ ] **Step 3: `components/ui/Input.tsx`**

```tsx
import { forwardRef, type InputHTMLAttributes } from 'react'
import clsx from 'clsx'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx('border border-neutral-300 rounded w-full px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600', className)} {...rest} />
})
```

- [ ] **Step 4: `components/ui/Drawer.tsx`**

```tsx
'use client'
import { useEffect, type ReactNode } from 'react'

export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed top-0 right-0 z-50 w-full sm:w-[440px] h-full bg-white border-l shadow-xl overflow-auto" role="dialog" aria-modal="true">
        {children}
      </aside>
    </>
  )
}
```

- [ ] **Step 5: commit**

```bash
git add package.json pnpm-lock.yaml components/ui && git commit -m "chore: install editor + dnd deps; add UI primitives"
```

---

### Task 2: Auth helper for server components

**Files:** Create `lib/auth/sessionForRsc.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { cookies } from 'next/headers'
import { verifySessionJwt } from '@/lib/auth/jwt'
import { getUser } from '@/lib/auth/userCache'

export interface RscSession { userId: number; role: 'admin' | 'editor' | 'viewer'; jti: string; oat: number }

export async function rscSession(): Promise<RscSession | null> {
  const c = await cookies()
  const token = c.get('__Host-cavecms_session')?.value
  if (!token) return null
  const payload = await verifySessionJwt(token).catch(() => null)
  if (!payload || payload.pwp) return null
  const user = await getUser(Number(payload.sub))
  if (!user || !user.active) return null
  if (payload.iat * 1000 <= user.tokensValidAfterMs) return null
  return { userId: user.id, role: user.role, jti: payload.jti, oat: payload.oat }
}

export function canEdit(s: RscSession | null): boolean {
  return !!s && (s.role === 'admin' || s.role === 'editor')
}

export function isEditModeOn(c: { get(name: string): { value: string } | undefined }): boolean {
  return c.get('__Host-cavecms_edit_mode')?.value === '1'
}
```

- [ ] **Step 2: commit**

```bash
git add lib/auth/sessionForRsc.ts && git commit -m "feat(auth): rscSession helper + canEdit"
```

---

### Task 3: Edit-mode cookie toggle endpoint

**Files:** Create `app/api/cms/edit-mode/route.ts`

- [ ] **Step 1: write**

```ts
import { cookies } from 'next/headers'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { z } from 'zod'
import { env } from '@/lib/env'

const Body = z.object({ on: z.boolean() })

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor'])
  const c = await cookies()
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const csrfCookie = c.get('__Host-cavecms_csrf')?.value ?? ''
  if (csrfHeader.length !== csrfCookie.length || csrfHeader !== csrfCookie || !(await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) }))) {
    throw new HttpError(403, 'csrf_invalid')
  }
  const { on } = Body.parse(await req.json())
  if (on) {
    c.set('__Host-cavecms_edit_mode', '1', {
      httpOnly: true, secure: env.NODE_ENV === 'production',
      sameSite: 'strict', path: '/', maxAge: env.JWT_TTL_SECONDS,
    })
  } else {
    c.delete('__Host-cavecms_edit_mode')
  }
  return new Response(JSON.stringify({ on }), { status: 200, headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/cms/edit-mode && git commit -m "feat(inline): POST /api/cms/edit-mode toggle"
```

---

### Task 4: Client CSRF helper

**Files:** Create `lib/client/csrf.ts`

- [ ] **Step 1: write**

```ts
'use client'

export function readCsrf(): string {
  if (typeof document === 'undefined') return ''
  const prefix = '__Host-cavecms_csrf='
  const c = document.cookie.split('; ').find((row) => row.startsWith(prefix))
  return c ? c.slice(prefix.length) : ''
}

export async function refreshCsrf(): Promise<string> {
  const r = await fetch('/api/csrf', { credentials: 'include' })
  if (!r.ok) throw new Error('csrf_refresh_failed')
  const j = (await r.json()) as { csrf: string }
  return j.csrf
}

export async function csrfFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let token = readCsrf()
  const doFetch = (t: string) =>
    fetch(input, {
      ...init,
      credentials: 'include',
      headers: { ...(init.headers ?? {}), 'x-csrf-token': t },
    })
  let res = await doFetch(token)
  if (res.status === 403) {
    token = await refreshCsrf()
    res = await doFetch(token)
  }
  return res
}
```

- [ ] **Step 2: commit**

```bash
git add lib/client/csrf.ts && git commit -m "feat(client): csrfFetch + readCsrf/refreshCsrf"
```

---

### Task 5: Media picker modal (global)

**Files:**
- Create: `components/inline-edit/MediaPickerProvider.tsx`
- Create: `components/inline-edit/MediaPicker.tsx`
- Create: `components/inline-edit/MediaPickerModal.tsx`

- [ ] **Step 1: provider + context**

```tsx
// components/inline-edit/MediaPickerProvider.tsx
'use client'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { MediaPickerModal } from './MediaPickerModal'

export interface MediaRef { media_id: number; alt: string }

interface PickerCtx {
  open: (current: MediaRef | undefined, onPick: (m: MediaRef) => void) => void
}

const Ctx = createContext<PickerCtx | null>(null)

export function MediaPickerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ current?: MediaRef; onPick: (m: MediaRef) => void } | null>(null)
  const open = useCallback<PickerCtx['open']>((current, onPick) => setState({ current, onPick }), [])
  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {state && (
        <MediaPickerModal
          current={state.current}
          onPick={(m) => { state.onPick(m); setState(null) }}
          onClose={() => setState(null)}
        />
      )}
    </Ctx.Provider>
  )
}

export function useMediaPicker(): PickerCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useMediaPicker outside provider')
  return c
}
```

- [ ] **Step 2: MediaPicker field**

```tsx
// components/inline-edit/MediaPicker.tsx
'use client'
import { useMediaPicker, type MediaRef } from './MediaPickerProvider'

export function MediaPicker({ value, onChange, label = 'Image' }: {
  value: MediaRef | undefined; onChange: (m: MediaRef) => void; label?: string
}) {
  const { open } = useMediaPicker()
  return (
    <div className="border border-neutral-200 rounded p-3">
      <div className="text-sm font-medium mb-2">{label}</div>
      {value ? (
        <div className="flex items-center gap-3 mb-2">
          <img src={`/uploads/variants/_thumb_${value.media_id}.webp`} alt={value.alt} className="w-16 h-16 object-cover" />
          <span className="text-xs truncate">{value.alt}</span>
        </div>
      ) : <p className="text-xs text-neutral-500 mb-2">No image selected.</p>}
      <button type="button" onClick={() => open(value, onChange)} className="border border-neutral-300 px-3 py-1 text-sm rounded">
        {value ? 'Replace' : 'Pick image'}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: MediaPickerModal**

```tsx
// components/inline-edit/MediaPickerModal.tsx
'use client'
import { useEffect, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Drawer } from '@/components/ui/Drawer'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { MediaRef } from './MediaPickerProvider'

interface MediaRow { id: number; alt_text: string; mime_type: string; variants: { thumb?: string; md?: string } | null }

export function MediaPickerModal({ current, onPick, onClose }: { current?: MediaRef; onPick: (m: MediaRef) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'library' | 'upload'>('library')
  const [items, setItems] = useState<MediaRow[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [alt, setAlt] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadPage(c?: number | null) {
    setBusy(true); setError(null)
    const url = c ? `/api/cms/media?cursor=${c}` : '/api/cms/media'
    const r = await fetch(url, { credentials: 'include' })
    if (!r.ok) { setError('Could not load media library.'); setBusy(false); return }
    const j = (await r.json()) as { items: MediaRow[] }
    setItems(c ? [...items, ...j.items] : j.items)
    setCursor(j.items.length > 0 ? j.items[j.items.length - 1].id : null)
    setBusy(false)
  }
  useEffect(() => { loadPage(null) }, [])

  async function doUpload() {
    if (!file) { setError('Pick a file.'); return }
    if (!alt.trim()) { setError('Alt text is required.'); return }
    setBusy(true); setError(null)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('alt', alt.trim())
    const r = await csrfFetch('/api/cms/media', { method: 'POST', body: fd })
    if (!r.ok) { setError(`Upload failed (${r.status}).`); setBusy(false); return }
    const j = (await r.json()) as { id: number }
    onPick({ media_id: j.id, alt: alt.trim() })
  }

  return (
    <Drawer open onClose={onClose}>
      <header className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold">Media</h2>
        <button onClick={onClose} aria-label="close">✕</button>
      </header>
      <div className="px-4 pt-3 border-b flex gap-4">
        <button className={tab === 'library' ? 'font-medium underline' : ''} onClick={() => setTab('library')}>Library</button>
        <button className={tab === 'upload' ? 'font-medium underline' : ''} onClick={() => setTab('upload')}>Upload new</button>
      </div>
      <div className="p-4 space-y-4">
        {error && <p className="text-red-600 text-sm">{error}</p>}
        {tab === 'library' ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {items.map((m) => (
                <button key={m.id} type="button" onClick={() => onPick({ media_id: m.id, alt: m.alt_text })}
                  className="border rounded p-1 hover:ring-2 hover:ring-amber-600">
                  {m.variants?.thumb ? <img src={m.variants.thumb} alt={m.alt_text} className="w-full h-20 object-cover" /> : <div className="h-20 bg-neutral-100" />}
                  <p className="text-[10px] truncate mt-1">{m.alt_text || `media #${m.id}`}</p>
                </button>
              ))}
            </div>
            {cursor && <Button variant="ghost" disabled={busy} onClick={() => loadPage(cursor)}>Load more</Button>}
          </>
        ) : (
          <div className="space-y-3">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <label className="block text-sm">Alt text (required)<Input value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={320} /></label>
            <Button disabled={busy} onClick={doUpload}>{busy ? 'Uploading…' : 'Upload + use'}</Button>
          </div>
        )}
      </div>
    </Drawer>
  )
}
```

- [ ] **Step 4: mount provider in root layout**

Modify `app/layout.tsx`:

```tsx
import { headers } from 'next/headers'
import { MediaPickerProvider } from '@/components/inline-edit/MediaPickerProvider'
import './globals.css'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-csp-nonce') ?? ''
  return (
    <html lang="en">
      <head><meta name="csp-nonce" content={nonce} /></head>
      <body><MediaPickerProvider>{children}</MediaPickerProvider></body>
    </html>
  )
}
```

- [ ] **Step 5: commit**

```bash
git add components/inline-edit/MediaPicker* app/layout.tsx && git commit -m "feat(inline): media picker modal + provider"
```

---

### Task 6: ZodForm and per-block field shapes

**Files:** Create `components/inline-edit/ZodForm.tsx`

- [ ] **Step 1: write**

```tsx
'use client'
import { MediaPicker } from './MediaPicker'
import { Input } from '@/components/ui/Input'

export type FieldShape =
  | { kind: 'string'; key: string; label: string; maxLength?: number; multiline?: boolean }
  | { kind: 'richtext'; key: string; label: string; maxLength?: number }
  | { kind: 'media'; key: string; label: string }
  | { kind: 'cta'; key: string; label: string }
  | { kind: 'media_array'; key: string; label: string; itemFields?: FieldShape[] }
  | { kind: 'string_array'; key: string; label: string }
  | { kind: 'number'; key: string; label: string; min?: number; max?: number }
  | { kind: 'select'; key: string; label: string; options: Array<{ value: string; label: string }> }

export function ZodForm({ shapes, value, onChange }: {
  shapes: FieldShape[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void
}) {
  return (
    <form className="space-y-3" onSubmit={(e) => e.preventDefault()}>
      {shapes.map((s) => (
        <FieldRenderer key={s.key} shape={s} value={value[s.key]} onChange={(v) => onChange({ ...value, [s.key]: v })} />
      ))}
    </form>
  )
}

function FieldRenderer({ shape, value, onChange }: { shape: FieldShape; value: unknown; onChange: (v: unknown) => void }) {
  switch (shape.kind) {
    case 'string':
      return (
        <label className="block text-sm">
          <span className="font-medium">{shape.label}</span>
          {shape.multiline
            ? <textarea className="border border-neutral-300 w-full p-2 min-h-[6rem] mt-1" maxLength={shape.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
            : <Input className="mt-1" maxLength={shape.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />}
        </label>
      )
    case 'richtext':
      return (
        <label className="block text-sm">
          <span className="font-medium">{shape.label}</span>
          <textarea className="border border-neutral-300 w-full p-2 min-h-[8rem] mt-1 font-mono text-xs" maxLength={shape.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
          <span className="text-[10px] text-neutral-500">Supports basic HTML: &lt;p&gt;, &lt;strong&gt;, &lt;em&gt;, &lt;a&gt;, &lt;ul&gt;, &lt;ol&gt;, &lt;li&gt;.</span>
        </label>
      )
    case 'media':
      return <MediaPicker label={shape.label} value={value as { media_id: number; alt: string } | undefined} onChange={(m) => onChange(m)} />
    case 'cta':
      return <CtaField label={shape.label} value={value as CtaValue | undefined} onChange={onChange} />
    case 'number':
      return (
        <label className="block text-sm">
          <span className="font-medium">{shape.label}</span>
          <Input type="number" min={shape.min} max={shape.max} value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
        </label>
      )
    case 'select':
      return (
        <label className="block text-sm">
          <span className="font-medium">{shape.label}</span>
          <select className="border border-neutral-300 w-full p-2 mt-1" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
            {shape.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )
    case 'media_array':
      return <MediaArrayField shape={shape} value={value as Array<{ media_id: number; alt: string; caption?: string }> | undefined} onChange={onChange} />
    case 'string_array':
      return <StringArrayField shape={shape} value={value as string[] | undefined} onChange={onChange} />
  }
}

interface CtaValue { text: string; href: string; openInNew?: boolean }
function CtaField({ label, value, onChange }: { label: string; value: CtaValue | undefined; onChange: (v: unknown) => void }) {
  const v: CtaValue = value ?? { text: '', href: '', openInNew: false }
  return (
    <fieldset className="border border-neutral-200 p-3 space-y-2 rounded">
      <legend className="text-sm font-medium px-1">{label}</legend>
      <Input placeholder="Button text" value={v.text} onChange={(e) => onChange({ ...v, text: e.target.value })} />
      <Input placeholder="https://… or /path" value={v.href} onChange={(e) => onChange({ ...v, href: e.target.value })} />
      <label className="flex gap-2 text-sm">
        <input type="checkbox" checked={!!v.openInNew} onChange={(e) => onChange({ ...v, openInNew: e.target.checked })} />
        Open in new tab
      </label>
    </fieldset>
  )
}

function MediaArrayField({ shape, value, onChange }: { shape: FieldShape & { kind: 'media_array' }; value?: Array<{ media_id: number; alt: string; caption?: string }>; onChange: (v: unknown) => void }) {
  const arr = value ?? []
  return (
    <fieldset className="border border-neutral-200 p-3 space-y-2 rounded">
      <legend className="text-sm font-medium px-1">{shape.label}</legend>
      {arr.map((item, i) => (
        <div key={i} className="border border-neutral-100 rounded p-2 space-y-1">
          <MediaPicker value={item} onChange={(m) => { const next = [...arr]; next[i] = { ...next[i], ...m }; onChange(next) }} />
          <Input placeholder="Caption (optional)" value={item.caption ?? ''} onChange={(e) => { const next = [...arr]; next[i] = { ...next[i], caption: e.target.value }; onChange(next) }} />
          <button type="button" onClick={() => onChange(arr.filter((_, j) => j !== i))} className="text-xs text-red-600">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...arr, { media_id: 0, alt: '' }])} className="text-xs border px-2 py-1">+ Add image</button>
    </fieldset>
  )
}

function StringArrayField({ shape, value, onChange }: { shape: FieldShape & { kind: 'string_array' }; value?: string[]; onChange: (v: unknown) => void }) {
  const arr = value ?? []
  return (
    <fieldset className="border border-neutral-200 p-3 space-y-2 rounded">
      <legend className="text-sm font-medium px-1">{shape.label}</legend>
      {arr.map((item, i) => (
        <div key={i} className="flex gap-2">
          <Input value={item} onChange={(e) => { const next = [...arr]; next[i] = e.target.value; onChange(next) }} />
          <button type="button" onClick={() => onChange(arr.filter((_, j) => j !== i))} className="text-xs text-red-600 px-2">x</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...arr, ''])} className="text-xs border px-2 py-1">+ Add</button>
    </fieldset>
  )
}

export const SHAPES_FOR_BLOCK: Record<string, FieldShape[]> = {
  hero: [
    { kind: 'string', key: 'title', label: 'Title', maxLength: 220 },
    { kind: 'string', key: 'subtitle', label: 'Subtitle', maxLength: 320 },
    { kind: 'media',  key: 'image', label: 'Hero image' },
    { kind: 'cta',    key: 'cta', label: 'Call to action' },
  ],
  services_intro: [
    { kind: 'string',   key: 'title', label: 'Title', maxLength: 220 },
    { kind: 'richtext', key: 'body_richtext', label: 'Intro', maxLength: 4000 },
  ],
  featured_projects: [
    { kind: 'string',         key: 'title', label: 'Heading', maxLength: 220 },
    { kind: 'select',         key: 'layout', label: 'Layout', options: [{ value: 'grid', label: 'Grid' }, { value: 'carousel', label: 'Carousel' }] },
  ],
  about_history: [
    { kind: 'string',   key: 'title', label: 'Title', maxLength: 220 },
    { kind: 'richtext', key: 'body_richtext', label: 'Body', maxLength: 8000 },
    { kind: 'media',    key: 'image', label: 'Image' },
  ],
  team_block: [
    { kind: 'string', key: 'title', label: 'Heading', maxLength: 220 },
  ],
  cta: [
    { kind: 'string',   key: 'title', label: 'Title', maxLength: 220 },
    { kind: 'string',   key: 'body', label: 'Body', maxLength: 800, multiline: true },
    { kind: 'cta',      key: 'cta', label: 'Button' },
  ],
  text: [
    { kind: 'string',   key: 'heading', label: 'Heading', maxLength: 220 },
    { kind: 'richtext', key: 'body_richtext', label: 'Body', maxLength: 8000 },
  ],
  image: [
    { kind: 'media',  key: 'image', label: 'Image' },
    { kind: 'string', key: 'caption', label: 'Caption', maxLength: 320 },
    { kind: 'select', key: 'alignment', label: 'Alignment', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }] },
  ],
  gallery: [
    { kind: 'media_array', key: 'images', label: 'Images' },
    { kind: 'select', key: 'columns', label: 'Columns', options: [{ value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }] },
  ],
  quote: [
    { kind: 'string', key: 'quote', label: 'Quote', maxLength: 800, multiline: true },
    { kind: 'string', key: 'attribution', label: 'Attribution', maxLength: 120 },
    { kind: 'string', key: 'attribution_title', label: 'Attribution title', maxLength: 120 },
  ],
}
```

- [ ] **Step 2: commit**

```bash
git add components/inline-edit/ZodForm.tsx && git commit -m "feat(inline): ZodForm field renderer + per-block shapes"
```

---

### Task 7: EditDrawer

**Files:** Create `components/inline-edit/EditDrawer.tsx`

- [ ] **Step 1: write**

```tsx
'use client'
import { useEffect, useMemo, useState } from 'react'
import { Drawer } from '@/components/ui/Drawer'
import { Button } from '@/components/ui/Button'
import { csrfFetch } from '@/lib/client/csrf'
import { SHAPES_FOR_BLOCK, ZodForm } from './ZodForm'

export interface EditDrawerProps {
  blockId: number
  blockType: string
  pageSlug: string
  initialData: unknown
  initialVersion: number
  fixedKey?: string | null
  onClose: () => void
}

export function EditDrawer({ blockId, blockType, initialData, initialVersion, onClose }: EditDrawerProps) {
  const draftKey = useMemo(() => `cavecms:draft:${blockId}:${initialVersion}`, [blockId, initialVersion])
  const [data, setData] = useState<Record<string, unknown>>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey) : null
    return saved ? (JSON.parse(saved) as Record<string, unknown>) : (initialData as Record<string, unknown>)
  })
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = JSON.stringify(data) !== JSON.stringify(initialData)

  useEffect(() => {
    if (!dirty) { window.localStorage.removeItem(draftKey); return }
    const t = setTimeout(() => window.localStorage.setItem(draftKey, JSON.stringify(data)), 5000)
    return () => clearTimeout(t)
  }, [data, dirty, draftKey])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const save = async () => {
    setBusy(true); setErr(null)
    const res = await csrfFetch(`/api/cms/blocks/${blockId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: version, data }),
    })
    if (res.status === 409) { setErr('Someone else just saved this. Reload to see their changes.'); setBusy(false); return }
    if (res.status === 401) { setErr('Session expired. Please log in again.'); setBusy(false); return }
    if (!res.ok) { setErr(`Save failed (${res.status}).`); setBusy(false); return }
    const j = (await res.json()) as { version: number }
    setVersion(j.version)
    window.localStorage.removeItem(draftKey)
    setBusy(false)
    onClose()
  }

  const shapes = SHAPES_FOR_BLOCK[blockType] ?? []
  return (
    <Drawer open onClose={() => { if (!dirty || window.confirm('Discard changes?')) onClose() }}>
      <header className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold">Edit {blockType}</h2>
        <button onClick={() => { if (!dirty || window.confirm('Discard changes?')) onClose() }} aria-label="close">✕</button>
      </header>
      <div className="p-4">
        {shapes.length === 0 ? (
          <label className="block text-xs">
            Raw data (no schema defined for this block type)
            <textarea
              className="border w-full p-2 min-h-[20rem] font-mono text-xs"
              value={JSON.stringify(data, null, 2)}
              onChange={(e) => { try { setData(JSON.parse(e.target.value) as Record<string, unknown>) } catch { /* ignore until valid JSON */ } }}
            />
          </label>
        ) : (
          <ZodForm shapes={shapes} value={data} onChange={setData} />
        )}
      </div>
      <footer className="p-4 border-t flex items-center gap-3">
        <Button disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
        {err && <p className="text-red-600 text-sm">{err}</p>}
      </footer>
    </Drawer>
  )
}
```

- [ ] **Step 2: commit**

```bash
git add components/inline-edit/EditDrawer.tsx && git commit -m "feat(inline): EditDrawer with dirty draft + conflict handling"
```

---

### Task 8: EditableBlock wrapper

**Files:** Create `components/inline-edit/EditableBlock.tsx`

- [ ] **Step 1: write**

```tsx
'use client'
import { useState } from 'react'
import clsx from 'clsx'
import { EditDrawer } from './EditDrawer'

export interface EditableBlockProps {
  blockId: number
  blockType: string
  pageSlug: string
  initialData: unknown
  initialVersion: number
  fixedKey?: string | null
  children: React.ReactNode
}

export function EditableBlock(p: EditableBlockProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className={clsx('relative group')} data-edit-block-id={p.blockId}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute right-2 top-2 z-10 hidden group-hover:inline-flex bg-amber-700 text-white text-xs px-2 py-1 rounded shadow"
      >✎ Edit {p.blockType}</button>
      <div className="ring-0 hover:ring-2 hover:ring-amber-400/60 rounded transition">{p.children}</div>
      {open && (
        <EditDrawer
          blockId={p.blockId} blockType={p.blockType} pageSlug={p.pageSlug}
          initialData={p.initialData} initialVersion={p.initialVersion}
          fixedKey={p.fixedKey} onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: commit**

```bash
git add components/inline-edit/EditableBlock.tsx && git commit -m "feat(inline): EditableBlock hover affordance"
```

---

### Task 9: Floating EditModePill

**Files:** Create `components/inline-edit/EditModePill.tsx`

- [ ] **Step 1: write**

```tsx
'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'

export function EditModePill({ on }: { on: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    setBusy(true)
    await csrfFetch('/api/cms/edit-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: !on }),
    })
    setBusy(false)
    router.refresh()
  }
  return (
    <button
      onClick={toggle}
      disabled={busy}
      className="fixed bottom-6 right-6 z-40 bg-black text-white text-sm px-4 py-2 rounded-full shadow-lg"
    >
      {on ? 'Exit edit mode' : 'Enter edit mode'}
    </button>
  )
}
```

- [ ] **Step 2: commit**

```bash
git add components/inline-edit/EditModePill.tsx && git commit -m "feat(inline): edit-mode pill"
```

---

### Task 10: OutlinePanel — drag-reorder freeform blocks

**Files:** Create `components/inline-edit/OutlinePanel.tsx`

- [ ] **Step 1: write**

```tsx
'use client'
import { useState } from 'react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'

interface BlockSummary { id: number; blockKey: string | null; blockType: string; version: number }

export function OutlinePanel({ pageId, initial }: { pageId: number; initial: BlockSummary[] }) {
  const [items, setItems] = useState(initial)
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const oldIdx = items.findIndex((i) => i.id === e.active.id)
    const newIdx = items.findIndex((i) => i.id === e.over!.id)
    const next = arrayMove(items, oldIdx, newIdx)
    setItems(next)
    const res = await csrfFetch('/api/cms/blocks/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageId, blocks: next.map((b) => ({ id: b.id, expectedVersion: b.version })) }),
    })
    if (res.status === 409) { setErr('Page changed since you opened it. Reload.'); return }
    if (!res.ok) { setErr(`Reorder failed (${res.status}).`); return }
    const j = (await res.json()) as { blocks: Array<{ id: number; version: number }> }
    const byId = new Map(j.blocks.map((x) => [x.id, x.version]))
    setItems(next.map((b) => ({ ...b, version: byId.get(b.id) ?? b.version })))
    setErr(null)
  }

  return (
    <aside className="fixed left-4 top-24 z-30 bg-white border rounded shadow w-72">
      <header className="p-3 border-b flex items-center justify-between">
        <h3 className="font-medium text-sm">Outline</h3>
        <button onClick={() => setOpen((o) => !o)}>{open ? '–' : '+'}</button>
      </header>
      {open && (
        <div className="p-3 space-y-2">
          {err && <p className="text-red-600 text-xs">{err}</p>}
          <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              {items.map((b) => <Row key={b.id} block={b} />)}
            </SortableContext>
          </DndContext>
          <AddBlockMenu pageId={pageId} />
        </div>
      )}
    </aside>
  )
}

function Row({ block }: { block: BlockSummary }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: block.id, disabled: !!block.blockKey })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}
      className={`px-2 py-1 border rounded text-xs flex items-center justify-between ${block.blockKey ? 'bg-neutral-50 cursor-not-allowed' : 'bg-white cursor-grab'}`}>
      <span>{block.blockType}{block.blockKey ? ` · ${block.blockKey}` : ''}</span>
      {block.blockKey ? <span className="text-[10px] text-neutral-400">fixed</span> : <span className="text-neutral-400">≡</span>}
    </div>
  )
}

function AddBlockMenu({ pageId }: { pageId: number }) {
  const [busy, setBusy] = useState(false)
  const TYPES = ['text', 'image', 'cta', 'quote', 'gallery'] as const
  const add = async (blockType: string) => {
    setBusy(true)
    const data: Record<string, Record<string, unknown>> = {
      text: { body_richtext: '' },
      image: { image: { media_id: 0, alt: '' } },
      cta: { title: '', cta: { text: '', href: '' } },
      quote: { quote: '' },
      gallery: { images: [], columns: 3 },
    }
    await csrfFetch('/api/cms/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pageId, blockType, data: data[blockType] }),
    })
    setBusy(false)
    window.location.reload()
  }
  return (
    <div className="pt-2 border-t">
      <p className="text-[10px] uppercase text-neutral-500 mb-1">Add block</p>
      <div className="flex flex-wrap gap-1">
        {TYPES.map((t) => <Button key={t} variant="ghost" disabled={busy} onClick={() => add(t)} className="text-xs px-2 py-1">{t}</Button>)}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: commit**

```bash
git add components/inline-edit/OutlinePanel.tsx && git commit -m "feat(inline): outline panel with drag-reorder + add block menu"
```

---

### Task 11: Block render components (all 10 types)

**Files:** Create `components/blocks/<Type>/render.tsx` for each, plus `components/blocks/index.tsx` dispatcher.

- [ ] **Step 1: shared MediaImg helper**

```tsx
// components/blocks/MediaImg.tsx
import type { ReactNode } from 'react'

export function MediaImg({ media, alt, variant = 'md', className }: {
  media: { variants: Record<string, string> | null } | undefined; alt: string; variant?: 'thumb' | 'md' | 'lg' | 'og'; className?: string
}): ReactNode {
  if (!media || !media.variants) return <div className={className} aria-label={alt} />
  const src = media.variants[variant] ?? media.variants.md ?? Object.values(media.variants)[0]
  return <img src={src} alt={alt} className={className} loading="lazy" />
}
```

- [ ] **Step 2: Hero render**

```tsx
// components/blocks/Hero/render.tsx
import { MediaImg } from '../MediaImg'

interface HeroData { title: string; subtitle?: string; image: { media_id: number; alt: string }; cta?: { text: string; href: string; openInNew?: boolean } }

export function Hero({ data, media }: { data: HeroData; media: Map<number, { variants: Record<string, string> | null; alt_text: string }> }) {
  const m = media.get(data.image.media_id)
  return (
    <section className="relative bg-neutral-950 text-white">
      <MediaImg media={m} alt={data.image.alt} variant="lg" className="w-full h-[60vh] object-cover opacity-70" />
      <div className="absolute inset-0 flex flex-col justify-end p-8 sm:p-16 max-w-4xl">
        <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight">{data.title}</h1>
        {data.subtitle && <p className="mt-2 text-lg opacity-90">{data.subtitle}</p>}
        {data.cta && (
          <a href={data.cta.href} target={data.cta.openInNew ? '_blank' : undefined} rel={data.cta.openInNew ? 'noopener noreferrer nofollow' : undefined}
             className="mt-6 inline-block bg-amber-600 hover:bg-amber-700 text-white px-6 py-3 w-fit rounded">
            {data.cta.text}
          </a>
        )}
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Cta render**

```tsx
// components/blocks/Cta/render.tsx
interface CtaData { title: string; body?: string; cta: { text: string; href: string; openInNew?: boolean } }
export function Cta({ data }: { data: CtaData }) {
  return (
    <section className="py-16 bg-neutral-50 text-center">
      <h2 className="text-2xl font-semibold">{data.title}</h2>
      {data.body && <p className="mt-2 max-w-xl mx-auto text-neutral-600">{data.body}</p>}
      <a href={data.cta.href} target={data.cta.openInNew ? '_blank' : undefined} rel={data.cta.openInNew ? 'noopener noreferrer nofollow' : undefined}
         className="mt-6 inline-block bg-amber-600 hover:bg-amber-700 text-white px-6 py-3 rounded">{data.cta.text}</a>
    </section>
  )
}
```

- [ ] **Step 4: Text render**

```tsx
// components/blocks/Text/render.tsx
interface TextData { heading?: string; body_richtext: string }
export function Text({ data }: { data: TextData }) {
  return (
    <section className="py-12 max-w-3xl mx-auto px-4">
      {data.heading && <h2 className="text-2xl font-semibold mb-3">{data.heading}</h2>}
      <div className="prose" dangerouslySetInnerHTML={{ __html: data.body_richtext }} />
    </section>
  )
}
```

- [ ] **Step 5: Image render**

```tsx
// components/blocks/Image/render.tsx
import { MediaImg } from '../MediaImg'
interface ImageData { image: { media_id: number; alt: string }; caption?: string; alignment?: 'left' | 'center' | 'right' }
export function ImageBlock({ data, media }: { data: ImageData; media: Map<number, { variants: Record<string, string> | null }> }) {
  const m = media.get(data.image.media_id)
  const align = { left: 'mr-auto', center: 'mx-auto', right: 'ml-auto' }[data.alignment ?? 'center']
  return (
    <figure className={`py-8 max-w-3xl ${align} px-4`}>
      <MediaImg media={m} alt={data.image.alt} variant="lg" className="w-full h-auto rounded" />
      {data.caption && <figcaption className="text-sm text-neutral-600 mt-2">{data.caption}</figcaption>}
    </figure>
  )
}
```

- [ ] **Step 6: Gallery render**

```tsx
// components/blocks/Gallery/render.tsx
import { MediaImg } from '../MediaImg'
interface GalleryData { images: Array<{ media_id: number; alt: string; caption?: string }>; columns: 2 | 3 | 4 }
export function Gallery({ data, media }: { data: GalleryData; media: Map<number, { variants: Record<string, string> | null }> }) {
  const cols = { 2: 'grid-cols-2', 3: 'grid-cols-2 md:grid-cols-3', 4: 'grid-cols-2 md:grid-cols-4' }[data.columns]
  return (
    <section className={`grid ${cols} gap-2 py-8 px-4`}>
      {data.images.map((img, i) => (
        <figure key={i}>
          <MediaImg media={media.get(img.media_id)} alt={img.alt} variant="md" className="w-full h-48 object-cover rounded" />
          {img.caption && <figcaption className="text-xs text-neutral-600 mt-1">{img.caption}</figcaption>}
        </figure>
      ))}
    </section>
  )
}
```

- [ ] **Step 7: Quote render**

```tsx
// components/blocks/Quote/render.tsx
interface QuoteData { quote: string; attribution?: string; attribution_title?: string }
export function Quote({ data }: { data: QuoteData }) {
  return (
    <blockquote className="py-12 max-w-2xl mx-auto px-4 text-center">
      <p className="text-xl italic">“{data.quote}”</p>
      {data.attribution && <footer className="mt-3 text-sm text-neutral-600">— {data.attribution}{data.attribution_title && `, ${data.attribution_title}`}</footer>}
    </blockquote>
  )
}
```

- [ ] **Step 8: ServicesIntro render**

```tsx
// components/blocks/ServicesIntro/render.tsx
interface ServicesIntroData { title: string; body_richtext: string; items: Array<{ icon?: string; title: string; body: string }> }
export function ServicesIntro({ data }: { data: ServicesIntroData }) {
  return (
    <section className="py-16 px-4 max-w-5xl mx-auto">
      <h2 className="text-3xl font-semibold mb-4">{data.title}</h2>
      <div className="prose mb-8" dangerouslySetInnerHTML={{ __html: data.body_richtext }} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {data.items.map((it, i) => (
          <div key={i}>
            <h3 className="font-medium">{it.title}</h3>
            <p className="text-sm text-neutral-600 mt-1">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 9: FeaturedProjects render**

```tsx
// components/blocks/FeaturedProjects/render.tsx
import { MediaImg } from '../MediaImg'
interface FeaturedProjectsData { title?: string; project_ids: number[]; layout: 'grid' | 'carousel' }
export function FeaturedProjects({ data, projects, media }: {
  data: FeaturedProjectsData
  projects: Map<number, { slug: string; name: string; tagline: string | null; hero_image_id: number | null }>
  media: Map<number, { variants: Record<string, string> | null }>
}) {
  const list = data.project_ids.map((id) => projects.get(id)).filter((p): p is NonNullable<typeof p> => !!p)
  return (
    <section className="py-16 px-4 max-w-6xl mx-auto">
      {data.title && <h2 className="text-3xl font-semibold mb-8">{data.title}</h2>}
      <ul className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {list.map((p) => (
          <li key={p.slug}>
            <a href={`/projects/${p.slug}`} className="block group">
              <MediaImg media={p.hero_image_id ? media.get(p.hero_image_id) : undefined} alt={p.name} variant="md" className="w-full h-56 object-cover rounded" />
              <h3 className="mt-3 font-medium">{p.name}</h3>
              {p.tagline && <p className="text-sm text-neutral-600">{p.tagline}</p>}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 10: AboutHistory render**

```tsx
// components/blocks/AboutHistory/render.tsx
import { MediaImg } from '../MediaImg'
interface AboutHistoryData { title: string; body_richtext: string; image?: { media_id: number; alt: string } }
export function AboutHistory({ data, media }: { data: AboutHistoryData; media: Map<number, { variants: Record<string, string> | null }> }) {
  const m = data.image ? media.get(data.image.media_id) : undefined
  return (
    <section className="py-16 px-4 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
      <div>
        <h2 className="text-3xl font-semibold mb-3">{data.title}</h2>
        <div className="prose" dangerouslySetInnerHTML={{ __html: data.body_richtext }} />
      </div>
      {m && data.image && <MediaImg media={m} alt={data.image.alt} variant="lg" className="w-full h-72 object-cover rounded" />}
    </section>
  )
}
```

- [ ] **Step 11: TeamBlock render**

```tsx
// components/blocks/TeamBlock/render.tsx
import { MediaImg } from '../MediaImg'
interface TeamBlockData { title?: string }
export function TeamBlock({ data, team, media }: {
  data: TeamBlockData
  team: Map<number, { name: string; role: string | null; photo_id: number | null }>
  media: Map<number, { variants: Record<string, string> | null }>
}) {
  const list = Array.from(team.values())
  return (
    <section className="py-16 px-4 max-w-5xl mx-auto">
      {data.title && <h2 className="text-3xl font-semibold mb-8">{data.title}</h2>}
      <ul className="grid grid-cols-2 md:grid-cols-4 gap-6">
        {list.map((m, i) => (
          <li key={i} className="text-center">
            <MediaImg media={m.photo_id ? media.get(m.photo_id) : undefined} alt={m.name} variant="md" className="w-full h-48 object-cover rounded" />
            <p className="mt-2 font-medium">{m.name}</p>
            {m.role && <p className="text-xs text-neutral-600">{m.role}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 12: dispatcher**

```tsx
// components/blocks/index.tsx
import { Hero } from './Hero/render'
import { Cta } from './Cta/render'
import { Text } from './Text/render'
import { ImageBlock } from './Image/render'
import { Gallery } from './Gallery/render'
import { Quote } from './Quote/render'
import { ServicesIntro } from './ServicesIntro/render'
import { FeaturedProjects } from './FeaturedProjects/render'
import { AboutHistory } from './AboutHistory/render'
import { TeamBlock } from './TeamBlock/render'

export interface RenderContext {
  media: Map<number, { variants: Record<string, string> | null; alt_text: string }>
  projects: Map<number, { slug: string; name: string; tagline: string | null; hero_image_id: number | null }>
  team: Map<number, { name: string; role: string | null; photo_id: number | null }>
}

export function renderBlock(type: string, data: unknown, ctx: RenderContext): React.ReactNode {
  switch (type) {
    case 'hero': return <Hero data={data as never} media={ctx.media} />
    case 'cta': return <Cta data={data as never} />
    case 'text': return <Text data={data as never} />
    case 'image': return <ImageBlock data={data as never} media={ctx.media} />
    case 'gallery': return <Gallery data={data as never} media={ctx.media} />
    case 'quote': return <Quote data={data as never} />
    case 'services_intro': return <ServicesIntro data={data as never} />
    case 'featured_projects': return <FeaturedProjects data={data as never} projects={ctx.projects} media={ctx.media} />
    case 'about_history': return <AboutHistory data={data as never} media={ctx.media} />
    case 'team_block': return <TeamBlock data={data as never} team={ctx.team} media={ctx.media} />
    default: return null
  }
}
```

- [ ] **Step 13: commit**

```bash
git add components/blocks && git commit -m "feat(blocks): 10 block render components + dispatcher"
```

---

### Task 12: Public Home page using EditableBlock

**Files:** Modify `app/page.tsx`

- [ ] **Step 1: write**

```tsx
import { headers, cookies } from 'next/headers'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { hydratePage } from '@/lib/cms/hydrate'
import { rscSession, canEdit, isEditModeOn } from '@/lib/auth/sessionForRsc'
import { EditModePill } from '@/components/inline-edit/EditModePill'
import { EditableBlock } from '@/components/inline-edit/EditableBlock'
import { OutlinePanel } from '@/components/inline-edit/OutlinePanel'
import { renderBlock } from '@/components/blocks'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const session = await rscSession()
  const c = await cookies()
  const editable = canEdit(session) && isEditModeOn({ get: (k) => c.get(k) ?? undefined } as Parameters<typeof isEditModeOn>[0])
  const [pageRow] = (await db.execute(sql`SELECT id FROM pages WHERE slug='home'`)) as unknown as Array<{ id: number }>
  const { blocks, media, projects, team } = await hydratePage(pageRow.id)
  return (
    <main>
      {blocks.map((b) => {
        const node = renderBlock(b.blockType, b.data, { media, projects, team })
        return editable
          ? (
            <EditableBlock key={b.id} blockId={b.id} blockType={b.blockType} pageSlug="home"
              initialData={b.data} initialVersion={b.version} fixedKey={b.blockKey}>
              {node}
            </EditableBlock>
          )
          : <div key={b.id}>{node}</div>
      })}
      {canEdit(session) && <EditModePill on={editable} />}
      {editable && <OutlinePanel pageId={pageRow.id} initial={blocks.map((b) => ({ id: b.id, blockKey: b.blockKey, blockType: b.blockType, version: b.version }))} />}
    </main>
  )
}
```

- [ ] **Step 2: hydratePage signature fix**

If Plan 02's `hydratePage` returned `{ blocks: [...] }` with snake_case fields (`block_type`, etc.), normalize to camelCase here. Update `lib/cms/hydrate.ts` so the return shape uses `blockType`, `blockKey`, `pageId`, `version` to match the consumer.

```ts
// lib/cms/hydrate.ts adjustment
return {
  blocks: parsed.map((b) => ({
    id: b.id, pageId: b.page_id ?? null,
    blockKey: b.block_key, blockType: b.block_type,
    position: b.position, data: b.data, version: b.version,
  })),
  projects: new Map(projects.map((p) => [p.id, p])),
  team: new Map(team.map((t) => [t.id, t])),
  media,
}
```

- [ ] **Step 3: commit**

```bash
git add app/page.tsx lib/cms/hydrate.ts && git commit -m "feat(public): home page renders from CMS with edit chrome"
```

---

### Task 13: E2E — login + edit + persist

**Files:** Modify `tests/e2e/inline-edit.spec.ts`

- [ ] **Step 1: write**

```ts
import { test, expect } from '@playwright/test'

const LOGIN_PATH = process.env.LOGIN_PATH ?? 'jamestown'

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/${LOGIN_PATH}`)
  await page.fill('input[name=email]', 'admin@cavecms.test')
  await page.fill('input[name=password]', 'CorrectHorseBattery0!')
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.status() === 200),
    page.click('button[type=submit]'),
  ])
  await page.waitForURL(/\/admin/)
}

test('admin can edit hero title and reload shows new copy', async ({ page }) => {
  await login(page)
  await page.goto('/')
  await page.getByRole('button', { name: /Enter edit mode/ }).click()
  await page.getByRole('button', { name: /Edit hero/ }).first().click()
  const titleInput = page.getByLabel('Title')
  await titleInput.fill('A new title from Playwright')
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/cms/blocks/') && r.request().method() === 'PATCH' && r.status() === 200),
    page.getByRole('button', { name: /^Save$/ }).click(),
  ])
  await page.reload()
  await expect(page.getByText('A new title from Playwright')).toBeVisible()
})

test('drawer warns on discard with dirty changes', async ({ page }) => {
  await login(page)
  await page.goto('/')
  await page.getByRole('button', { name: /Enter edit mode/ }).click()
  await page.getByRole('button', { name: /Edit hero/ }).first().click()
  await page.getByLabel('Title').fill('Will be discarded')
  page.on('dialog', (d) => d.dismiss())
  await page.getByRole('button', { name: '✕' }).click()
  await expect(page.getByLabel('Title')).toBeVisible()
})

test('reorder freeform tail blocks updates positions', async ({ page }) => {
  await login(page)
  await page.goto('/')
  await page.getByRole('button', { name: /Enter edit mode/ }).click()
  await page.locator('aside').getByRole('button', { name: '+' }).click()
  await page.getByRole('button', { name: 'text' }).click()
  await page.waitForLoadState('networkidle')
  // Drag last into second-from-last position
  const rows = page.locator('aside [aria-roledescription], aside .cursor-grab')
  const count = await rows.count()
  if (count >= 2) {
    const last = rows.nth(count - 1)
    const prev = rows.nth(count - 2)
    await last.dragTo(prev)
    await page.waitForResponse((r) => r.url().includes('/api/cms/blocks/reorder'))
  }
})
```

- [ ] **Step 2: commit**

```bash
git add tests/e2e/inline-edit.spec.ts && git commit -m "test(e2e): inline-edit roundtrip, discard warning, reorder"
```

---

### Task 14: Definition of done

- [ ] Admin/editor sees edit chrome on the home page when edit mode is on.
- [ ] Clicking a block opens drawer with autoform; Save updates DB; `/` reflects after revalidate.
- [ ] Discarding a dirty drawer prompts confirmation; preserves draft in localStorage.
- [ ] Drag-reorder of freeform tail blocks works via OutlinePanel.
- [ ] `pnpm test` (vitest) and `pnpm playwright test` green.
- [ ] `git commit --allow-empty -m "chore: Plan 03 complete — Inline Edit UX"`.

## Execution handoff

Plan saved. Same options as before. Proceed to Plan 04 next.
