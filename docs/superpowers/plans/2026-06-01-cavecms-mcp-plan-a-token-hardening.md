# Plan A — Token Model Hardening (CaveCMS MCP foundation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `cave_` API-token system with a `viewer` role, per-resource scopes, per-token rate limiting, per-token audit attribution, and an admin UI to mint/rotate scoped tokens — so a later MCP server (Plans B/C) can scope agent capabilities precisely, and so direct API tokens already honour least-privilege.

**Architecture:** Additive, back-compatible. A nullable `scopes` JSON column on `api_tokens` (NULL = unrestricted within role, so every already-minted token keeps working). An edge-safe pure predicate (`tokenAllowsScope`) is the single scope source of truth, unit-tested in isolation. Scopes + tokenId are threaded onto the existing `AuthContext`; enforcement is one `requireScope(ctx, resource, action)` call added after the existing `requireRole(...)` at each CMS mutation route, plus a token-keyed rate bucket. Audit rows gain a nullable `token_id` FK. The admin UI gains a visual scope picker, a rotation action, and an MCP connect line in the existing assistant briefing.

**Tech Stack:** Next.js 15 (App Router, Edge middleware + Node route handlers), Drizzle ORM + hand-rolled SQL migrations on MariaDB, `mysql2`, Zod, Vitest (unit), React 19 client components, Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-01-cavecms-mcp-server-design.md` (§5, §9, §10, §11 are the parts this plan implements).

---

## File structure (created / modified)

**Created**
- `db/migrations/0027_api_token_scopes.sql` — ALTER `api_tokens` (+`scopes`) and `audit_log` (+`token_id`).
- `app/api/admin/api-tokens/[id]/rotate/route.ts` — re-issue a token's secret (keep id/name/role/scopes).
- `tests/unit/apiTokenScope.test.ts` — unit tests for the scope predicate.

**Modified**
- `lib/auth/apiTokenScope.ts` — scope vocabulary (`SCOPE_RESOURCES`, `SCOPE_ACTIONS`), `parseScopes`, `tokenAllowsScope`.
- `db/schema/apiTokens.ts` — widen `role` enum to include `viewer`; add `scopes` column.
- `db/schema/audit.ts` — add nullable `tokenId` column.
- `db/migrations/meta/_journal.json` — append the `0027` entry.
- `lib/auth/apiToken.ts` — `verifyApiToken` selects + returns `scopes`; widen `VerifiedApiToken.role`; `listApiTokens` + `ApiTokenListRow` select `scopes`.
- `lib/auth/getSession.ts` — `AuthState.apiTokenScopes`; set it in the token-auth branch.
- `lib/auth/requireRole.ts` — `AuthContext.scopes` + `AuthContext.tokenId`; `requireScope` helper.
- `lib/auth/cmsRateLimit.ts` — token-keyed mutation bucket + `checkCmsMutationRate(ctx)`.
- `app/api/admin/api-tokens/route.ts` — Zod `role` widen + `scopes`; INSERT + response + audit diff.
- The 31 CMS mutation routes (Task 9 table) — swap `checkMutationRate(ctx.userId)` → `checkCmsMutationRate(ctx)` and add `requireScope(ctx, <resource>, <action>)`.
- `lib/cms/saveBlock.ts`, `lib/ai/applyProposal.ts`, `app/api/cms/pages/[id]/batch/route.ts` — thread `tokenId` into audit rows.
- `app/(admin)/admin/settings/api-tokens/ApiTokensClient.tsx` + `page.tsx` — scope picker, rotation button, MCP connect line, scopes in the list row.

---

## Task 1: Scope vocabulary + predicate (pure, edge-safe)

**Files:**
- Modify: `lib/auth/apiTokenScope.ts`
- Test: `tests/unit/apiTokenScope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/apiTokenScope.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseScopes,
  tokenAllowsScope,
  SCOPE_RESOURCES,
  SCOPE_ACTIONS,
} from '@/lib/auth/apiTokenScope'

describe('API token scopes', () => {
  it('exposes the resource + action vocabulary', () => {
    expect(SCOPE_RESOURCES).toContain('pages')
    expect(SCOPE_RESOURCES).toContain('settings')
    expect(SCOPE_ACTIONS).toEqual(['read', 'write', 'delete'])
  })

  it('null scopes = unrestricted (legacy/back-compat token)', () => {
    expect(tokenAllowsScope(null, 'pages', 'delete')).toBe(true)
    expect(tokenAllowsScope(null, 'settings', 'write')).toBe(true)
  })

  it('write implies read for the same resource; delete implies write+read', () => {
    expect(tokenAllowsScope(['pages:write'], 'pages', 'read')).toBe(true)
    expect(tokenAllowsScope(['pages:write'], 'pages', 'write')).toBe(true)
    expect(tokenAllowsScope(['pages:write'], 'pages', 'delete')).toBe(false)
    expect(tokenAllowsScope(['pages:delete'], 'pages', 'write')).toBe(true)
  })

  it('scopes are per-resource — a pages grant does not leak to posts', () => {
    expect(tokenAllowsScope(['pages:write'], 'posts', 'read')).toBe(false)
  })

  it('empty array = no grants = deny everything', () => {
    expect(tokenAllowsScope([], 'pages', 'read')).toBe(false)
  })

  it('parseScopes normalises JSON/array/null and drops garbage', () => {
    expect(parseScopes(null)).toBe(null)
    expect(parseScopes('["pages:write","posts:read"]')).toEqual([
      'pages:write',
      'posts:read',
    ])
    expect(parseScopes(['pages:write', 'bogus', 'pages:fly'])).toEqual([
      'pages:write',
    ])
    expect(parseScopes('not json')).toBe(null)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/apiTokenScope.test.ts`
Expected: FAIL — `parseScopes`/`tokenAllowsScope`/`SCOPE_RESOURCES` are not exported.

- [ ] **Step 3: Implement the vocabulary + predicate**

Append to `lib/auth/apiTokenScope.ts` (keep the existing exports; this file stays edge-safe — NO node imports, NO `server-only`):

```ts
// ── Per-resource scope model ────────────────────────────────────────────
// A token's `scopes` column is either NULL (unrestricted within its role —
// the back-compat default for every token minted before this feature) or a
// JSON array of `"<resource>:<action>"` grants. Action rank is cumulative
// per resource: a `write` grant implies `read`; a `delete` grant implies
// `write` + `read`. Role (admin|editor|viewer) is the ceiling, enforced
// separately by requireRole; scopes only NARROW within the role.

export const SCOPE_RESOURCES = [
  'pages',
  'posts',
  'projects',
  'blocks',
  'media',
  'nav',
  'settings',
] as const
export type ScopeResource = (typeof SCOPE_RESOURCES)[number]

export const SCOPE_ACTIONS = ['read', 'write', 'delete'] as const
export type ScopeAction = (typeof SCOPE_ACTIONS)[number]

const ACTION_RANK: Record<ScopeAction, number> = {
  read: 0,
  write: 1,
  delete: 2,
}

const RESOURCE_SET = new Set<string>(SCOPE_RESOURCES)
const SCOPE_RE = /^([a-z]+):(read|write|delete)$/

// Validates + normalises whatever is stored/sent into a clean grant array,
// or null. Unknown resources/actions are dropped (defense-in-depth — a
// corrupt row or a hand-crafted body can never widen reach). A non-array,
// unparseable, or NULL input returns null = "unrestricted within role".
export function parseScopes(raw: unknown): string[] | null {
  let arr: unknown = raw
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(arr)) return null
  const out: string[] = []
  for (const v of arr) {
    if (typeof v !== 'string') continue
    const m = SCOPE_RE.exec(v)
    if (!m || !RESOURCE_SET.has(m[1]!)) continue
    if (!out.includes(v)) out.push(v)
  }
  return out
}

// The single scope decision. null grants = unrestricted (returns true).
// Otherwise the request's (resource, action) is allowed iff the token holds
// a grant for that resource whose action rank is >= the required rank.
export function tokenAllowsScope(
  scopes: string[] | null,
  resource: ScopeResource,
  action: ScopeAction,
): boolean {
  if (scopes === null) return true
  const need = ACTION_RANK[action]
  let best = -1
  for (const g of scopes) {
    const m = SCOPE_RE.exec(g)
    if (!m || m[1] !== resource) continue
    const rank = ACTION_RANK[m[2] as ScopeAction]
    if (rank > best) best = rank
  }
  return best >= need
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/apiTokenScope.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/apiTokenScope.ts tests/unit/apiTokenScope.test.ts
git commit -m "feat(api-tokens): per-resource scope vocabulary + predicate"
```

---

## Task 2: Migration 0027 — scopes column + audit token_id

**Files:**
- Create: `db/migrations/0027_api_token_scopes.sql`
- Modify: `db/migrations/meta/_journal.json`
- Modify: `db/schema/apiTokens.ts`
- Modify: `db/schema/audit.ts`

- [ ] **Step 1: Write the migration SQL**

Create `db/migrations/0027_api_token_scopes.sql` (tab indent, backticks, mirroring `0026`; `scopes` is `json NULL` so legacy rows read as NULL = unrestricted; `audit_log.token_id` is a nullable FK that nulls on token delete so audit history survives token deletion):

```sql
ALTER TABLE `api_tokens`
	ADD COLUMN `scopes` json NULL DEFAULT NULL;

ALTER TABLE `audit_log`
	ADD COLUMN `token_id` int NULL DEFAULT NULL,
	ADD KEY `idx_audit_log_token` (`token_id`),
	ADD CONSTRAINT `audit_log_token_id_api_tokens_id_fk`
		FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON DELETE SET NULL;
```

- [ ] **Step 2: Append the journal entry**

In `db/migrations/meta/_journal.json`, append to the `entries` array (after the `0026_api_tokens` entry). Use a fixed epoch (do NOT call Date.now() — pick a value greater than the 0026 `when`, e.g. `1780300000000`):

```json
    ,{
      "idx": 27,
      "version": "5",
      "when": 1780300000000,
      "tag": "0027_api_token_scopes",
      "breakpoints": true
    }
```

(No `0027_snapshot.json` — snapshots stopped at 0010; migrations 0011–0026 have none.)

- [ ] **Step 3: Update the Drizzle schema (apiTokens.ts)**

In `db/schema/apiTokens.ts`, import `json` and widen the role enum + add the column:

```ts
import {
  mysqlTable,
  int,
  varchar,
  timestamp,
  datetime,
  json,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core'
```

Change the `role` column enum and add `scopes` after `revokedAt`:

```ts
    role: varchar('role', {
      length: 16,
      enum: ['admin', 'editor', 'viewer'],
    }).notNull(),
```

```ts
    // NULL = unrestricted within role (back-compat default). Otherwise a
    // JSON array of "<resource>:<action>" grants — see lib/auth/apiTokenScope.ts.
    scopes: json('scopes').$type<string[] | null>(),
```

- [ ] **Step 4: Update the Drizzle schema (audit.ts)**

In `db/schema/audit.ts`, add after `userId` (keep `apiTokens` import-free of cycles — reference by name is fine since Drizzle resolves lazily; if a cycle arises, use `int('token_id')` WITHOUT `.references()` and rely on the SQL FK from the migration):

```ts
    // Which API token performed this write (NULL for cookie-session actions).
    // Nulls on token delete so audit history outlives the credential.
    tokenId: int('token_id'),
```

(Use the column WITHOUT a Drizzle `.references()` to avoid an import cycle with `apiTokens`; the FK is declared in the migration SQL and is the source of truth.)

- [ ] **Step 5: Run the migration against the dev DB**

Run: `pnpm db:migrate`
Expected: pre-asserts pass (3/3) → `drizzle-kit migrate` applies `0027` → post-asserts pass (17/17) → fingerprint regenerated. Confirm:

Run: `node -e 'const m=require("mysql2/promise");const u=require("fs").readFileSync(".env.local","utf8").match(/^DATABASE_URL=(.+)$/m)[1].trim();(async()=>{const c=await m.createConnection(u);const [r]=await c.query("SHOW COLUMNS FROM api_tokens LIKE \"scopes\"");console.log(r);const [a]=await c.query("SHOW COLUMNS FROM audit_log LIKE \"token_id\"");console.log(a);await c.end()})()'`
Expected: one row each (`scopes` json YES, `token_id` int YES).

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0027_api_token_scopes.sql db/migrations/meta/_journal.json db/schema/apiTokens.ts db/schema/audit.ts db/schema-fingerprint.txt
git commit -m "feat(db): api_tokens.scopes + audit_log.token_id (migration 0027)"
```

---

## Task 3: verifyApiToken — return scopes, allow viewer

**Files:**
- Modify: `lib/auth/apiToken.ts`

- [ ] **Step 1: Widen the return type + row type**

In `lib/auth/apiToken.ts`, change `VerifiedApiToken` and `TokenRow`:

```ts
import type { Role } from '@/lib/auth/types'
import { API_TOKEN_PREFIX, parseScopes } from '@/lib/auth/apiTokenScope'

export interface VerifiedApiToken {
  tokenId: number
  userId: number
  role: Role
  scopes: string[] | null
}
```

```ts
interface TokenRow {
  id: number
  role: string
  created_by: number
  expires_at: Date | null
  revoked_at: Date | null
  scopes: unknown
}
```

- [ ] **Step 2: Select scopes, allow viewer, return scopes**

Change the SELECT to include `scopes`:

```ts
    ;[rows] = (await db.execute(sql`
      SELECT id, role, created_by, expires_at, revoked_at, scopes
      FROM api_tokens
      WHERE token_hash = ${hash}
      LIMIT 1
    `)) as unknown as [TokenRow[]]
```

Change the role guard to accept viewer:

```ts
  if (row.role !== 'admin' && row.role !== 'editor' && row.role !== 'viewer') {
    lastTouch.delete(row.id)
    return null
  }
```

Change the return:

```ts
  return {
    tokenId: row.id,
    userId: row.created_by,
    role: row.role as Role,
    scopes: parseScopes(row.scopes),
  }
```

- [ ] **Step 3: Add scopes to the management list query**

Change `ApiTokenListRow` to add `scopes: unknown` and the `listApiTokens` SELECT to add `t.scopes`:

```ts
export interface ApiTokenListRow {
  id: number
  name: string
  token_prefix: string
  role: string
  scopes: unknown
  created_at: Date | string
  last_used_at: Date | string | null
  expires_at: Date | string | null
  revoked_at: Date | string | null
  created_by_email: string | null
}
```

```ts
  const [rows] = (await db.execute(sql`
    SELECT t.id, t.name, t.token_prefix, t.role, t.scopes, t.created_at,
           t.last_used_at, t.expires_at, t.revoked_at,
           u.email AS created_by_email
    FROM api_tokens t
    LEFT JOIN users u ON u.id = t.created_by
    ORDER BY (t.revoked_at IS NOT NULL), t.created_at DESC, t.id DESC
  `)) as unknown as [ApiTokenListRow[]]
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm typecheck`
Expected: PASS (the `VerifiedApiToken.role` widen will surface a type change at the `getSession.ts` consumer — fixed in Task 4; if typecheck flags it now, proceed to Task 4 before committing, or commit this + Task 4 together).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/apiToken.ts
git commit -m "feat(api-tokens): verifyApiToken returns scopes + allows viewer role"
```

---

## Task 4: Thread scopes + tokenId onto AuthContext; requireScope helper

**Files:**
- Modify: `lib/auth/getSession.ts`
- Modify: `lib/auth/requireRole.ts`
- Test: `tests/unit/apiTokenScope.test.ts` (extend with requireScope-shape test — pure)

- [ ] **Step 1: AuthState gains apiTokenScopes**

In `lib/auth/getSession.ts`, add to the `AuthState` interface:

```ts
interface AuthState {
  user: CachedUser
  payload: SessionPayload
  apiTokenId?: number
  apiTokenScopes?: string[] | null
}
```

In the token-auth return block (where `apiTokenId: tok.tokenId` is set), add `apiTokenScopes: tok.scopes`:

```ts
          return {
            user: { ...user, role: effectiveRole },
            payload: {
              sub: String(tok.userId),
              jti: makeApiTokenJti(tok.tokenId),
              oat: nowSec,
              iat: nowSec,
              exp: nowSec + 60,
              pwp: false,
            },
            apiTokenId: tok.tokenId,
            apiTokenScopes: tok.scopes,
          }
```

- [ ] **Step 2: AuthContext gains scopes + tokenId; add requireScope**

In `lib/auth/requireRole.ts`, extend `AuthContext`:

```ts
export interface AuthContext {
  userId: number
  role: Role
  email: string
  jti: string
  oat: number
  iat: number
  pwp: boolean
  viaApiToken: boolean
  tokenId: number | null
  scopes: string[] | null
}
```

In `requireAuth`, surface them from the auth state:

```ts
  return {
    userId: s.user.id,
    role: s.user.role,
    email: s.user.email,
    jti: s.payload.jti,
    oat: s.payload.oat,
    iat: s.payload.iat,
    pwp: s.payload.pwp,
    viaApiToken: !!s.apiTokenId,
    tokenId: s.apiTokenId ?? null,
    scopes: s.apiTokenScopes ?? null,
  }
```

Add the `requireScope` helper (cookie sessions are unrestricted; only token requests are scope-narrowed; null scopes = unrestricted within role):

```ts
import {
  tokenAllowsScope,
  type ScopeResource,
  type ScopeAction,
} from '@/lib/auth/apiTokenScope'

// Per-resource scope gate, layered AFTER requireRole. A no-op for cookie
// sessions (full operator access) and for tokens with null scopes
// (unrestricted within role). Throws 403 forbidden_scope otherwise.
export function requireScope(
  ctx: AuthContext,
  resource: ScopeResource,
  action: ScopeAction,
): void {
  if (!ctx.viaApiToken) return
  if (!tokenAllowsScope(ctx.scopes, resource, action)) {
    throw new HttpError(403, 'forbidden_scope')
  }
}
```

- [ ] **Step 3: Add a requireScope behaviour test**

Append to `tests/unit/apiTokenScope.test.ts` (importing `requireScope` from `@/lib/auth/requireRole` — note `requireRole.ts` is NOT `server-only`-guarded so it imports cleanly under the vitest `server-only` stub; if it transitively imports a node-only module, instead test `tokenAllowsScope` directly and skip this block):

```ts
import { requireScope } from '@/lib/auth/requireRole'

function ctx(partial: Partial<{ viaApiToken: boolean; scopes: string[] | null }>) {
  return {
    userId: 1, role: 'editor' as const, email: 'a@b.c', jti: 'j', oat: 0,
    iat: 0, pwp: false, viaApiToken: false, tokenId: null, scopes: null,
    ...partial,
  }
}

describe('requireScope', () => {
  it('is a no-op for cookie sessions', () => {
    expect(() => requireScope(ctx({ viaApiToken: false }), 'pages', 'delete')).not.toThrow()
  })
  it('is a no-op for null-scope tokens', () => {
    expect(() => requireScope(ctx({ viaApiToken: true, scopes: null }), 'pages', 'write')).not.toThrow()
  })
  it('throws forbidden_scope when the grant is missing', () => {
    expect(() => requireScope(ctx({ viaApiToken: true, scopes: ['posts:read'] }), 'pages', 'write')).toThrow('forbidden_scope')
  })
  it('allows a granted action', () => {
    expect(() => requireScope(ctx({ viaApiToken: true, scopes: ['pages:write'] }), 'pages', 'read')).not.toThrow()
  })
})
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run tests/unit/apiTokenScope.test.ts && pnpm typecheck`
Expected: PASS (10 tests; types resolve).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/getSession.ts lib/auth/requireRole.ts tests/unit/apiTokenScope.test.ts
git commit -m "feat(api-tokens): thread scopes+tokenId onto AuthContext + requireScope gate"
```

---

## Task 5: Per-token mutation rate bucket

**Files:**
- Modify: `lib/auth/cmsRateLimit.ts`

- [ ] **Step 1: Add the token bucket + dispatcher**

In `lib/auth/cmsRateLimit.ts`, add a token-keyed bucket and a context dispatcher (a runaway agent burns its own 600/min budget, never the human's 300/min):

```ts
// Per-TOKEN mutation budget — keyed by token id so an automated agent
// cannot starve the human operator's own per-user bucket. Higher ceiling
// than the human bucket because agents legitimately batch fast.
const limitTokenMutations = rateLimit('cms:mutation:token', {
  limit: 600,
  windowSec: 60,
})

export function checkMutationRateForToken(tokenId: number): void {
  if (!limitTokenMutations(`t${tokenId}`)) {
    throw new HttpError(429, 'rate_limited')
  }
}

// Single dispatcher every CMS mutation route calls. Token requests draw on
// the per-token bucket; cookie sessions on the per-user bucket.
export function checkCmsMutationRate(ctx: {
  userId: number
  viaApiToken: boolean
  tokenId: number | null
}): void {
  if (ctx.viaApiToken && ctx.tokenId !== null) {
    checkMutationRateForToken(ctx.tokenId)
  } else {
    checkMutationRate(ctx.userId)
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/auth/cmsRateLimit.ts
git commit -m "feat(api-tokens): per-token CMS mutation rate bucket + dispatcher"
```

---

## Task 6: Token-create route — accept role=viewer + scopes

**Files:**
- Modify: `app/api/admin/api-tokens/route.ts`

- [ ] **Step 1: Widen the Zod schema**

In `app/api/admin/api-tokens/route.ts`, import the scope predicate and widen `Create`:

```ts
import { parseScopes } from '@/lib/auth/apiTokenScope'
```

```ts
const Create = z
  .object({
    name: z.string().min(1).max(120),
    role: z.enum(['admin', 'editor', 'viewer']),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
    // Optional per-resource grants. Omitted/null = unrestricted within role.
    // Each entry is "<resource>:<action>"; parseScopes drops anything invalid.
    scopes: z.array(z.string().max(40)).max(40).optional(),
  })
  .strict()
```

- [ ] **Step 2: Persist scopes + return + audit**

Compute a normalised scopes value and thread it through INSERT, response, and audit diff:

```ts
  const body = Create.parse(await readJsonBody(req))
  const meta = auditMetaFromRequest(req)
  const { token, hash, prefix } = generateApiToken()
  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 86_400_000)
    : null
  // Normalise to a clean grant array or null. Stored as JSON.
  const scopes = body.scopes ? parseScopes(body.scopes) : null
  const scopesJson = scopes === null ? null : JSON.stringify(scopes)
```

```ts
      const [insertArr] = (await tx.execute(sql`
        INSERT INTO api_tokens
          (name, token_hash, token_prefix, role, created_by, expires_at, scopes)
        VALUES
          (${body.name}, ${hash}, ${prefix}, ${body.role}, ${ctx.userId}, ${expiresAt}, ${scopesJson})
      `)) as unknown as [InsertResult]
```

```ts
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'api_token_create',
        resourceType: 'api_token',
        resourceId: String(newId),
        diff: { name: body.name, role: body.role, scopes } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
```

```ts
  return new Response(
    JSON.stringify({ id, token, prefix, role: body.role, scopes }),
    {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint:changed`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/api-tokens/route.ts
git commit -m "feat(api-tokens): mint route accepts viewer role + per-resource scopes"
```

---

## Task 7: Token rotation route

**Files:**
- Create: `app/api/admin/api-tokens/[id]/rotate/route.ts`

- [ ] **Step 1: Write the rotate handler**

Create `app/api/admin/api-tokens/[id]/rotate/route.ts` (mirrors the revoke handler's gates; re-hashes a fresh secret, keeps id/name/role/scopes, clears revoked_at + resets last_used_at, returns the new secret once):

```ts
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema/audit'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { generateApiToken } from '@/lib/auth/apiToken'
import { auditMetaFromRequest } from '@/lib/audit/meta'

interface UpdateResult {
  affectedRows: number
}

export const POST = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    await requireFreshReauth(ctx.jti)

    const { id: idStr } = await params
    if (!/^[1-9][0-9]{0,9}$/.test(idStr)) throw new HttpError(400, 'invalid_id')
    const id = Number(idStr)
    const meta = auditMetaFromRequest(req)
    const { token, hash, prefix } = generateApiToken()

    await db.transaction(async (tx) => {
      const [res] = (await tx.execute(sql`
        UPDATE api_tokens
        SET token_hash = ${hash},
            token_prefix = ${prefix},
            revoked_at = NULL,
            last_used_at = NULL
        WHERE id = ${id}
      `)) as unknown as [UpdateResult]
      if (!res.affectedRows) throw new HttpError(404, 'not_found')
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'api_token_rotate',
        resourceType: 'api_token',
        resourceId: String(id),
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
    })

    return new Response(JSON.stringify({ id, token, prefix }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  },
)
```

> NOTE for the implementer: confirm the exact import paths (`@/lib/api/withError`, `@/lib/audit/meta`) against `app/api/admin/api-tokens/route.ts` — copy that file's imports verbatim so they match this repo's helper locations.

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint:changed`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/api-tokens/[id]/rotate/route.ts
git commit -m "feat(api-tokens): POST rotate route re-issues a token's secret"
```

---

## Task 8: Audit attribution — stamp token_id on content writes

**Files:**
- Modify: `app/api/cms/pages/[id]/batch/route.ts`
- Modify: `lib/cms/saveBlock.ts`
- Modify: `lib/ai/applyProposal.ts`

- [ ] **Step 1: Batch route — stamp tokenId in the shared audit() helper**

In `app/api/cms/pages/[id]/batch/route.ts`, add `tokenId: ctx.tokenId` to the single `audit()` helper's `.values(...)` (covers every batch audit row in one edit):

```ts
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action,
      resourceType,
      resourceId,
      diff: auditDiff as unknown as object,
      ip,
      userAgent,
      requestId,
    })
```

- [ ] **Step 2: saveBlock — accept + record tokenId**

In `lib/cms/saveBlock.ts`, add `tokenId: number | null` to BOTH `saveBlock` and `saveBlockMeta` arg objects, and add `tokenId: args.tokenId` to both `auditLog.values(...)` calls:

```ts
export async function saveBlock(args: {
  blockId: number
  userId: number
  tokenId: number | null
  ip: string | null
  userAgent: string | null
  requestId: string | null
  pageId: number
  // …rest unchanged…
})
```

```ts
  await tx.insert(auditLog).values({
    userId: args.userId,
    tokenId: args.tokenId,
    action: 'update',
    resourceType: 'content_block',
    resourceId: String(args.blockId),
    diff: auditDiff,
    ip: args.ip,
    userAgent: args.userAgent,
    requestId: args.requestId,
  })
```

(Apply the same `tokenId: args.tokenId` addition to the `saveBlockMeta` audit insert.)

- [ ] **Step 3: applyProposal — accept + record tokenId**

In `lib/ai/applyProposal.ts`, add `tokenId: number | null` to the `ApplyInlineByTokenArgs` / `ApplyChatByTokenArgs` interfaces (and any per-op args that insert audit rows), and add `tokenId: args.tokenId` to every `auditLog.values(...)` site (inline accept, dismiss, chat accept, and the per-op `applyChatEditOp/InsertOp/DeleteOp/ReorderOp` audit inserts). Pass `tokenId: args.tokenId` through the `saveBlock(...)` call the inline path makes.

- [ ] **Step 4: Fix callers**

The callers of `saveBlock`/`saveBlockMeta`/the apply functions (the per-block CMS routes + the AI proposal apply routes) must now pass `tokenId: ctx.tokenId`. Run typecheck to enumerate them:

Run: `pnpm typecheck`
Expected: errors listing each caller missing `tokenId`. For each, add `tokenId: ctx.tokenId` (route handlers) or `tokenId: ctx.tokenId ?? null` to the args object. Re-run until clean.

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck && pnpm lint:changed`
Expected: PASS.

```bash
git add app/api/cms/pages/[id]/batch/route.ts lib/cms/saveBlock.ts lib/ai/applyProposal.ts app/api/cms
git commit -m "feat(api-tokens): attribute content-write audit rows to the acting token"
```

---

## Task 9: Enforce scope + per-token rate across CMS mutation routes

Apply two mechanical edits at each mutation site: (a) replace the rate call, (b) add a `requireScope` line right after the route's existing `requireRole(...)`. The resource+action per route is in the table. **Read tools / GET handlers are NOT touched** (reads are already role-gated; scope `read` enforcement on GETs is deferred to Plan B's MCP layer to keep this task to mutations).

- [ ] **Step 1: Swap the rate dispatcher in every mutation route**

In each file below, replace the exact string `checkMutationRate(ctx.userId)` with `checkCmsMutationRate(ctx)`, and update the import from `@/lib/auth/cmsRateLimit` to include `checkCmsMutationRate`. (The batch route uses it inside a loop — `for (…) checkCmsMutationRate(ctx)` — same replacement.)

Files (all under `app/api/cms/` unless noted):
`blocks/route.ts`, `blocks/[id]/route.ts` (×2), `blocks/[id]/duplicate/route.ts`, `blocks/[id]/restore/route.ts`, `blocks/reorder/route.ts`, `pages/route.ts`, `pages/[id]/route.ts` (×2), `pages/[id]/restore/route.ts`, `pages/[id]/preview-token/route.ts`, `pages/[id]/batch/route.ts`, `posts/route.ts`, `posts/[id]/route.ts` (×2), `posts/[id]/restore/route.ts`, `projects/route.ts`, `projects/[id]/route.ts` (×2), `projects/[id]/restore/route.ts`, `projects/[id]/preview-token/route.ts`, `projects/[id]/sections/[sectionId]/route.ts`, `projects/reorder/route.ts`, `media/[id]/route.ts`, `nav/route.ts`, `saved-blocks/route.ts`, `saved-blocks/[id]/route.ts`, `saved-blocks/[id]/instantiate/route.ts`, `templates/instantiate/route.ts`. (NOT `app/api/admin/settings/route.ts` — that route already branches on `ctx.viaApiToken` for the content/branding key allowlist; leave its rate call as-is unless extending settings scopes, which is out of this task.)

- [ ] **Step 2: Add requireScope after requireRole at each mutation handler**

Import `requireScope` from `@/lib/auth/requireRole` and insert one line immediately after the handler's `const ctx = await requireRole([...])`. Resource + action per file:

| Route file | handler | resource | action |
|---|---|---|---|
| `blocks/route.ts` (POST) | create block | `blocks` | `write` |
| `blocks/[id]/route.ts` (PATCH) | edit block | `blocks` | `write` |
| `blocks/[id]/route.ts` (DELETE) | delete block | `blocks` | `delete` |
| `blocks/[id]/duplicate/route.ts` | duplicate | `blocks` | `write` |
| `blocks/[id]/restore/route.ts` | restore | `blocks` | `write` |
| `blocks/reorder/route.ts` | reorder | `blocks` | `write` |
| `pages/route.ts` (POST) | create page | `pages` | `write` |
| `pages/[id]/route.ts` (PATCH) | edit page | `pages` | `write` |
| `pages/[id]/route.ts` (DELETE) | delete page | `pages` | `delete` |
| `pages/[id]/restore/route.ts` | restore page | `pages` | `write` |
| `pages/[id]/preview-token/route.ts` | mint preview | `pages` | `read` |
| `pages/[id]/batch/route.ts` | batch edit | `pages` | `write` |
| `posts/route.ts` (POST) | create post | `posts` | `write` |
| `posts/[id]/route.ts` (PATCH) | edit post | `posts` | `write` |
| `posts/[id]/route.ts` (DELETE) | delete post | `posts` | `delete` |
| `posts/[id]/restore/route.ts` | restore post | `posts` | `write` |
| `projects/route.ts` (POST) | create project | `projects` | `write` |
| `projects/[id]/route.ts` (PATCH) | edit project | `projects` | `write` |
| `projects/[id]/route.ts` (DELETE) | delete project | `projects` | `delete` |
| `projects/[id]/restore/route.ts` | restore project | `projects` | `write` |
| `projects/[id]/preview-token/route.ts` | mint preview | `projects` | `read` |
| `projects/[id]/sections/[sectionId]/route.ts` | edit section | `projects` | `write` |
| `projects/reorder/route.ts` | reorder | `projects` | `write` |
| `media/[id]/route.ts` (DELETE) | delete media | `media` | `delete` |
| `nav/route.ts` (PUT, line ~182) | update nav | `nav` | `write` |
| `saved-blocks/route.ts` (POST) | create saved block | `blocks` | `write` |
| `saved-blocks/[id]/route.ts` (PATCH/DELETE) | edit/delete saved block | `blocks` | `write` |
| `saved-blocks/[id]/instantiate/route.ts` | instantiate | `blocks` | `write` |
| `templates/instantiate/route.ts` | instantiate template | `pages` | `write` |

Example insertion (for `pages/[id]/batch/route.ts`):

```ts
  const ctx = await requireRole(['admin', 'editor'])
  requireScope(ctx, 'pages', 'write')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  for (let i = 0; i < body.ops.length; i += 1) checkCmsMutationRate(ctx)
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint:changed`
Expected: PASS.

- [ ] **Step 4: Manual scope-enforcement check (real API, against the dev server)**

Start the dev server (`pnpm dev`). Mint a token in the UI scoped `posts:write` only (Task 10 must be done first for the UI; if running Task 9 before 10, temporarily mint via the create route with a `scopes:["posts:write"]` body using a logged-in admin session + CSRF). Then:
- `curl -X POST <dev>/api/cms/pages -H 'Authorization: Bearer cave_…' -d '{…}'` → expect **403 forbidden_scope**.
- `curl -X POST <dev>/api/cms/posts -H 'Authorization: Bearer cave_…' -d '{…}'` → expect success (or a validation error, NOT 403).

- [ ] **Step 5: Commit**

```bash
git add app/api/cms
git commit -m "feat(api-tokens): enforce per-resource scopes + per-token rate on CMS mutations"
```

---

## Task 10: Admin UI — scope picker, rotation, MCP connect line

**Files:**
- Modify: `app/(admin)/admin/settings/api-tokens/page.tsx`
- Modify: `app/(admin)/admin/settings/api-tokens/ApiTokensClient.tsx`

- [ ] **Step 1: Pass scopes through the SSR page**

In `page.tsx`, add `scopes` to the `TokenListItem` map:

```ts
    role: r.role,
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : null,
```

(and add `scopes: string[] | null` to the exported `TokenListItem` type in `ApiTokensClient.tsx`.)

- [ ] **Step 2: Add the visual scope picker to the create form**

In `ApiTokensClient.tsx`, import the vocabulary and add state:

```tsx
import { SCOPE_RESOURCES, SCOPE_ACTIONS, type ScopeResource, type ScopeAction } from '@/lib/auth/apiTokenScope'
```

```tsx
// null = "Full access (all content, bounded by role)". Otherwise an explicit
// per-resource highest-action map the user builds in the grid.
const [scopeMode, setScopeMode] = useState<'full' | 'custom'>('full')
const [scopeGrants, setScopeGrants] = useState<Record<ScopeResource, ScopeAction | 'none'>>(
  () => Object.fromEntries(SCOPE_RESOURCES.map((r) => [r, 'none'])) as Record<ScopeResource, ScopeAction | 'none'>,
)
```

Render a tile grid (per #0.59 — a visual control, NOT a `<select>` of scope names) below the Role/Expires grid. Each resource row offers None / Read / Write / Delete as selectable pills:

```tsx
<div className="block">
  <span className="mb-1.5 block text-xs font-medium text-near-black">Access</span>
  <div className="flex gap-2">
    {(['full', 'custom'] as const).map((m) => (
      <button
        key={m}
        type="button"
        onClick={() => setScopeMode(m)}
        disabled={busy}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
          scopeMode === m
            ? 'bg-copper-600 text-cream-50'
            : 'bg-cream-100 text-warm-stone hover:bg-cream-200'
        }`}
      >
        {m === 'full' ? 'Full access' : 'Custom scopes'}
      </button>
    ))}
  </div>
  {scopeMode === 'custom' && (
    <div className="mt-3 space-y-2 rounded-lg border border-warm-stone/20 p-3">
      {SCOPE_RESOURCES.map((res) => (
        <div key={res} className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium capitalize text-near-black">{res}</span>
          <div className="flex gap-1">
            {(['none', ...SCOPE_ACTIONS] as const).map((act) => (
              <button
                key={act}
                type="button"
                onClick={() => setScopeGrants((g) => ({ ...g, [res]: act }))}
                disabled={busy}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold capitalize transition-colors ${
                  scopeGrants[res] === act
                    ? 'bg-copper-600 text-cream-50'
                    : 'bg-cream-100 text-warm-stone hover:bg-cream-200'
                }`}
              >
                {act}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )}
</div>
```

- [ ] **Step 3: Send scopes in the create POST**

Build the scopes array from the grid and add it to the `create()` POST body:

```tsx
const scopes =
  scopeMode === 'full'
    ? undefined
    : SCOPE_RESOURCES.flatMap((res) =>
        scopeGrants[res] === 'none' ? [] : [`${res}:${scopeGrants[res]}`],
      )
```

```tsx
  body: JSON.stringify({
    name: name.trim(),
    role,
    expiresInDays: EXPIRY_OPTIONS[expiryIdx]!.days,
    scopes,
  }),
```

- [ ] **Step 4: Widen the role select to include viewer**

```tsx
<option value="viewer">Viewer (read-only)</option>
<option value="editor">Editor (edit content)</option>
<option value="admin">Admin (content + branding)</option>
```

and widen the `role` state type to `'admin' | 'editor' | 'viewer'`.

- [ ] **Step 5: Add the MCP connect line to the assistant briefing**

In `buildAssistantBriefing(token)`, add an MCP setup line under "Setup" (so the one-paste handoff also wires the MCP client):

```ts
- MCP server (recommended for agents): connect your MCP client to  ${origin}/api/cms/mcp  with the header  Authorization: Bearer ${token}  — e.g.  claude mcp add --transport http cavecms ${origin}/api/cms/mcp --header "Authorization: Bearer ${token}"
```

- [ ] **Step 6: Add a rotation button (per-row, mirrors revoke)**

Add a `pendingRotate` state + a per-row "Rotate" button (desktop + mobile) beside Revoke, and an `onConfirmRotate` that `csrfFetch`es `POST /api/admin/api-tokens/${id}/rotate`, then drops into the existing reveal-flow modal with the new secret:

```tsx
async function onConfirmRotate() {
  if (!pendingRotate || busy) return
  const target = pendingRotate
  setPendingRotate(null)
  setBusy(true)
  try {
    if (!(await reauth())) return
    const r = await csrfFetch(`/api/admin/api-tokens/${target.id}/rotate`, { method: 'POST' })
    if (!r.ok) { toast.error('Rotate failed — refresh and try again.'); return }
    const { token } = (await r.json()) as { token: string }
    setStage('token')
    setRevealed({ token, name: target.name, role: target.role })
    router.refresh()
  } finally { setBusy(false) }
}
```

Add a `ConfirmModal` for `pendingRotate !== null` (title "Rotate this token?", description noting the old secret stops working immediately).

- [ ] **Step 7: Verify**

Run: `pnpm typecheck && pnpm lint:changed`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "app/(admin)/admin/settings/api-tokens"
git commit -m "feat(api-tokens): admin UI scope picker, rotation, viewer role, MCP connect line"
```

---

## Task 11: Full verification (#0.26 / #0.27)

**Files:** none (verification only)

- [ ] **Step 1: Static gates**

Run: `pnpm typecheck && pnpm lint:changed && pnpm vitest run`
Expected: all PASS.

- [ ] **Step 2: Migration replay on a clean DB**

Confirm `pnpm db:migrate` applies cleanly from scratch and `pnpm db:check` (fingerprint) passes:

Run: `pnpm db:check`
Expected: fingerprint matches (file == DB row).

- [ ] **Step 3: Real customer-journey walk (manual, through the browser — NEVER via API/DB shortcuts)**

Start `pnpm dev`, sign in at the dev login path, go to **Settings → API Tokens**:
1. Create a token: name it, role **Viewer**, **Custom scopes**, grant `posts: read` only. Generate.
2. Observe the one-time secret reveal → Done → the assistant briefing → confirm it contains the new MCP connect line with the real origin + token.
3. In a terminal, `curl` with that token: `GET /api/cms/posts` → 200; `POST /api/cms/posts` → **403 forbidden_scope** (viewer + read-only); `POST /api/cms/pages` → 403.
4. Create a second token: role **Editor**, **Custom scopes**, grant `pages: write`, `posts: none`. `curl POST /api/cms/pages/<id>/batch` with a valid op → success + version bump; `curl POST /api/cms/posts` → 403.
5. Verify the audit attribution: after the batch write, `SELECT id, action, user_id, token_id FROM audit_log ORDER BY id DESC LIMIT 3` → the write rows carry the editor token's `token_id` (not NULL).
6. Click **Rotate** on a token → confirm modal → reveal shows a NEW secret once; the OLD token now `curl`s → 401.
7. Click **Revoke** → token `curl`s → 401.
8. Confirm a **Full access** token (scopes omitted) still writes everywhere within its role (back-compat).

- [ ] **Step 4: Report**

Write the observed result of each numbered step (what was clicked, the HTTP status seen, the audit row contents). No smoke test — every assertion is an observed outcome.

- [ ] **Step 5: Final commit (if any fixes)**

```bash
git add -A
git commit -m "test(api-tokens): customer-journey verification fixes"
```

---

## Self-review notes

- **Spec coverage:** §5 connect/whoami groundwork (MCP connect line) ✓ Task 10; §9 roles+scopes+predicate+enforcement ✓ Tasks 1,3,4,9; §10 expiry presets (exist) + rotation ✓ Task 7,10, per-token rate ✓ Task 5, audit attribution ✓ Task 8, leak-resistant copy (briefing exists) ✓; §11 reuse map honoured (no reimplementation of verifyApiToken/parseAndSanitize). The MCP route itself + `whoami`/`describe_block_types`/tools are **Plan B** (out of this plan by design).
- **Back-compat:** `scopes` NULL ⇒ unrestricted within role ⇒ every existing token keeps working. Verified by Task 11 step 8.
- **Type consistency:** `tokenAllowsScope(scopes, resource, action)`, `requireScope(ctx, resource, action)`, `checkCmsMutationRate(ctx)`, `VerifiedApiToken.scopes`, `AuthContext.{scopes,tokenId}`, `saveBlock({…, tokenId})` — names used identically across tasks.
- **Open implementer confirmations (not placeholders — verifications):** exact helper import paths in Task 7 (copy from the sibling token route); whether `requireRole.ts` is import-cycle-clean for the Task 4 unit test (fallback stated); the precise per-handler line for each `requireScope` insertion (the table gives resource+action; the handler's existing `requireRole` line is the anchor).
