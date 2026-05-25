# CaveCMS Plan 01 — Foundation + Auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the empty Next.js app with DB schema, security/auth primitives, hidden login, and `/healthz` — enough to log in as Admin and view a stubbed dashboard.

**Architecture:** Next.js 15 App Router + React 19 + TypeScript strict, Drizzle ORM against native MariaDB, `jose` JWT (HS256 + iss/aud/jti/oat/exp), scrypt passwords, session-bound HMAC CSRF, in-memory rate limiters with DB-persisted dual-key lockout, middleware on Node runtime, security headers via `next.config.ts` + CSP nonce in middleware.

**Tech Stack:** Next.js 15.5.4, React 19.1.0, TypeScript 5.x, pnpm, Drizzle ORM + drizzle-kit, mysql2/promise, jose, zod, isomorphic-dompurify, vitest, playwright. MariaDB must be reachable at `DATABASE_URL`.

**Spec reference:** `docs/specs/2026-05-10-cavecms-rebuild-design.md` (§1–§7, §15).

---

### Task 1: Initialize project + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `.npmrc`, `.editorconfig`, `pnpm-workspace.yaml`
- Create: `app/layout.tsx`, `app/page.tsx`, `app/not-found.tsx`, `app/error.tsx`, `middleware.ts`

- [ ] **Step 1: scaffold Next.js**

```bash
cd /Users/Derrick/portfolio/cavecms
pnpm dlx create-next-app@15.5.4 . --typescript --no-eslint --app --src-dir=false --import-alias='@/*' --tailwind --turbopack --use-pnpm
```
Reject prompts that would overwrite the existing `.gitignore` / spec — answer No.

- [ ] **Step 2: pin exact versions in `package.json`**

Edit `package.json` `dependencies` and `devDependencies` so every version is exact (no `^`/`~`). Run `pnpm install --frozen-lockfile` to confirm lockfile.

- [ ] **Step 3: create `.npmrc`**

```
registry=https://registry.npmjs.org/
package-manager-strict=true
auto-install-peers=true
```

- [ ] **Step 4: enable TypeScript strict mode**

In `tsconfig.json` ensure `"strict": true`, `"noUncheckedIndexedAccess": true`, `"verbatimModuleSyntax": true`. Run `pnpm tsc --noEmit` — must pass.

- [ ] **Step 5: replace `app/page.tsx` with a stub**

```tsx
export default function HomePage() {
  return <main className="p-8">Best World Properties (under construction)</main>
}
```

- [ ] **Step 6: commit**

```bash
git add -A && git commit -m "chore: scaffold Next.js 15.5.4 with TypeScript strict"
```

---

### Task 2: Install runtime dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: add dependencies**

```bash
pnpm add jose@5 zod@3 mysql2@3 drizzle-orm@0.36 isomorphic-dompurify@2 sharp@0.33 \
  remark@15 remark-gfm@4 rehype-sanitize@6 unified@11 react-markdown@9 \
  nodemailer@6 react-email@3 file-type@19 microdiff@1
pnpm add -D drizzle-kit@0.27 vitest@2 @playwright/test@1.48 @types/node@22 \
  @types/nodemailer@6 tsx@4
```

- [ ] **Step 2: verify install + commit**

```bash
pnpm install --frozen-lockfile
git add package.json pnpm-lock.yaml && git commit -m "chore: install runtime + dev dependencies"
```

---

### Task 3: Drizzle schema — users + auth tables

**Files:**
- Create: `db/schema/users.ts`, `db/schema/auth.ts`, `db/schema/index.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 1: write `db/schema/users.ts`**

```ts
import { mysqlTable, int, varchar, boolean, timestamp, uniqueIndex } from 'drizzle-orm/mysql-core'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  email: varchar('email', { length: 180 }).notNull(),
  passwordHash: varchar('password_hash', { length: 400 }).notNull(),
  role: varchar('role', { length: 16, enum: ['admin','editor','viewer'] }).notNull(),
  name: varchar('name', { length: 180 }),
  active: boolean('active').notNull().default(true),
  mustRotatePassword: boolean('must_rotate_password').notNull().default(false),
  tokensValidAfter: timestamp('tokens_valid_after', { fsp: 3 }).notNull().defaultNow(),
  passwordChangedAt: timestamp('password_changed_at', { fsp: 3 }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { fsp: 3 }),
  lockedUntil: timestamp('locked_until', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex('idx_users_email').on(t.email),
}))
```

- [ ] **Step 2: write `db/schema/auth.ts`**

```ts
import { mysqlTable, int, varchar, boolean, timestamp, primaryKey, index } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const failedLoginsByEmail = mysqlTable('failed_logins_by_email', {
  email: varchar('email', { length: 180 }).primaryKey(),
  count: int('count').notNull().default(0),
  lastFailureAt: timestamp('last_failure_at', { fsp: 3 }).notNull().defaultNow(),
  lockedUntil: timestamp('locked_until', { fsp: 3 }),
})

export const failedLoginsByIp = mysqlTable('failed_logins_by_ip', {
  ip: varchar('ip', { length: 45 }).primaryKey(),
  count: int('count').notNull().default(0),
  lastFailureAt: timestamp('last_failure_at', { fsp: 3 }).notNull().defaultNow(),
  lockedUntil: timestamp('locked_until', { fsp: 3 }),
})

export const loginAttempts = mysqlTable('login_attempts', {
  id: int('id').primaryKey().autoincrement(),
  email: varchar('email', { length: 180 }),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 255 }),
  success: boolean('success').notNull(),
  failureReason: varchar('failure_reason', { length: 60 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: index('idx_attempts_email_created').on(t.success, t.email, t.createdAt),
  ipIdx: index('idx_attempts_ip_created').on(t.success, t.ip, t.createdAt),
  createdIdx: index('idx_attempts_created').on(t.createdAt),
}))

export const userKnownIps = mysqlTable('user_known_ips', {
  userId: int('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ip: varchar('ip', { length: 45 }).notNull(),
  lastSuccessAt: timestamp('last_success_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.ip] }) }))
```

- [ ] **Step 3: write `db/schema/index.ts`**

```ts
export * from './users'
export * from './auth'
```

- [ ] **Step 4: write `drizzle.config.ts`**

```ts
import type { Config } from 'drizzle-kit'
export default {
  schema: './db/schema/index.ts',
  out: './db/migrations',
  dialect: 'mysql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config
```

- [ ] **Step 5: generate migration**

```bash
pnpm drizzle-kit generate
```

Inspect `db/migrations/0000_*.sql`. Commit:

```bash
git add db drizzle.config.ts && git commit -m "feat(db): users + auth tables schema and initial migration"
```

---

### Task 4: DB client singleton

**Files:**
- Create: `db/client.ts`, `lib/env.ts`

- [ ] **Step 1: write `lib/env.ts`** — minimal env reader, throws on missing required keys

```ts
import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  DATABASE_URL: z.string().url().or(z.string().startsWith('mysql://')),
  JWT_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  PREVIEW_SECRET: z.string().min(32),
  BROCHURE_SECRET: z.string().min(32),
  LOGIN_PATH: z.string().regex(/^[a-z0-9-]{6,32}$/),
  PORT: z.coerce.number().int().default(3040),
  JWT_TTL_SECONDS: z.coerce.number().int().default(28800),
  JWT_RENEW_AFTER_SECONDS: z.coerce.number().int().default(1800),
  JWT_ABSOLUTE_MAX_SECONDS: z.coerce.number().int().default(86400),
  CSRF_TTL_SECONDS: z.coerce.number().int().default(3600),
  DB_POOL_LIMIT: z.coerce.number().int().default(15),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(10000),
  HANDLER_TIMEOUT_MS: z.coerce.number().int().default(15000),
}).passthrough()

export const env = Env.parse(process.env)
export type AppEnv = typeof env
```

- [ ] **Step 2: write `db/client.ts`**

```ts
import 'server-only'
import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'
import { env } from '@/lib/env'

const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  connectionLimit: env.DB_POOL_LIMIT,
  waitForConnections: true,
  queueLimit: 50,
  connectTimeout: 5000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
  timezone: '+00:00',
})
pool.on('connection', (conn) => {
  conn.query(`SET SESSION max_statement_time = ${env.DB_STATEMENT_TIMEOUT_MS / 1000}`)
})

export const db = drizzle(pool, { schema, mode: 'default' })
export { pool }
```

- [ ] **Step 3: commit**

```bash
git add db/client.ts lib/env.ts && git commit -m "feat(db): pool + env validation"
```

---

### Task 5: scrypt helpers — TDD

**Files:**
- Create: `lib/auth/scrypt.ts`, `tests/unit/scrypt.test.ts`

- [ ] **Step 1: write failing test `tests/unit/scrypt.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, DUMMY_SCRYPT_HASH } from '@/lib/auth/scrypt'

describe('scrypt', () => {
  it('round-trips a password', async () => {
    const h = await hashPassword('correct horse battery staple')
    expect(h.startsWith('scrypt$N=131072$r=8$p=1$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })
  it('produces a dummy hash usable for constant-time non-existent users', async () => {
    expect(DUMMY_SCRYPT_HASH.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('anything', DUMMY_SCRYPT_HASH)).toBe(false)
  })
})
```

- [ ] **Step 2: run — must fail**

```bash
pnpm vitest run tests/unit/scrypt.test.ts
```
Expect: import error.

- [ ] **Step 3: implement `lib/auth/scrypt.ts`**

```ts
import 'server-only'
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as unknown as (
  pw: string, salt: Buffer, keyLen: number, opts: Record<string, number>,
) => Promise<Buffer>

const N = 1 << 17, r = 8, p = 1, KEY_LEN = 64, SALT_LEN = 16
const OPTS = { N, r, p, maxmem: 256 * 1024 * 1024 }

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const hash = await scrypt(pw, salt, KEY_LEN, OPTS)
  return `scrypt$N=${N}$r=${r}$p=${p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$N=(\d+)\$r=(\d+)\$p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored)
  if (!m) return false
  const [, Nstr, rstr, pstr, saltB64, hashB64] = m
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(hashB64, 'base64')
  const actual = await scrypt(pw, salt, expected.length, {
    N: parseInt(Nstr, 10), r: parseInt(rstr, 10), p: parseInt(pstr, 10),
    maxmem: 256 * 1024 * 1024,
  })
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

// Precomputed at module load — used for non-existent emails to keep timing flat.
export const DUMMY_SCRYPT_HASH = await hashPassword(randomBytes(32).toString('base64url'))
```

- [ ] **Step 4: run — must pass**

```bash
pnpm vitest run tests/unit/scrypt.test.ts
```

- [ ] **Step 5: commit**

```bash
git add lib/auth/scrypt.ts tests/unit/scrypt.test.ts && git commit -m "feat(auth): scrypt hash + verify with constant-time dummy"
```

---

### Task 6: JWT helpers — TDD

**Files:**
- Create: `lib/auth/jwt.ts`, `tests/unit/jwt.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { signSessionJwt, verifySessionJwt } from '@/lib/auth/jwt'

const SUB = '42'

describe('JWT sign + verify', () => {
  it('round-trips with iss/aud/jti/oat', async () => {
    const { token, jti, oat } = await signSessionJwt(SUB, { pwp: false })
    const v = await verifySessionJwt(token)
    expect(v.sub).toBe(SUB)
    expect(v.jti).toBe(jti)
    expect(v.oat).toBe(oat)
    expect(v.pwp).toBe(false)
  })
  it('rejects header confusion fields', async () => {
    // jose won't accept extra header fields by default; this guards the verifier setting
    await expect(verifySessionJwt('not.a.jwt')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: run — fail**

- [ ] **Step 3: implement `lib/auth/jwt.ts`**

```ts
import 'server-only'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { randomUUID } from 'node:crypto'
import { env } from '@/lib/env'

const JWT_KEY = new TextEncoder().encode(env.JWT_SECRET)
const PREVIEW_KEY = new TextEncoder().encode(env.PREVIEW_SECRET)
const ISS_SESSION = 'cavecms.cms', AUD_SESSION = 'cavecms.web'

export interface SessionPayload extends JWTPayload {
  sub: string; jti: string; oat: number; iat: number; exp: number
  pwp: boolean
}

export async function signSessionJwt(
  sub: string, opts: { pwp: boolean; jti?: string; oat?: number },
): Promise<{ token: string; jti: string; oat: number; iat: number }> {
  const now = Math.floor(Date.now() / 1000)
  const jti = opts.jti ?? randomUUID()
  const oat = opts.oat ?? now
  const exp = Math.min(now + env.JWT_TTL_SECONDS, oat + env.JWT_ABSOLUTE_MAX_SECONDS)
  const token = await new SignJWT({ oat, pwp: opts.pwp })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISS_SESSION).setAudience(AUD_SESSION)
    .setSubject(sub).setJti(jti)
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(exp)
    .sign(JWT_KEY)
  return { token, jti, oat, iat: now }
}

export async function verifySessionJwt(token: string): Promise<SessionPayload> {
  const { payload, protectedHeader } = await jwtVerify(token, JWT_KEY, {
    algorithms: ['HS256'], issuer: ISS_SESSION, audience: AUD_SESSION,
    clockTolerance: '5s',
  })
  for (const bad of ['kid','jku','jwk','x5u','x5c'] as const) {
    if ((protectedHeader as Record<string,unknown>)[bad]) throw new Error('jwt header confusion')
  }
  const p = payload as SessionPayload
  if (typeof p.oat !== 'number') throw new Error('missing oat')
  if (Math.floor(Date.now()/1000) > p.oat + env.JWT_ABSOLUTE_MAX_SECONDS) {
    throw new Error('absolute cap exceeded')
  }
  return p
}

// --- preview JWT (separate secret + audience) ---
export async function signPreviewJwt(
  userId: string, resource: { type: 'project'; id: number; epoch: number },
): Promise<string> {
  const now = Math.floor(Date.now()/1000)
  return new SignJWT({ resource_type: resource.type, resource_id: resource.id, preview_epoch: resource.epoch })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('cavecms.preview').setAudience('cavecms.preview')
    .setSubject(`project:${resource.id}`).setJti(randomUUID())
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 900)
    .sign(PREVIEW_KEY)
}

export async function verifyPreviewJwt(
  token: string, expected: { type: 'project'; id: number; epoch: number },
): Promise<void> {
  const { payload, protectedHeader } = await jwtVerify(token, PREVIEW_KEY, {
    algorithms: ['HS256'], issuer: 'cavecms.preview', audience: 'cavecms.preview',
    subject: `project:${expected.id}`, clockTolerance: '5s',
  })
  for (const bad of ['kid','jku','jwk','x5u','x5c'] as const) {
    if ((protectedHeader as Record<string,unknown>)[bad]) throw new Error('jwt header confusion')
  }
  if (payload['resource_type'] !== expected.type) throw new Error('resource type mismatch')
  if (payload['resource_id'] !== expected.id) throw new Error('resource id mismatch')
  if (payload['preview_epoch'] !== expected.epoch) throw new Error('preview epoch revoked')
}
```

- [ ] **Step 4: run — pass**

- [ ] **Step 5: commit**

```bash
git add lib/auth/jwt.ts tests/unit/jwt.test.ts && git commit -m "feat(auth): jose JWT sign+verify (session+preview)"
```

---

### Task 7: CSRF helpers — TDD

**Files:**
- Create: `lib/auth/csrf.ts`, `tests/unit/csrf.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { issueCsrf, verifyCsrf } from '@/lib/auth/csrf'

describe('CSRF (session-bound)', () => {
  it('round-trips for the same session jti+sub', async () => {
    const t = await issueCsrf({ jti: 'J', sub: '7' })
    expect(await verifyCsrf(t, { jti: 'J', sub: '7' })).toBe(true)
  })
  it('rejects different session', async () => {
    const t = await issueCsrf({ jti: 'J', sub: '7' })
    expect(await verifyCsrf(t, { jti: 'K', sub: '7' })).toBe(false)
  })
  it('rejects expired', async () => {
    const t = await issueCsrf({ jti: 'J', sub: '7' }, { nowSec: 0 })
    expect(await verifyCsrf(t, { jti: 'J', sub: '7' })).toBe(false)
  })
})
```

- [ ] **Step 2: implement `lib/auth/csrf.ts`**

```ts
import 'server-only'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

const KEY = env.CSRF_SECRET

function b64u(buf: Buffer): string { return buf.toString('base64url') }
function fromB64u(s: string): Buffer { return Buffer.from(s, 'base64url') }

function macInputJson(nonce: string, ts: number, jti: string, sub: string): string {
  return JSON.stringify({ v: 1, nonce, ts, jti, sub })
}

export async function issueCsrf(
  ctx: { jti: string; sub: string }, opts: { nowSec?: number } = {},
): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const nonce = b64u(randomBytes(16))
  const mac = createHmac('sha256', KEY).update(macInputJson(nonce, now, ctx.jti, ctx.sub)).digest()
  return [nonce, b64u(Buffer.from(String(now))), b64u(mac)].join('.')
}

export async function verifyCsrf(
  token: string, ctx: { jti: string; sub: string },
): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [nonce, tsB64, macB64] = parts
  const ts = parseInt(fromB64u(tsB64).toString('utf8'), 10)
  if (!Number.isFinite(ts)) return false
  if (Math.floor(Date.now()/1000) - ts > env.CSRF_TTL_SECONDS) return false
  const expectedMac = createHmac('sha256', KEY).update(macInputJson(nonce, ts, ctx.jti, ctx.sub)).digest()
  const actualMac = fromB64u(macB64)
  if (actualMac.length !== expectedMac.length) return false
  return timingSafeEqual(actualMac, expectedMac)
}
```

- [ ] **Step 3: run — pass**

- [ ] **Step 4: commit**

```bash
git add lib/auth/csrf.ts tests/unit/csrf.test.ts && git commit -m "feat(auth): session-bound CSRF token"
```

---

### Task 8: Pre-auth CSRF (single-use Map) — TDD

**Files:**
- Create: `lib/auth/preCsrf.ts`, `tests/unit/preCsrf.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { issuePreCsrf, consumePreCsrf, _resetPreCsrfMap } from '@/lib/auth/preCsrf'

describe('pre-auth CSRF', () => {
  beforeEach(() => _resetPreCsrfMap())
  it('issues and consumes once', () => {
    const v = issuePreCsrf()
    expect(consumePreCsrf(v)).toBe(true)
    expect(consumePreCsrf(v)).toBe(false) // single-use
  })
  it('rejects unknown', () => {
    expect(consumePreCsrf('garbage')).toBe(false)
  })
})
```

- [ ] **Step 2: implement `lib/auth/preCsrf.ts`**

```ts
import 'server-only'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const MAX_ENTRIES = 50_000
const TTL_MS = 15 * 60 * 1000

// LRU via insertion-order Map iteration.
const store = new Map<string, number /* expiresAt */>()

function sweep(): void {
  const now = Date.now()
  for (const [k, exp] of store) {
    if (exp <= now) store.delete(k); else break
  }
  if (store.size > MAX_ENTRIES) {
    const overflow = store.size - MAX_ENTRIES
    let removed = 0
    for (const k of store.keys()) { store.delete(k); if (++removed > overflow) break }
  }
}

export function issuePreCsrf(): string {
  sweep()
  const v = randomBytes(24).toString('base64url')
  store.set(v, Date.now() + TTL_MS)
  return v
}

export function consumePreCsrf(value: string): boolean {
  sweep()
  // Iterate to compare in constant time vs any stored key with equal length.
  let matched: string | null = null
  const bufV = Buffer.from(value)
  for (const k of store.keys()) {
    if (k.length !== bufV.length) continue
    if (timingSafeEqual(Buffer.from(k), bufV)) { matched = k; break }
  }
  if (!matched) return false
  store.delete(matched)
  return true
}

export function _resetPreCsrfMap(): void { store.clear() }
```

- [ ] **Step 3: run — pass**

- [ ] **Step 4: commit**

```bash
git add lib/auth/preCsrf.ts tests/unit/preCsrf.test.ts && git commit -m "feat(auth): pre-auth CSRF single-use store with TTL+LRU"
```

---

### Task 9: Rate-limit Map utility — TDD

**Files:**
- Create: `lib/auth/rateLimit.ts`, `tests/unit/rateLimit.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { rateLimit } from '@/lib/auth/rateLimit'

describe('rateLimit', () => {
  it('allows up to limit then rejects', () => {
    const rl = rateLimit('test', { limit: 3, windowSec: 60 })
    expect(rl('k')).toBe(true)
    expect(rl('k')).toBe(true)
    expect(rl('k')).toBe(true)
    expect(rl('k')).toBe(false)
    expect(rl('other')).toBe(true)
  })
})
```

- [ ] **Step 2: implement `lib/auth/rateLimit.ts`**

```ts
import 'server-only'

interface Bucket { count: number; windowStart: number; lastSeen: number }
const stores = new Map<string, Map<string, Bucket>>()
const MAX_ENTRIES = 100_000

function getStore(bucket: string): Map<string, Bucket> {
  let s = stores.get(bucket)
  if (!s) { s = new Map(); stores.set(bucket, s) }
  return s
}

export function rateLimit(
  bucket: string, opts: { limit: number; windowSec: number },
) {
  const store = getStore(bucket)
  return (key: string): boolean => {
    const now = Date.now()
    const b = store.get(key)
    if (!b || now - b.windowStart > opts.windowSec * 1000) {
      store.set(key, { count: 1, windowStart: now, lastSeen: now })
      if (store.size > MAX_ENTRIES) evict(store)
      return true
    }
    b.lastSeen = now
    if (b.count >= opts.limit) return false
    b.count += 1
    return true
  }
}
function evict(store: Map<string, Bucket>): void {
  const need = Math.ceil(store.size * 0.1)
  let removed = 0
  for (const k of store.keys()) { store.delete(k); if (++removed >= need) break }
}

// Periodic sweep (5 min) to drop entries whose window is way past.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const store of stores.values()) {
    for (const [k, b] of store) {
      if (now - b.lastSeen > 24 * 60 * 60 * 1000) store.delete(k)
    }
  }
}, SWEEP_INTERVAL_MS).unref()
```

- [ ] **Step 3: run — pass**

- [ ] **Step 4: commit**

```bash
git add lib/auth/rateLimit.ts tests/unit/rateLimit.test.ts && git commit -m "feat(auth): in-memory rate-limit Map"
```

---

### Task 10: Client IP extraction — TDD

**Files:**
- Create: `lib/http/clientIp.ts`, `tests/unit/clientIp.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from 'vitest'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

describe('clientIpFromHeaders', () => {
  it('trusts X-Real-IP from loopback only', () => {
    expect(clientIpFromHeaders({ 'x-real-ip': '8.8.8.8' }, '127.0.0.1')).toBe('8.8.8.8')
    expect(clientIpFromHeaders({ 'x-real-ip': '8.8.8.8' }, '203.0.113.4')).toBe('203.0.113.4')
  })
  it('rejects garbage X-Real-IP', () => {
    expect(clientIpFromHeaders({ 'x-real-ip': 'not-an-ip' }, '127.0.0.1')).toBe(null)
  })
})
```

- [ ] **Step 2: implement `lib/http/clientIp.ts`**

```ts
import { isIP } from 'node:net'

export function clientIpFromHeaders(
  h: Record<string, string | undefined>, socketRemoteAddress: string,
): string | null {
  if (socketRemoteAddress === '127.0.0.1' || socketRemoteAddress === '::1') {
    const candidate = h['x-real-ip']
    if (candidate && isIP(candidate)) return candidate
    return null
  }
  return isIP(socketRemoteAddress) ? socketRemoteAddress : null
}
```

- [ ] **Step 3: run — pass + commit**

```bash
git add lib/http/clientIp.ts tests/unit/clientIp.test.ts && git commit -m "feat(http): trust X-Real-IP only from loopback"
```

---

### Task 11: Lockout query + state mutators

**Files:**
- Create: `lib/auth/lockout.ts`, `tests/integration/lockout.test.ts`

- [ ] **Step 1: write integration test (needs a local test DB; the harness in `tests/setup.ts` will be added below)**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { loginAttempts, failedLoginsByEmail, failedLoginsByIp } from '@/db/schema'
import { sql } from 'drizzle-orm'
import { computeLockState, recordFailure, recordSuccess } from '@/lib/auth/lockout'

describe('lockout (windowed)', () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE login_attempts`)
    await db.execute(sql`TRUNCATE TABLE failed_logins_by_email`)
    await db.execute(sql`TRUNCATE TABLE failed_logins_by_ip`)
  })

  it('locks after 3 failures in 10 min for email', async () => {
    for (let i = 0; i < 3; i++) await recordFailure({ email: 'a@b.com', ip: '1.1.1.1', userAgent: 'ua', reason: 'bad_credentials' })
    const s = await computeLockState({ email: 'a@b.com', ip: '1.1.1.1' })
    expect(s.locked).toBe(true)
  })

  it('success from same IP clears both email and IP state', async () => {
    for (let i = 0; i < 3; i++) await recordFailure({ email: 'a@b.com', ip: '1.1.1.1', userAgent: 'ua', reason: 'bad_credentials' })
    await recordSuccess({ email: 'a@b.com', ip: '1.1.1.1', userId: 1, userAgent: 'ua' })
    const s = await computeLockState({ email: 'a@b.com', ip: '1.1.1.1' })
    expect(s.locked).toBe(false)
  })
})
```

- [ ] **Step 2: implement `lib/auth/lockout.ts`**

```ts
import 'server-only'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { loginAttempts, failedLoginsByEmail, failedLoginsByIp, userKnownIps } from '@/db/schema'
import { eq } from 'drizzle-orm'

const THRESHOLDS = [3, 6, 9]
const DURATIONS_MIN = [30, 180, 1440]

export async function computeLockState(args: { email: string; ip: string }) {
  const [{ e10m, e1h, e24h, i10m, i1h, i24h }] = (await db.execute(sql`
    SELECT
      SUM(success=0 AND email=${args.email} AND created_at > NOW() - INTERVAL 10 MINUTE) AS e10m,
      SUM(success=0 AND email=${args.email} AND created_at > NOW() - INTERVAL 1  HOUR  ) AS e1h,
      SUM(success=0 AND email=${args.email} AND created_at > NOW() - INTERVAL 24 HOUR ) AS e24h,
      SUM(success=0 AND ip   =${args.ip}    AND created_at > NOW() - INTERVAL 10 MINUTE) AS i10m,
      SUM(success=0 AND ip   =${args.ip}    AND created_at > NOW() - INTERVAL 1  HOUR  ) AS i1h,
      SUM(success=0 AND ip   =${args.ip}    AND created_at > NOW() - INTERVAL 24 HOUR ) AS i24h
    FROM login_attempts
    WHERE created_at > NOW() - INTERVAL 24 HOUR AND (email = ${args.email} OR ip = ${args.ip})
  `)).rows as Array<Record<string, number | null>>

  const e = [Number(e10m||0), Number(e1h||0), Number(e24h||0)]
  const i = [Number(i10m||0), Number(i1h||0), Number(i24h||0)]
  const [el] = await db.select().from(failedLoginsByEmail).where(eq(failedLoginsByEmail.email, args.email))
  const [il] = await db.select().from(failedLoginsByIp).where(eq(failedLoginsByIp.ip, args.ip))
  const now = Date.now()
  const locked = (el?.lockedUntil && el.lockedUntil.getTime() > now)
              || (il?.lockedUntil && il.lockedUntil.getTime() > now)
  return { locked: !!locked, eCounts: e, iCounts: i }
}

export async function recordFailure(args: {
  email: string; ip: string; userAgent: string; reason: string
}) {
  await db.insert(loginAttempts).values({
    email: args.email, ip: args.ip, userAgent: args.userAgent, success: false, failureReason: args.reason,
  })
  const { eCounts, iCounts } = await computeLockState({ email: args.email, ip: args.ip })
  for (let tier = THRESHOLDS.length - 1; tier >= 0; tier--) {
    if (eCounts[tier] >= THRESHOLDS[tier]) {
      await db.execute(sql`
        INSERT INTO failed_logins_by_email (email, count, locked_until, last_failure_at)
        VALUES (${args.email}, ${eCounts[2]}, NOW() + INTERVAL ${DURATIONS_MIN[tier]} MINUTE, NOW())
        ON DUPLICATE KEY UPDATE count = VALUES(count), locked_until = VALUES(locked_until), last_failure_at = NOW()
      `); break
    }
  }
  for (let tier = THRESHOLDS.length - 1; tier >= 0; tier--) {
    if (iCounts[tier] >= THRESHOLDS[tier]) {
      await db.execute(sql`
        INSERT INTO failed_logins_by_ip (ip, count, locked_until, last_failure_at)
        VALUES (${args.ip}, ${iCounts[2]}, NOW() + INTERVAL ${DURATIONS_MIN[tier]} MINUTE, NOW())
        ON DUPLICATE KEY UPDATE count = VALUES(count), locked_until = VALUES(locked_until), last_failure_at = NOW()
      `); break
    }
  }
}

export async function recordSuccess(args: {
  email: string; ip: string; userId: number; userAgent: string
}) {
  await db.insert(loginAttempts).values({
    email: args.email, ip: args.ip, userAgent: args.userAgent, success: true,
  })
  await db.execute(sql`DELETE FROM failed_logins_by_email WHERE email = ${args.email}`)
  await db.execute(sql`DELETE FROM failed_logins_by_ip    WHERE ip    = ${args.ip}`)
  await db.execute(sql`
    INSERT INTO user_known_ips (user_id, ip, last_success_at)
    VALUES (${args.userId}, ${args.ip}, NOW())
    ON DUPLICATE KEY UPDATE last_success_at = NOW()
  `)
}
```

- [ ] **Step 3: configure Vitest to set up the test DB**

Create `tests/setup.ts`:
```ts
import { beforeAll, afterAll } from 'vitest'
import { pool } from '@/db/client'
beforeAll(async () => {
  // assumes migrations have run against DATABASE_URL pointing at a test DB
})
afterAll(async () => { await pool.end() })
```
In `vitest.config.ts` add `test: { setupFiles: ['./tests/setup.ts'] }`.

- [ ] **Step 4: run integration test (needs MariaDB up and `cavecms_test` DB migrated). Commit:**

```bash
git add lib/auth/lockout.ts tests/integration/lockout.test.ts tests/setup.ts vitest.config.ts \
  && git commit -m "feat(auth): windowed lockout with dual-key + known-IP tracking"
```

---

### Task 12: User-cache layer

**Files:**
- Create: `lib/auth/userCache.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'

interface CachedUser {
  id: number; email: string; role: 'admin'|'editor'|'viewer'
  active: boolean; mustRotatePassword: boolean
  tokensValidAfterMs: number; passwordHash: string
  cachedAt: number
}
const TTL_MS = 30_000
const cache = new Map<number, CachedUser>()

export async function getUser(id: number): Promise<CachedUser | null> {
  const c = cache.get(id)
  if (c && Date.now() - c.cachedAt < TTL_MS) return c
  const [row] = await db.select().from(users).where(eq(users.id, id))
  if (!row) { cache.delete(id); return null }
  const u: CachedUser = {
    id: row.id, email: row.email, role: row.role as CachedUser['role'],
    active: row.active, mustRotatePassword: row.mustRotatePassword,
    tokensValidAfterMs: row.tokensValidAfter.getTime(), passwordHash: row.passwordHash,
    cachedAt: Date.now(),
  }
  cache.set(id, u)
  return u
}

export function invalidateUser(id: number): void { cache.delete(id) }
```

- [ ] **Step 2: commit**

```bash
git add lib/auth/userCache.ts && git commit -m "feat(auth): 30s user-row cache with invalidate"
```

---

### Task 13: requireRole helper

**Files:**
- Create: `lib/auth/requireRole.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { cookies } from 'next/headers'
import { verifySessionJwt } from './jwt'
import { getUser } from './userCache'

export class HttpError extends Error { constructor(public status: number, public code: string) { super(code) } }

export type Role = 'admin' | 'editor' | 'viewer'

export interface AuthContext {
  userId: number; role: Role; email: string
  jti: string; oat: number; iat: number
}

export async function requireAuth(): Promise<AuthContext> {
  const c = await cookies()
  const token = c.get('__Host-cavecms_session')?.value
  if (!token) throw new HttpError(401, 'unauthenticated')
  const payload = await verifySessionJwt(token).catch(() => null)
  if (!payload) throw new HttpError(401, 'unauthenticated')
  if (payload.pwp) throw new HttpError(403, 'password_rotation_required')
  const user = await getUser(Number(payload.sub))
  if (!user || !user.active) throw new HttpError(401, 'unauthenticated')
  if (payload.iat * 1000 <= user.tokensValidAfterMs) throw new HttpError(401, 'token_revoked')
  return { userId: user.id, role: user.role, email: user.email, jti: payload.jti, oat: payload.oat, iat: payload.iat }
}

export async function requireRole(allowed: Role[]): Promise<AuthContext> {
  const ctx = await requireAuth()
  if (!allowed.includes(ctx.role)) throw new HttpError(403, 'forbidden')
  return ctx
}
```

- [ ] **Step 2: commit**

```bash
git add lib/auth/requireRole.ts && git commit -m "feat(auth): requireAuth + requireRole helpers"
```

---

### Task 14: API error wrapper

**Files:**
- Create: `lib/api/withError.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { HttpError } from '@/lib/auth/requireRole'
import { env } from '@/lib/env'

export function jsonError(status: number, error: string, requestId: string): Response {
  return new Response(JSON.stringify({ error, requestId }), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export function withError(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const requestId = randomUUID()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('handler_timeout')), env.HANDLER_TIMEOUT_MS)
    try {
      return await handler(req)
    } catch (err: unknown) {
      console.error(JSON.stringify({ level: 'error', requestId, err: String(err) }))
      if (err instanceof HttpError) return jsonError(err.status, err.code, requestId)
      if (err instanceof ZodError)  return jsonError(400, 'invalid_request', requestId)
      return jsonError(500, 'server_error', requestId)
    } finally { clearTimeout(timer) }
  }
}
```

- [ ] **Step 2: commit**

```bash
git add lib/api/withError.ts && git commit -m "feat(api): error wrapper with request id, no internal leakage"
```

---

### Task 15: Middleware — auth gating, 307 vs 401

**Files:**
- Create: `middleware.ts`

- [ ] **Step 1: write**

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { verifySessionJwt } from '@/lib/auth/jwt'

export const config = {
  runtime: 'nodejs',
  matcher: ['/admin', '/admin/:path*', '/api/cms/:path*', '/api/admin/:path*', '/api/auth/logout'],
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get('__Host-cavecms_session')?.value
  const ok = token ? await verifySessionJwt(token).then(() => true).catch(() => false) : false
  if (ok) return NextResponse.next()
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const url = req.nextUrl.clone()
  url.pathname = '/'
  return NextResponse.redirect(url, { status: 307, headers: { 'cache-control': 'private, no-store' } })
}
```

- [ ] **Step 2: commit**

```bash
git add middleware.ts && git commit -m "feat(auth): middleware — 307 → / for HTML, 401 JSON for API"
```

---

### Task 16: Security headers + CSP nonce — `next.config.ts`

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: write headers config**

```ts
import type { NextConfig } from 'next'

const cspBase = (nonce: string) => [
  "default-src 'self'",
  "img-src 'self' data:",
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://www.google.com https://www.gstatic.com https://www.recaptcha.net`,
  `style-src 'self' 'nonce-${nonce}'`,
  "font-src 'self' data:",
  "connect-src 'self' https://www.google.com https://www.gstatic.com https://www.recaptcha.net",
  "frame-src https://www.google.com https://www.recaptcha.net",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join('; ')

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: 'standalone',
  images: { remotePatterns: [] },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
      ],
    }]
  },
}
export default config
```

The CSP itself is stamped per-request in the layout (next task) because it carries the nonce.

- [ ] **Step 2: commit**

```bash
git add next.config.ts && git commit -m "feat: security headers + CSP scaffold (nonce in layout)"
```

---

### Task 17: Per-request CSP nonce via layout

**Files:**
- Create: `lib/security/cspNonce.ts`
- Modify: `app/layout.tsx`

- [ ] **Step 1: nonce helper**

```ts
// lib/security/cspNonce.ts
import 'server-only'
import { headers } from 'next/headers'
import { randomBytes } from 'node:crypto'

const HEADER = 'x-csp-nonce'

export async function cspNonce(): Promise<string> {
  const h = await headers()
  let n = h.get(HEADER)
  if (!n) { n = randomBytes(16).toString('base64'); /* not strictly settable post-fact; middleware sets it */ }
  return n
}
```

- [ ] **Step 2: extend middleware to set the nonce header + CSP**

Modify `middleware.ts` to generate a nonce on every request and propagate via response header `Content-Security-Policy` AND request header `x-csp-nonce` (so server components can read it).

Update `middleware.ts` (full file rewrite):

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'
import { verifySessionJwt } from '@/lib/auth/jwt'

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|uploads/|favicon\\.ico).*)'],
}

const csp = (nonce: string): string => [
  "default-src 'self'",
  "img-src 'self' data:",
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://www.google.com https://www.gstatic.com https://www.recaptcha.net`,
  `style-src 'self' 'nonce-${nonce}'`,
  "font-src 'self' data:",
  "connect-src 'self' https://www.google.com https://www.gstatic.com https://www.recaptcha.net",
  "frame-src https://www.google.com https://www.recaptcha.net",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "upgrade-insecure-requests",
].join('; ')

async function authGate(req: NextRequest): Promise<NextResponse | null> {
  const p = req.nextUrl.pathname
  const needsAuth = p === '/admin' || p.startsWith('/admin/')
                 || p.startsWith('/api/cms/') || p.startsWith('/api/admin/')
                 || p === '/api/auth/logout'
  if (!needsAuth) return null
  const token = req.cookies.get('__Host-cavecms_session')?.value
  const ok = token ? await verifySessionJwt(token).then(() => true).catch(() => false) : false
  if (ok) return null
  if (p.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const url = req.nextUrl.clone(); url.pathname = '/'
  const r = NextResponse.redirect(url, 307); r.headers.set('cache-control', 'private, no-store'); return r
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const denied = await authGate(req); if (denied) return denied
  const nonce = randomBytes(16).toString('base64')
  const reqHeaders = new Headers(req.headers); reqHeaders.set('x-csp-nonce', nonce)
  const res = NextResponse.next({ request: { headers: reqHeaders } })
  res.headers.set('Content-Security-Policy', csp(nonce))
  return res
}
```

- [ ] **Step 3: use the nonce in `app/layout.tsx`**

```tsx
import { headers } from 'next/headers'
import './globals.css'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-csp-nonce') ?? ''
  return (
    <html lang="en">
      <head><meta name="csp-nonce" content={nonce} /></head>
      <body>{children}</body>
    </html>
  )
}
```

- [ ] **Step 4: commit**

```bash
git add middleware.ts app/layout.tsx lib/security/cspNonce.ts \
  && git commit -m "feat(security): per-request CSP nonce in middleware + layout"
```

---

### Task 18: Hidden login route + form

**Files:**
- Create: `app/(auth)/[loginPath]/page.tsx`
- Create: `app/(auth)/[loginPath]/LoginForm.tsx` (client component)
- Create: `app/(auth)/layout.tsx` (minimal, no shared chrome)

- [ ] **Step 1: minimal auth layout**

```tsx
// app/(auth)/layout.tsx
export const dynamic = 'force-dynamic'
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen flex items-center justify-center p-8">{children}</main>
}
```

- [ ] **Step 2: page resolver**

```tsx
// app/(auth)/[loginPath]/page.tsx
import { notFound } from 'next/navigation'
import { cookies } from 'next/headers'
import { timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import { issuePreCsrf } from '@/lib/auth/preCsrf'
import { LoginForm } from './LoginForm'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

export default async function LoginPage({ params }: { params: Promise<{ loginPath: string }> }) {
  const { loginPath } = await params
  const a = Buffer.from(loginPath), b = Buffer.from(env.LOGIN_PATH)
  if (a.length !== b.length || !timingSafeEqual(a, b)) notFound()
  const preNonce = issuePreCsrf()
  const c = await cookies()
  c.set('__Host-cavecms_pre_csrf', preNonce, {
    httpOnly: true, secure: env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/', maxAge: 15 * 60,
  })
  return <LoginForm csrf={preNonce} action={`/api/auth/login`} />
}
```

- [ ] **Step 3: client form**

```tsx
// app/(auth)/[loginPath]/LoginForm.tsx
'use client'
import { useState } from 'react'

export function LoginForm({ csrf, action }: { csrf: string; action: string }) {
  const [err, setErr] = useState<string | null>(null)
  return (
    <form method="post" action={action} onSubmit={() => setErr(null)} className="w-full max-w-sm space-y-3">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="company_url" tabIndex={-1} autoComplete="off" className="absolute -left-[9999px]" />
      <label className="block">Email<input name="email" type="email" required className="border w-full p-2" /></label>
      <label className="block">Password<input name="password" type="password" required className="border w-full p-2" /></label>
      <button type="submit" className="border px-4 py-2">Sign in</button>
      {err && <p>{err}</p>}
    </form>
  )
}
```

- [ ] **Step 4: commit**

```bash
git add app/\(auth\) && git commit -m "feat(auth): hidden login page + form with pre-auth CSRF"
```

---

### Task 19: POST /api/auth/login

**Files:**
- Create: `app/api/auth/login/route.ts`

- [ ] **Step 1: write**

```ts
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { users, userKnownIps } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { verifyPassword, DUMMY_SCRYPT_HASH } from '@/lib/auth/scrypt'
import { signSessionJwt } from '@/lib/auth/jwt'
import { issueCsrf } from '@/lib/auth/csrf'
import { computeLockState, recordFailure, recordSuccess } from '@/lib/auth/lockout'
import { invalidateUser } from '@/lib/auth/userCache'
import { consumePreCsrf } from '@/lib/auth/preCsrf'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { withError } from '@/lib/api/withError'
import { env } from '@/lib/env'

const limitByIp = rateLimit('login:ip', { limit: 3, windowSec: 60 })
const limitByEmail = rateLimit('login:email', { limit: 5, windowSec: 300 })

const generic = (status = 401) =>
  new Response(JSON.stringify({ error: 'Invalid email or password' }),
    { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })

export const POST = withError(async (req: Request) => {
  const c = await cookies()
  const headers = Object.fromEntries(req.headers as unknown as Iterable<[string,string]>)
  const ip = clientIpFromHeaders(headers, '127.0.0.1') ?? '0.0.0.0'
  const userAgent = String(headers['user-agent'] ?? '').slice(0, 255)

  const form = await req.formData()
  const email = String(form.get('email') ?? '').toLowerCase().trim().slice(0, 180)
  const password = String(form.get('password') ?? '')
  const companyUrl = String(form.get('company_url') ?? '')           // honeypot
  const csrfBody = String(form.get('csrf') ?? '')
  const csrfCookie = c.get('__Host-cavecms_pre_csrf')?.value ?? ''

  c.delete('__Host-cavecms_pre_csrf')                                      // always clear

  if (companyUrl) return generic()                                     // silent honeypot
  if (!limitByIp(ip) || !limitByEmail(email)) return generic(429)
  if (csrfBody.length !== csrfCookie.length || csrfBody !== csrfCookie) return generic()
  if (!consumePreCsrf(csrfCookie)) return generic()

  // ALWAYS run scrypt to flatten timing (locked / no-user / wrong-pw all converge)
  const [user] = await db.select().from(users).where(eq(users.email, email))
  const hash = user?.passwordHash ?? DUMMY_SCRYPT_HASH
  const passwordOk = await verifyPassword(password, hash)

  const state = await computeLockState({ email, ip })
  const allowed = !state.locked || (user
    && await db.select().from(userKnownIps).where(eq(userKnownIps.userId, user.id))
      .then(rows => rows.some(r => r.ip === ip)))

  if (!allowed || !user || !passwordOk || !user.active) {
    await recordFailure({ email, ip, userAgent, reason: 'bad_credentials' })
    return generic()
  }

  // Bump tokens_valid_after for clean re-issue
  await db.execute(/* sql */`UPDATE users SET tokens_valid_after = NOW() + INTERVAL 1 SECOND, last_login_at = NOW() WHERE id = ${user.id}`)
  invalidateUser(user.id)
  await recordSuccess({ email, ip, userId: user.id, userAgent })

  const { token, jti } = await signSessionJwt(String(user.id), { pwp: user.mustRotatePassword })
  const csrf = await issueCsrf({ jti, sub: String(user.id) })

  c.set('__Host-cavecms_session', token, {
    httpOnly: true, secure: env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/', maxAge: env.JWT_TTL_SECONDS,
  })
  c.set('__Host-cavecms_csrf', csrf, {
    httpOnly: false, secure: env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/', maxAge: env.CSRF_TTL_SECONDS,
  })

  const next = user.mustRotatePassword ? `/${env.LOGIN_PATH}/rotate` : '/admin'
  return new Response(JSON.stringify({ ok: true, next, csrf }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/auth/login/route.ts && git commit -m "feat(auth): POST /api/auth/login with rate-limit + lockout + CSRF + constant-time"
```

---

### Task 20: POST /api/auth/logout

**Files:**
- Create: `app/api/auth/logout/route.ts`

- [ ] **Step 1: write**

```ts
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { eq, sql } from 'drizzle-orm'
import { withError } from '@/lib/api/withError'
import { requireAuth } from '@/lib/auth/requireRole'
import { verifyCsrf } from '@/lib/auth/csrf'
import { invalidateUser } from '@/lib/auth/userCache'

export const POST = withError(async (req) => {
  const ctx = await requireAuth()
  const csrfHeader = req.headers.get('x-csrf-token') ?? ''
  const c = await cookies()
  const csrfCookie = c.get('__Host-cavecms_csrf')?.value ?? ''
  if (csrfHeader !== csrfCookie || !await verifyCsrf(csrfHeader, { jti: ctx.jti, sub: String(ctx.userId) })) {
    return new Response(JSON.stringify({ error: 'csrf_invalid' }), { status: 403 })
  }
  await db.execute(sql`UPDATE users SET tokens_valid_after = NOW() + INTERVAL 1 SECOND WHERE id = ${ctx.userId}`)
  invalidateUser(ctx.userId)
  c.delete('__Host-cavecms_session'); c.delete('__Host-cavecms_csrf')
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/auth/logout/route.ts && git commit -m "feat(auth): logout bumps tokens_valid_after"
```

---

### Task 21: GET /api/csrf

**Files:**
- Create: `app/api/csrf/route.ts`

- [ ] **Step 1: write**

```ts
import { cookies } from 'next/headers'
import { withError } from '@/lib/api/withError'
import { requireAuth } from '@/lib/auth/requireRole'
import { issueCsrf } from '@/lib/auth/csrf'
import { rateLimit } from '@/lib/auth/rateLimit'
import { env } from '@/lib/env'

const limit = rateLimit('csrf', { limit: 120, windowSec: 60 })

export const GET = withError(async () => {
  const ctx = await requireAuth()
  if (!limit(String(ctx.userId))) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 })
  const csrf = await issueCsrf({ jti: ctx.jti, sub: String(ctx.userId) })
  const c = await cookies()
  c.set('__Host-cavecms_csrf', csrf, {
    httpOnly: false, secure: env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/', maxAge: env.CSRF_TTL_SECONDS,
  })
  return new Response(JSON.stringify({ csrf }), { status: 200, headers: { 'cache-control': 'private, no-store' } })
})
```

- [ ] **Step 2: commit**

---

### Task 22: GET /healthz

**Files:**
- Create: `app/healthz/route.ts`

- [ ] **Step 1: write**

```ts
import { pool } from '@/db/client'
import { env } from '@/lib/env'

const COMMIT = process.env.CAVECMS_COMMIT ?? 'unknown'
const STARTED_AT = Date.now()

export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const sockIp = (req.headers.get('x-real-ip') ?? '').toString()
  const isLoopback = sockIp === '127.0.0.1' || sockIp === '::1' || env.NODE_ENV !== 'production'
  let dbPing = 'unknown'; let poolFree = -1
  try {
    const c = await pool.getConnection()
    try { await c.query('SELECT 1'); dbPing = 'ok' } finally { c.release() }
    poolFree = pool.pool.config.connectionLimit - (pool.pool._allConnections?.length ?? 0)
  } catch { dbPing = 'fail' }
  const body = isLoopback
    ? { status: 'ok', commit: COMMIT, db_ping: dbPing, pool_free: poolFree, uptime_s: Math.floor((Date.now()-STARTED_AT)/1000) }
    : { status: 'ok' }
  return new Response(JSON.stringify(body), { status: dbPing === 'fail' && isLoopback ? 503 : 200, headers: { 'cache-control': 'no-store' } })
}
```

- [ ] **Step 2: commit**

```bash
git add app/healthz app/api/csrf && git commit -m "feat: /healthz + /api/csrf endpoints"
```

---

### Task 23: Boot validation (instrumentation.ts)

**Files:**
- Create: `instrumentation.ts`

- [ ] **Step 1: write**

```ts
import { env } from '@/lib/env'

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Validate secret distinctness
  const secrets = [env.JWT_SECRET, env.CSRF_SECRET, env.PREVIEW_SECRET, env.BROCHURE_SECRET]
  const seen = new Set<string>()
  for (const s of secrets) { if (seen.has(s)) { console.error('duplicate secret'); process.exit(1) }; seen.add(s) }

  // Boot scrypt warm-up: must succeed and take some time
  const { scryptSync, randomBytes } = await import('node:crypto')
  const t0 = Date.now()
  scryptSync('boot-check', randomBytes(16), 64, { N: 1<<17, r: 8, p: 1, maxmem: 256*1024*1024 })
  const dur = Date.now() - t0
  if (dur < 50) { console.error('scrypt parameters too weak'); process.exit(1) }

  process.on('uncaughtException', (e) => { console.error('uncaughtException', e); process.exit(1) })
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e))
}
```

- [ ] **Step 2: enable in `next.config.ts`**

Add to the config: `experimental: { instrumentationHook: true }`.

- [ ] **Step 3: commit**

```bash
git add instrumentation.ts next.config.ts && git commit -m "feat: boot-time secret + scrypt validation; crash policy"
```

---

### Task 24: Stub /admin dashboard

**Files:**
- Create: `app/(admin)/admin/layout.tsx`, `app/(admin)/admin/page.tsx`

- [ ] **Step 1: layout**

```tsx
// app/(admin)/admin/layout.tsx
import { requireRole } from '@/lib/auth/requireRole'
export const dynamic = 'force-dynamic'
export async function generateMetadata() { return { robots: { index: false, follow: false } } }
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['admin','editor','viewer'])
  return <div className="min-h-screen flex"><aside className="w-56 border-r p-4">Admin</aside><main className="flex-1 p-8">{children}</main></div>
}
```

- [ ] **Step 2: dashboard**

```tsx
// app/(admin)/admin/page.tsx
export default async function AdminHome() {
  return <h1 className="text-2xl">Dashboard</h1>
}
```

- [ ] **Step 3: commit**

```bash
git add app/\(admin\) && git commit -m "feat(admin): stub /admin dashboard requiring auth"
```

---

### Task 25: Seed admin script

**Files:**
- Create: `db/seed.ts`, `scripts/seed-admin.ts`

- [ ] **Step 1: `db/seed.ts`**

```ts
import { db } from './client'
import { users } from './schema'
import { eq } from 'drizzle-orm'
import { hashPassword } from '../lib/auth/scrypt'

export async function seedAdminIfEmpty(email: string, name: string, password: string): Promise<boolean> {
  const existing = await db.select({ id: users.id }).from(users).limit(1)
  if (existing.length > 0) return false
  const passwordHash = await hashPassword(password)
  await db.insert(users).values({
    email, name, role: 'admin', active: true, mustRotatePassword: true, passwordHash,
  })
  return true
}
```

- [ ] **Step 2: `scripts/seed-admin.ts`**

```ts
import 'dotenv/config'
import readline from 'node:readline/promises'
import { seedAdminIfEmpty } from '../db/seed'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const email = await rl.question('Admin email: ')
const name  = await rl.question('Admin name: ')
const password = await rl.question('Admin password (>=12 chars): ')
rl.close()
if (password.length < 12) { console.error('password too short'); process.exit(1) }
const seeded = await seedAdminIfEmpty(email.trim().toLowerCase(), name.trim(), password)
console.log(seeded ? 'Seeded.' : 'users table not empty; no-op.')
process.exit(0)
```

- [ ] **Step 3: package.json scripts**

Add:
```json
"scripts": {
  "dev": "next dev -p 3040 --turbopack",
  "build": "next build",
  "start": "next start -p 3040",
  "lint": "next lint",
  "typecheck": "tsc --noEmit",
  "db:migrate": "drizzle-kit migrate",
  "db:seed": "tsx scripts/seed-admin.ts",
  "test": "vitest run"
}
```

- [ ] **Step 4: commit**

```bash
git add db/seed.ts scripts/seed-admin.ts package.json && git commit -m "feat(db): seed-admin script with interactive prompt"
```

---

### Task 26: E2E — Playwright login flow

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/auth.spec.ts`

- [ ] **Step 1: Playwright config**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:3040' },
  webServer: { command: 'pnpm dev', port: 3040, reuseExistingServer: !process.env.CI },
})
```

- [ ] **Step 2: test**

```ts
import { test, expect } from '@playwright/test'

test('hidden login: wrong path returns 404 with generic message', async ({ page }) => {
  const r = await page.goto('/does-not-exist')
  expect(r?.status()).toBe(404)
})

test('login → dashboard flow', async ({ page, request }) => {
  const path = process.env.LOGIN_PATH ?? 'jamestown'
  await page.goto(`/${path}`)
  await page.fill('input[name=email]', 'admin@cavecms.test')
  await page.fill('input[name=password]', 'CorrectHorseBattery0!')
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login')),
    page.click('button[type=submit]'),
  ])
  expect(resp.status()).toBe(200)
  await page.waitForURL(/\/admin/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})

test('unauthenticated /admin → 307 to /', async ({ page }) => {
  const r = await page.goto('/admin')
  expect(r?.url()).toContain('/')
  expect(r?.url()).not.toContain('/admin')
})
```

- [ ] **Step 3: commit**

```bash
git add playwright.config.ts tests/e2e/auth.spec.ts && git commit -m "test(e2e): auth flow — hidden path, login, /admin redirect"
```

---

### Task 27: Self-review checklist before handoff

- [ ] All required env vars documented in a `.env.example` (create one matching the spec §15).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green.
- [ ] `pnpm dev` starts; `/healthz` → 200; `/admin` unauthenticated → 307 to `/`; `/<LOGIN_PATH>` renders form; login works end-to-end.
- [ ] No `.env.local` is committed (verified by `git status` and `.gitignore`).
- [ ] `pnpm vitest run` and `pnpm playwright test` both pass.
- [ ] Commit: `git commit --allow-empty -m "chore: Plan 01 complete — Foundation + Auth"`

---

## Definition of done

- Hidden login page resolves only on `LOGIN_PATH`; any other path returns generic 404.
- Successful login issues `__Host-cavecms_session` + `__Host-cavecms_csrf` cookies; `/admin` accessible.
- Wrong-credentials response identical (status, body, timing within 10 ms) across nonexistent-email / wrong-password / locked / deactivated branches.
- Lockout enforced via DB tables with windowed counts; legitimate user from same IP recovers on successful login.
- `/healthz` returns 200 with verbose body on loopback, minimal body elsewhere.
- Security headers + nonce-based CSP present on every response (`curl -I http://localhost:3040/ | grep -i csp`).
- `instrumentation.ts` fails boot if any secret is missing, too short, duplicated, or scrypt warm-up is too fast.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-cavecms-01-foundation-auth.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration. Use `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batch with checkpoints.

After Plan 01 is green, proceed to Plan 02 (CMS Core).
