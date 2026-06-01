# Redirects — design spec

**Date:** 2026-06-01
**Branch / worktree:** `worktree-redirection` (`.claude/worktrees/redirection`)
**Status:** Approved design, pending spec review → implementation plan

---

## 1. Goal

Add an operator-facing **Redirects** manager to CaveCMS Settings, modelled on the
WordPress "Redirection" plugin but adapted to CaveCMS's Edge-runtime middleware.
Operators can create URL → URL redirect rules (exact / wildcard / regex), see a
**404 log** of unmatched inbound URLs, and one-click turn any 404 into a redirect.
Rules are evaluated **site-wide** at the edge before auth/render, with per-rule
**hit analytics**.

This is a NEW capability. There is no existing operator-facing redirect feature —
only the internal `slug_redirects` table (auto old→new slug on CMS page rename,
checked inside `app/cms-render/[slug]/page.tsx`). We are not duplicating it; the
new feature is independent and general-purpose. `slug_redirects` is left untouched.

### Scoping decisions (confirmed with user 2026-06-01)

| Fork | Decision |
|---|---|
| Match power | **Path + wildcard + regex** (not exact-only; not full conditional matching) |
| 404 log | **Yes** — aggregated log + one-click "create redirect from this 404" |
| Eval point | **Site-wide in middleware** (Edge), via the existing cached internal-config loopback pattern |
| Hit analytics | **Yes** — per-rule hit count + last-hit timestamp |

### Out of scope for v1 (YAGNI; schema leaves room to add later)

- Conditional matching (login state / referrer / user-agent / cookie / IP / HTTP header / language)
- Redirect groups / modules (Apache/nginx export)
- Import / export (CSV / .htaccess)
- "Redirect to random post"
- Per-rule scheduling / expiry

---

## 2. How the WordPress "Redirection" plugin works (reference)

Stored in a dedicated DB table, evaluated on every request:

- **Rule** = *source URL* → *action*. Source flags: **regex** on/off, **case-insensitive**,
  and **query-parameter handling** (exact match / ignore all / ignore-but-pass-through).
- **Action types**: redirect to URL, redirect to random post, pass-through, **error
  (404/410 gone)**, do nothing. Redirect actions carry an HTTP **code** (301/302/307/308).
- **Conditions** (advanced): URL + login state / referrer / user-agent / cookie / header / IP / server / language.
- **Groups** organize rules; rules evaluated **in order**.
- **Per-rule analytics**: hit count + last-accessed.
- **404 log**: chronological log of 404s with **one-click "create redirect"** — its
  signature SEO-recovery feature.

CaveCMS adopts: source + flags, redirect/gone actions, 301/302/307/308 codes, query
handling, ordered evaluation, per-rule analytics, and the 404 log + one-click. It
**drops** conditions, groups, random-post, and webserver export for v1.

---

## 3. Architecture overview

```
Browser ── GET /old-pricing ──▶ Edge middleware
                                  │  (after install + IP gates, before auth gate)
                                  │  match against cached compiled ruleset
                                  ├─ match → 301 redirect to /pricing  (+ waitUntil hit bump)
                                  └─ no match → stamp x-cavecms-path header, continue
                                                   │
                                                   ▼
                                        Next routing → page OR not-found.tsx
                                                                │ (Node RSC)
                                                                ▼
                                                   read x-cavecms-path → log 404 (aggregated)

Edge middleware ── loopback (bearer + Host guard, 30s module cache) ──▶
        GET /api/internal/redirects  → { etag, rules[] }  (Node, reads DB)

Admin ── /admin/settings/redirects ──▶ GET/POST/PATCH/DELETE /api/admin/redirects
                                        GET/DELETE /api/admin/redirects/404-log
        (requireRole['admin'] + requireCsrf + rate-limit + audit_log)
```

**Why middleware + loopback, not direct DB in middleware:** `middleware.ts` runs on
the **default Edge runtime by deliberate design** (documented header comment lines
13–35) — no Drizzle, no `node:crypto`. It already fetches pre-computed config over
loopback to `/api/internal/security-config`, module-cached for `SECURITY_CACHE_TTL_MS`
(3000 ms), bearer-authed with `INTERNAL_REVALIDATE_SECRET` and a loopback-`Host`
guard (`getSecurityConfig`, lines 123–179). Redirects mirror this exact pattern in a
**separate** endpoint with an **independent, longer TTL** (redirects are not
security-sensitive; a 30 s stale window is harmless and keeps the 3 s security hot
path lean).

---

## 4. Data model (two new tables)

New schema file `db/schema/redirects.ts`, exported from `db/schema/index.ts`.
Hand-written SQL migration in `db/migrations/NNNN_redirects.sql` (matches the
existing `NNNN_<name>.sql` convention; run by `pnpm db:migrate`).

### 4.1 `redirects`

| column | type | notes |
|---|---|---|
| `id` | `int` PK auto-increment | |
| `source` | `varchar(512)` | source pattern; must start with `/` (path-relative). For `wildcard`, `*` matches the rest of the path. For `regex`, a JS regex body (no delimiters). |
| `match_type` | `varchar(16)` enum `exact` \| `wildcard` \| `regex` | |
| `action` | `varchar(16)` enum `redirect` \| `gone` | `gone` → HTTP 410, no target |
| `target` | `varchar(2048)` null | destination path (`/x`) or absolute URL (`https://…`); NULL when `action='gone'`. For `regex`, may contain `$1`…`$9` capture refs. |
| `status_code` | `smallint` null | 301 \| 302 \| 307 \| 308; NULL when `action='gone'` (implicit 410) |
| `query_handling` | `varchar(16)` enum `passthrough` \| `ignore` \| `exact` | default `passthrough` — match ignores the query string, original query appended to target. `ignore` = match ignores query, drop it. `exact` = query must match exactly. |
| `case_insensitive` | `boolean` default `true` | path matching case sensitivity |
| `enabled` | `boolean` default `true` | disabled rules are skipped + excluded from the internal feed |
| `position` | `int` not null | evaluation order within non-exact rules (lower first) |
| `hit_count` | `int` default `0` | |
| `last_hit_at` | `timestamp(3)` null | |
| `notes` | `varchar(255)` null | operator memo |
| `created_by` | `int` null → `users.id` `onDelete: set null` | |
| `created_at` | `timestamp(3)` not null default now | |
| `updated_at` | `timestamp(3)` not null default now onUpdateNow | drives the etag |

Indexes:
- unique `idx_redirects_source_type` on `(source, match_type)` — prevents dup rules
- `idx_redirects_enabled_pos` on `(enabled, position)` — the internal-feed ordering query

### 4.2 `not_found_log` (aggregated — one row per path)

| column | type | notes |
|---|---|---|
| `id` | `int` PK auto-increment | |
| `path` | `varchar(512)` **unique** | normalized pathname (no origin); query string excluded from the key |
| `hits` | `int` default `1` | |
| `last_seen_at` | `timestamp(3)` not null default now onUpdateNow | |
| `referrer` | `varchar(512)` null | most recent referrer (helps locate the broken inbound link) |
| `created_at` | `timestamp(3)` not null default now | |

Write path: `INSERT … ON DUPLICATE KEY UPDATE hits = hits + 1, last_seen_at = NOW(), referrer = VALUES(referrer)`.
Index unique on `path`; index on `last_seen_at` for the admin list ordering.
**Pruning:** keep ~1000 rows; a lightweight prune (delete rows beyond the 1000
most-recent `last_seen_at`) runs opportunistically on insert (e.g. 1-in-N) or via
the existing cron-purge script if one fits — decided at plan time.

---

## 5. Matching engine (Edge middleware)

### 5.1 Internal feed — `GET /api/internal/redirects`

- New route `app/api/internal/redirects/route.ts` (Node runtime, has DB).
- Guarded **identically** to `/api/internal/security-config`: `Bearer
  INTERNAL_REVALIDATE_SECRET` + loopback-`Host` requirement. Middleware already
  bypasses `/api/internal/*` from all gates.
- Returns `{ etag, rules: RedirectRule[] }`:
  - `rules` = enabled rows, ordered `position ASC, id ASC`, projected to the minimal
    shape the matcher needs (`id, source, match_type, action, target, status_code,
    query_handling, case_insensitive`).
  - `etag` = `"${count}:${maxUpdatedAtMs}"` — cheap change-detection so the matcher
    skips recompiling regex when nothing changed.

### 5.2 Module cache + compile

- `globalThis.__cavecmsRedirects = { ts, etag, exact: Map, ordered: Compiled[] }`.
- `getRedirectRules(req)` mirrors `getSecurityConfig`: serve from cache while
  `Date.now() - ts < REDIRECTS_CACHE_TTL_MS` (**30000 ms**); else loopback-fetch.
  On fetch failure, **reuse last-known-good** (a transient DB hiccup must never break
  live navigation); cold-start failure → empty ruleset (no redirects, site still works).
- On a fresh fetch whose `etag` differs: recompile — `exact` rules into a `Map`
  (key normalized per `case_insensitive`), `wildcard`/`regex` into an ordered array of
  `{ test(pathname) → matchResult | null, build(matchResult, query) → {target, code} }`.
  Wildcard `→` translated to an anchored RegExp; regex compiled with `i` flag when
  `case_insensitive`. **Compile errors on a single rule are swallowed** (that rule is
  skipped, logged once) so one bad regex can't break the whole engine.

### 5.3 Match + respond

- Inserted in `middleware.ts` **after** the install gate and IP/suspicious
  classification, **before** the auth gate.
- **Skip** matching for: non-`GET`/`HEAD`; paths under `/admin`, `/api`, `/install`,
  `/_next`, `/uploads`, `/cms-render`; and the resolved login path. (Static assets are
  already excluded by the `config.matcher`.)
- Precedence: **exact (Map O(1)) → ordered wildcard/regex (first match wins)**.
- On match:
  - `action='redirect'` → resolve final target (apply `query_handling`; substitute
    `$1…$9` for regex), guard `target !== current path` (skip on self-loop), then
    `NextResponse.redirect(finalUrl, status_code)`.
  - `action='gone'` → `new NextResponse(<410 body>, { status: 410 })`.
  - Fire-and-forget hit bump (see 5.4).
- No match → continue (stamp the 404-log header, then the normal pipeline).

### 5.4 Hit analytics

- Extend the middleware signature to `middleware(req: NextRequest, event: NextFetchEvent)`
  (supported, non-breaking; currently `middleware(req)` at line 438).
- On a redirect match: `event.waitUntil(fetch('http://127.0.0.1:PORT/api/internal/redirect-hit', { method:'POST', … }))`
  — non-blocking, won't delay the redirect response.
- `POST /api/internal/redirect-hit` (Node, same loopback+bearer guard) → single
  indexed `UPDATE redirects SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE id = ?`.
- Per-hit `UPDATE` on a PK is cheap and redirects are a small traffic fraction.
  In-memory batching/debounce is noted as a **future** optimization, not v1.

---

## 6. 404 logging (reliable capture without a front controller)

Next.js has no single front controller, so middleware cannot know in advance that a
path will 404. Capture instead at the point the 404 actually renders:

1. Middleware adds `x-cavecms-path: <pathname>` to the **already-forwarded request
   headers** — a one-line addition to the existing `reqHeaders` block
   (`NextResponse.next({ request: { headers: reqHeaders } })`, middleware.ts:661).
2. The root `app/not-found.tsx` (Node RSC — renders for **every** unmatched route AND
   every explicit `notFound()`) reads `headers().get('x-cavecms-path')` and records the
   aggregated log row.
3. **Filters before logging** (avoid noise/abuse): only `GET`; path starts `/`; not in
   the skip-list (`/_next`, `/api`, `/admin`, `/uploads`, the login path, asset
   extensions like `.ico/.map/.txt/.xml`, `.well-known`); length ≤ 512. Aggregated by
   path so a hammered URL is one row with a high `hits` count, bounded by the ~1000-row
   prune.
4. UI "Create redirect" prefills the new-rule form with `source = path`,
   `match_type = exact`; saving optionally dismisses the log row.

**Abuse consideration:** aggregation + prune + filters bound table growth; a future
in-memory dedupe window can be added if a real flood is observed.

---

## 7. Admin surface — `/admin/settings/redirects`

Clones the established settings sub-page pattern: RSC `page.tsx`
(`requireRoleOrRedirect(['admin'])`, fetch initial data) + `RedirectsClient.tsx`
(`'use client'`). Two tabs.

### 7.1 Redirects tab

- Luxury table (copper/cream, badges-not-brackets, skeleton loading): **Source → Target**,
  type badge (`exact`/`wildcard`/`regex`), code badge (`301`…/`410 Gone`), **Enabled**
  toggle, **Hits**, **Last hit**, edit / delete actions.
- **Add / Edit** in a **custom modal** (never native `confirm`/`prompt`):
  - `source` text input (validated to start `/`)
  - `match_type` — **segmented buttons with inline examples** (`exact: /old-page` ·
    `wildcard: /blog/*` · `regex: ^/p/(\d+)$`), per the visual-picker rule (no bare `<select>`)
  - `action` — segmented (`Redirect` / `Gone (410)`); choosing `Gone` hides target + code
  - `target` text input (path or absolute URL; `$1` hint shown for regex)
  - `status_code` — segmented buttons `301 · 302 · 307 · 308` with one-line meanings; default **301**
  - `query_handling` — segmented `Pass through · Ignore · Exact`; default **Pass through**
  - `case_insensitive`, `enabled` — toggles
  - `notes` — optional
- **Drag-handle reorder** sets `position` (ordering matters for wildcard/regex precedence).
- **"Test a URL"** box: operator types a path → client (or a tiny `POST
  /api/admin/redirects/test`) shows which rule fires and the resulting destination, or
  "no match → would 404".

### 7.2 404 Log tab

- Table: **Path · Hits · Last seen · Referrer**, ordered by `last_seen_at desc`, with
  per-row **"Create redirect"** (→ prefilled modal) and **"Dismiss"** (delete row).

### 7.3 Nav

- Add to `components/admin/nav.ts` under Settings:
  `{ label: 'Redirects', href: '/admin/settings/redirects', roles: ['admin'], icon: Signpost, parent: '/admin/settings' }`
  (Lucide `Signpost` or `Route`).

---

## 8. API routes (admin)

All wrapped in `withError` + `requireRole(['admin'])` + `requireCsrf` +
`checkMutationRate`, writing `audit_log` rows on mutations. No step-up reauth
(consistent with other content settings; redirects are admin-only + CSRF-protected).

| Method + path | Purpose |
|---|---|
| `GET /api/admin/redirects` | list (search + paginate) |
| `POST /api/admin/redirects` | create |
| `PATCH /api/admin/redirects/:id` | update / toggle `enabled` / reorder (`position`) |
| `DELETE /api/admin/redirects/:id` | delete |
| `POST /api/admin/redirects/test` | (optional) test a URL against the live ruleset |
| `GET /api/admin/redirects/404-log` | list 404s |
| `DELETE /api/admin/redirects/404-log/:id` | dismiss a 404 row |

Internal (loopback + bearer, no session): `GET /api/internal/redirects`,
`POST /api/internal/redirect-hit`.

### Validation (Zod, server-side)

- `source` starts `/`, length ≤ 512.
- `match_type='regex'` → **test-compile** the pattern (reject invalid); cap length to
  bound ReDoS surface; reject on compile error.
- `target`: when `action='redirect'`, required, must be a path (`/…`) or absolute
  `http(s)` URL; when `action='gone'`, must be null/empty.
- `status_code` ∈ {301,302,307,308} when redirect; null when gone.
- **Loop guard:** reject `source === target` (post-normalization) for exact rules.
- Unique `(source, match_type)` enforced at DB + surfaced as a friendly 409.

---

## 9. Files touched / added

**New**
- `db/schema/redirects.ts` — `redirects` + `not_found_log` tables
- `db/migrations/NNNN_redirects.sql` — create both tables + indexes
- `lib/cms/redirects.ts` — shared types, Zod schemas, wildcard→regex compiler, query-handling helper
- `app/api/internal/redirects/route.ts` — internal feed (`{ etag, rules }`)
- `app/api/internal/redirect-hit/route.ts` — hit bump
- `app/api/admin/redirects/route.ts` — list + create
- `app/api/admin/redirects/[id]/route.ts` — update + delete
- `app/api/admin/redirects/test/route.ts` — (optional) URL test
- `app/api/admin/redirects/404-log/route.ts` — list 404s
- `app/api/admin/redirects/404-log/[id]/route.ts` — dismiss
- `app/(admin)/admin/settings/redirects/page.tsx` — RSC
- `app/(admin)/admin/settings/redirects/RedirectsClient.tsx` — client UI

**Modified**
- `middleware.ts` — `getRedirectRules` cache helper; match block (after IP gate,
  before auth gate); `(req, event)` signature + `waitUntil` hit bump; stamp
  `x-cavecms-path` on `reqHeaders`
- `db/schema/index.ts` — `export * from './redirects'`
- `components/admin/nav.ts` — Redirects nav entry
- `app/not-found.tsx` — read `x-cavecms-path`, aggregated 404-log write (filtered)

---

## 10. Edge cases & failure modes

- **Internal feed unreachable / empty secret** → reuse last-known-good ruleset; cold
  start → empty ruleset (no redirects, navigation unaffected). Mirrors `getSecurityConfig`.
- **Bad regex in one rule** → that rule skipped at compile, engine keeps working.
- **Redirect loop** (source resolves to target) → save-time loop guard + runtime
  `target !== current path` skip; middleware only fires one redirect per request anyway.
- **Open-redirect / phishing** → targets are operator-set (admin-only, CSRF). Absolute
  targets allowed by design (legit cross-domain migrations). No untrusted input feeds targets.
- **Stale cache** → up to 30 s for a new/edited rule to take effect site-wide;
  acceptable and documented. (A future explicit cache-bust on save can shorten this.)
- **404-log abuse** (random-URL flood) → aggregation + filters + ~1000-row prune bound growth.
- **Trailing-slash / case** → normalization centralized in `lib/cms/redirects.ts` and
  applied identically in the matcher and on save, so admin "Test a URL" matches runtime.

---

## 11. Verification plan (#0.26 / #0.27 — real customer journey, no API/DB shortcuts)

After implementation, on the local test install, via Playwright with real
keyboard/click events:

1. **Create exact redirect** through the modal (`/old-pricing` → `/pricing`, 301),
   save, then **navigate** `/old-pricing` in the browser → observe the 301 lands on
   `/pricing` (check `browser_network_requests` for the 301 + Location).
2. **Wildcard** (`/blog/*` → `/news`) → navigate `/blog/anything` → lands `/news`.
3. **Regex with capture** (`^/p/(\d+)$` → `/product/$1`) → navigate `/p/42` → `/product/42`.
4. **Query passthrough** → `/old?utm=x` preserves `?utm=x` on the target.
5. **Gone (410)** rule → navigate → observe 410.
6. **Disabled** rule → navigate → no redirect (404/normal).
7. **Hit analytics** → after the above, reload the admin list → Hits/Last-hit updated
   (verify by reading the row in the UI; cross-check with a `SELECT` only as an *assertion*).
8. **404 log** → navigate a non-existent `/totally-missing` → appears in the 404 Log
   tab with hits=1; navigate again → hits=2; click **Create redirect** → modal prefilled
   → save → navigate again → now redirects; the 404 row dismissed.
9. **Precedence / reorder** → drag to reorder two overlapping wildcard rules → confirm
   the higher one wins at runtime.
10. **Validation failures** → invalid regex, `source===target`, duplicate rule → each
    shows the friendly error in the modal (exercise the failure path, not just happy path).

Smoke tests (navigate + console-check only) are **banned** for this verification.

---

## 12. Implementation phasing (for the plan)

1. **Schema + migration** — `redirects` + `not_found_log`, export, migrate.
2. **Shared lib** — `lib/cms/redirects.ts` types, Zod, compiler, normalization.
3. **Internal feed + matcher** — `/api/internal/redirects`, middleware cache + match
   block + `(req, event)` + hit endpoint.
4. **Admin CRUD + UI** — API routes, settings page, client UI, nav entry.
5. **404 log + one-click** — `x-cavecms-path` stamp, `not-found.tsx` write, log tab,
   prefill-from-404.
6. **Verification** — full Playwright customer journey (§11), `pnpm typecheck` + `lint:changed`.
