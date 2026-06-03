# CaveCMS MCP Server — Design Spec

**Date:** 2026-06-01
**Branch / worktree:** `cavemcp` (`.claude/worktrees/cavemcp`)
**Status:** Design — pending user review, then implementation plan (`writing-plans`).

---

## 1. Summary

Expose a Model Context Protocol (MCP) server **inside every CaveCMS install** so the
instance owner can connect any MCP client (Claude Code, Claude Desktop, Cursor) with a
**site URL + API token** and have an AI agent read and edit their site — fast, and
without ever corrupting content.

The decision the user posed — "is an API token good, or is there a better way?" — is
answered by grounding in (a) what CaveCMS already ships, (b) the current MCP spec +
client reality, and (c) two production analogues (Stripe MCP, Notion MCP). Verdict:
**the existing `cave_` Bearer token, hardened, is the correct and only auth path** for a
single-tenant self-hosted product. OAuth 2.1 is explicitly out of scope (see §15).

This is not a phased "v1" — it is the complete, production-grade build the user asked
for: full per-resource scoping, three token roles, expiry/rotation/revoke, per-token
rate limiting and audit attribution, drafts-by-default, MCP elicitation on destructive
operations, progressive tool disclosure, and the optimistic-concurrency guarantees that
let us beat Notion's own MCP on edit safety.

## 2. Goals / Non-goals

**Goals**
- One-command connect: `claude mcp add --transport http cavecms <site-url>/api/cms/mcp --header 'Authorization: Bearer cave_…'`.
- The agent edits pages/posts/projects/media/nav through the **same validated write path** the app already uses — never a parallel representation.
- Edits are **flawless** (server-side Zod validation wall + optimistic-lock 409 + all-or-nothing batches) and **fast** (in-process, batch-first, schema-guided so the agent self-corrects instead of thrashing).
- Least-privilege: a token can be scoped to exactly what an agent needs (e.g. read-only, or blog-only-write).
- Safe-by-default: content lands in **draft**; publish and delete require explicit, human-confirmable steps.

**Non-goals (this spec)**
- OAuth 2.1 / per-instance authorization server (§15).
- Multi-tenant / hosted connector directory.
- Editing security/secret settings, users, or anything behind step-up reauth (structurally impossible for tokens and kept that way).
- A Markdown content boundary or a custom-tag content dialect (§6 — verified wrong for this catalog).

## 3. Decisions locked (with grounding)

| # | Decision | Grounded in |
|---|----------|-------------|
| D1 | Auth = hardened `cave_` Bearer token. No OAuth. | `lib/auth/apiToken.ts`; MCP spec allows static Bearer; Stripe & Notion both ship Bearer for self-host; Notion hosted has **no headless mode** at all. |
| D2 | Transport = remote Streamable-HTTP route **inside the app** at `/api/cms/mcp`. | `tokenAllowedPath` already permits `/api/cms/*`; reuses in-process `verifyApiToken`, validation, audit, rate-limit. ssh-mcp is a separate package only because its target is remote SSH hosts; CaveCMS's target is its own DB. |
| D3 | Content I/O = **block-tree JSON**, mirroring the existing AI editor; Markdown only at leaf prose fields. | The existing AI flow (`lib/ai/*`) already represents content as block `data` JSON; 71% of the 48 block types are irreducibly structured; live DB rows confirm JSON is the stored, canonical shape. |
| D4 | Writes terminate at the existing `parseAndSanitize(blockType, data)` boundary. | `lib/ai/applyProposal.ts` + `lib/cms/parse.ts` — the Zod + DOMPurify corruption firewall. Reuse, don't reimplement. |
| D5 | Drafts-by-default + **MCP elicitation** on destructive/publish tools. | User decision; stronger than Stripe (no test-mode default) and Notion (client-only confirmation). CaveCMS already soft-deletes + has draft/publish. |
| D6 | Full token model: `viewer\|editor\|admin` roles + per-resource scopes + expiry presets + rotation + per-token rate bucket + per-token audit attribution. | `db/schema/apiTokens.ts` currently has none of these; all net-new. |
| D7 | Progressive disclosure: tools are **registered per the connecting token's role+scopes**, so a read-only agent never even sees write/delete tools. | Notion's hardest-won scaling lesson (latent.space interview); also shrinks blast radius. |
| D8 | Optimistic concurrency (version → 409) is mandatory on every write tool. | `pages.version` + `content_blocks.version` already exist; the batch endpoint already enforces it. This is where we beat Notion's MCP (which omits it). |

## 4. Architecture & topology

```
CaveCMS app (every install)
└─ app/api/cms/mcp/route.ts          ← Streamable-HTTP MCP transport
                                        POST = JSON-RPC, GET = SSE stream, DELETE = session teardown
   └─ lib/mcp/
        server.ts                    ← builds a PER-SESSION McpServer, registers the scoped tool set
        session.ts                   ← Mcp-Session-Id map, IP-bound, idle + absolute timeouts, MAX_SESSIONS, heartbeat, graceful drain
        auth.ts                      ← wraps verifyApiToken; resolves role + scopes; re-verified EVERY request
        tiers.ts                     ← CMS_ACTION_TIERS + classifier (read|write|dangerous|blocked), unknown → max, fail-closed
        scopes.ts                    ← scope predicate (resource × action vs token scopes, clamped by role)
        elicitation.ts               ← human-confirmation prompt for dangerous-tier tools
        tools/{discovery,pages,posts,projects,blocks,media,nav,meta}.ts
        adapters/*                   ← call SHARED in-process CMS service fns (not HTTP round-trips)
```

**Mount path:** `/api/cms/mcp`. Rationale: `tokenAllowedPath()` already returns true for
`/api/cms/*`, enforced at the Edge `authGate` **and** structurally in `_loadAuthState`.
Mounting here means **zero middleware surgery** and the token-reach cap holds by
construction. A bare `/api/mcp` would require touching all three enforcement points and
is rejected for that reason.

**Transport hardening** (adapted from `ssh-mcp-server/src/transports/http.ts`, since Next
owns the HTTP server): a fresh `McpServer` instance per session (the SDK throws "Already
connected to a transport" if one server connects twice), sessions keyed by
`Mcp-Session-Id`, IP-bound, idle + absolute timeouts, `MAX_SESSIONS` cap, SSE heartbeat,
graceful drain on shutdown. **The MCP session is transport continuity only — never auth.
`verifyApiToken` runs on every inbound JSON-RPC request**, per MCP spec MUST.

**Adapters call in-process service functions, not HTTP.** Where a `/api/cms/*` route
already delegates to a service function, the adapter calls it directly. Where a route's
logic is inline in the handler, that logic is extracted to `lib/cms/services/<x>.ts` with
**zero behavior change**, and both the route and the MCP adapter call it (DRY). This keeps
"in-process fast" without re-implementing or HTTP-hopping. (Exact extraction list is an
implementation-plan task.)

## 5. Authentication & connection model

- **Credential = site URL + `cave_` token** (Bearer header). The URL locates the
  instance; the token authenticates. The instance knows its own canonical site URL, so
  the admin "API Tokens" screen generates the full one-line connect snippet (URL + token
  baked in). Token shown once at mint.
- **Verification:** `verifyApiToken(authorizationHeader)` (existing) on every request.
  Returns `{ tokenId, userId, role }` or `null` (fail-closed; never throws). The MCP route
  401s on null. **Audience binding is implicit** — a `cave_` token only validates against
  *this* instance's `api_tokens` table. The token is **never forwarded downstream** (MCP
  token-passthrough is spec-forbidden).
- **`whoami` tool** returns `{ identity, role, scopes, instanceUrl, version }` so the
  handshake is verifiable immediately ("ensure connection").
- **HTTPS only, header-only, never query string.** Distinctive `User-Agent`
  (`cavecms-mcp/<version>`) so the owner's `suspiciousRequest` UA gate doesn't 404 the agent.
- **CSRF stays bypassed for tokens** — token requests carry the `apitoken:` jti prefix
  which `requireCsrf` already skips and `requireFreshReauth` already refuses. The MCP route
  must **not** call `/api/csrf` (that needs a cookie session). This is correct and supported.

## 6. Content representation — block-JSON, NOT Markdown (verified)

This was the single highest-risk decision ("fruit of the poisonous tree"). It was tested
against the codebase, the Zod registry, and live DB rows, and the Notion-style Markdown
boundary was **rejected** for CaveCMS:

- **CaveCMS already chose JSON.** The existing AI editor (`lib/ai/*`) reads via
  `inspect_page` (block outline) + `inspect_block` (full `data` object "exactly as stored")
  and writes **complete-replacement `data` objects** validated through
  `parseAndSanitize(blockType, data)`. No markdown↔block conversion exists; `lib/cms/markdown.ts`
  is blog-post render-only. A Markdown boundary would be a forbidden parallel representation.
- **The catalog is the inverse of Notion.** 34 of 48 block types (**71%**) are
  irreducibly structured (media foreign-keys `media_id`, positional matrices, coordinate
  markers, datetimes, numeric ranges, a discriminated CRM union). Only ~10% is pure prose.
  Notion is ~90% prose — which is why Markdown won there and loses here.
- **A custom-tag dialect (`<lx_pricing_table>…`) is worse than JSON** for 71% of the
  catalog — lossy JSON-with-angle-brackets plus a bespoke parser per block type.

**Therefore:**
1. **Content I/O = block-tree JSON**, tools mirror the existing AI shapes
   (`inspect_page` / `inspect_block` / `propose_block_*`) so there is ONE representation.
2. **A discovery tool exposes the Zod schemas** (a JSON-Schema projection of the
   block-registry) so the agent learns field names, enums, bounds, defaults, refinements —
   this is what makes it fast + flawless, not a text format.
3. **Markdown only at leaf prose fields** (`body_richtext`, `quote`, `code`, `*.body`,
   `description`, `features[]`, captions). The agent may author those in lightweight
   Markdown; the server converts to the sanitized HTML the renderer expects (the
   `RICHTEXT_FIELDS` + DOMPurify path already exists in `lib/cms/parse.ts`).
4. **Companion tools for foreign keys:** `media.search` / `media.upload` return
   `media_id`; project/post listing tools feed the data-driven blocks
   (`lx_featured_projects`, `lx_posts`) whose content lives in their own tables, not the block.

## 7. Tool surface (tiered)

Read/write/destructive tiers. Tools are **registered only if the token's role+scopes
permit them** (§9, progressive disclosure). Names align with the proven AI-flow vocabulary.

**READ (tier: read)**
- `whoami` — identity, role, scopes, instance URL + version (connection check).
- `describe_block_types` — JSON-Schema projection of the block-registry + tone enums + tree invariants (section→column→widget, column-count caps, fixed-slot rules).
- `list_pages`, `inspect_page` (block outline + `page.version` + per-block `version`), `inspect_block` (full `data`).
- `list_posts`, `get_post`; `list_projects`, `get_project`; `get_nav`; `media.search`.
- `search_content` (reuses `lib/cms/blockSearch.ts`).

**WRITE (tier: write — non-destructive, drafts-default)**
- `edit_page` — the primary editor. Batches **non-destructive** `propose_block_*`-style ops
  (`edit` = complete-replacement `data`, `insert`, `reorder`/move-within-page) executed through
  the existing **batch transaction** (`POST /api/cms/pages/[id]/batch` mechanism): ≤50 ops,
  `tempId` forward-refs, `pageVersion` + per-op `expectedBlockVersion`, all-or-nothing,
  per-op `op[<i>]:<code>` errors. Widgets-only; fixed slots (`block_key != null`) protected.
  **`delete` ops are deliberately excluded** from this tool — deletion is dangerous-tier
  and only available via the elicitation-gated `delete_block` (so a non-destructive edit can
  never silently remove a block).
- `create_page` (new draft page / clone template), `update_page_fields`
  (title/SEO/hero; slug + is_home are admin-only).
- `create_post`, `update_post` (post body is Markdown → existing pipeline).
- `update_project`, `update_project_section`, `reorder` helpers.
- `media.upload`; `update_nav` (optimistic version); `instantiate_template`,
  `instantiate_saved_block`; `mint_preview_token` (hand the owner a preview URL).

**DESTRUCTIVE (tier: dangerous — MCP elicitation + explicit flag)**
- `delete_block` / `delete_page` / `delete_post` / `delete_project` / `delete_media`
  (soft-delete; cascades; refuses fixed slots / referenced media → 409).
- `publish_page` / `unpublish_page` (and post/project equivalents) — publish is a
  deliberate dangerous-tier action, not a side effect of editing.
- `restore_*`.

**NOT exposed (structurally token-unreachable — not even defined)**
- `/api/ai/*` (propose/apply) and `/api/admin-bar/*` are session-cookie-only.
- Anything behind `requireFreshReauth` (users, `security_*`, secrets, AI key).

## 8. Concurrency & the "flawless + fast" discipline

Mandatory in every write tool's description and handler:
1. **Read-before-edit:** `inspect_page` → capture `page.version` + each block's `version`.
2. **Write with versions:** pass `pageVersion` + per-op `expectedBlockVersion`; on
   `409 stale_*`, re-read and retry. Writes **default to requiring versions**; last-write-wins
   is opt-in only.
3. **Batch, all-or-nothing:** one `edit_page` call per logical edit; per-op error codes let
   the agent fix the exact failing op.
4. **Validation wall:** invalid block `data` returns a structured Zod error the agent
   self-corrects against — it can never persist corruption.
5. **Idempotency:** `edit_page` accepts a client-supplied idempotency key so a retried call
   after a network blip does not double-apply. *(Net-new on the batch mechanism.)*

## 9. Scope model + progressive disclosure (net-new)

- **Roles:** `viewer | editor | admin`. (`viewer` is net-new — currently `verifyApiToken`
  and the schema enum reject anything but admin/editor.) Role is the ceiling.
- **Per-resource scopes:** a `scopes` JSON column. Tokens carry e.g.
  `["pages:write","posts:read","media:write","nav:read"]` over resources
  `{pages, posts, projects, blocks, media, nav, settings}` × `{read, write, delete}`.
  `delete` is distinct from `write` (so an agent can edit but not delete).
- **`scopes.ts` predicate:** `can(token, resource, action)` = role-ceiling AND scope-grant.
  Checked **server-side against the classified action**, NOT the tool name (the ssh-mcp
  design flaw to avoid), with the underlying service's role check as defense-in-depth.
- **Progressive disclosure:** at session start, `server.ts` registers **only the tools the
  token can actually use**. A `viewer` token's agent sees read tools only — smaller context,
  smaller blast radius. Out-of-scope tools are absent, not just denied.

## 10. Token lifecycle hardening (net-new, admin UI)

- **Expiry presets** (30 / 60 / 90 days / never) with an **"AI assistant" mint preset**
  defaulting to 90 days (today default is Never; OWASP MCP01 #1 risk is token-in-config leakage).
- **Rotation:** re-issue the secret, keep id + name + scopes (so the agent config updates
  the header without losing scoping/history).
- **Instant revoke** (exists) + **revoke-all**.
- **Per-token rate bucket** keyed by `tokenId`, separate from the human's per-user CMS
  bucket, so a runaway agent can't starve the owner's browser tabs. (Builds on
  `lib/auth/cmsRateLimit.ts`.)
- **Per-token audit attribution:** stamp `tokenId` into content-mutation audit rows
  (today only `created_by`). Answers "which agent edited this."
- **Leak-resistant setup copy:** steer to local-scope `.mcp.json` / `${VAR}` / headers-helper,
  never a checked-in token.

## 11. Reuse map (exact symbols)

**Reuse wholesale:**
- `verifyApiToken(authHeader)` → `{tokenId, userId, role}` — auth (`lib/auth/apiToken.ts`).
- `tokenAllowedPath`, `isApiTokenJti`, `makeApiTokenJti`, `API_TOKEN_PREFIX` (`lib/auth/apiTokenScope.ts`).
- `parseAndSanitize` / `parseBlockData` + `RICHTEXT_FIELDS` (`lib/cms/parse.ts`, `lib/cms/block-registry.ts`) — the validation wall (single write boundary).
- `saveBlock` / the chat-apply write helpers (`lib/cms/saveBlock.ts`, `lib/ai/applyProposal.ts`) — the optimistic-locked write transaction.
- The batch mechanism behind `POST /api/cms/pages/[id]/batch` — the multi-op fast lane.
- `cmsRateLimit`, the audit-log writer, soft-delete semantics, `blockSearch`.
- Block-registry Zod schemas → projected to JSON-Schema for `describe_block_types`.

**Reuse the framework, replace the vocabulary (from ssh-mcp):**
- Streamable-HTTP session/transport hardening + security headers.
- `server.tool(name, description, zodShape, handler)` registration shape + `{content:[{type:'text',text}], isError?}` responses.
- The capability-tier framework (`read|write|dangerous|blocked`, unknown→max, fail-closed) — vocabulary becomes `CMS_ACTION_TIERS`.

**Net-new:**
1. `app/api/cms/mcp/route.ts` transport handler.
2. `lib/mcp/*` (server, session, auth wrapper, tiers, scopes, elicitation, tools, adapters).
3. DB migration: add `viewer` to role enum + a `scopes` JSON column on `api_tokens`; widen `VerifiedApiToken.role`.
4. Per-token rate bucket + `tokenId` audit attribution plumbed through the write path.
5. Idempotency key on the batch mechanism.
6. `describe_block_types` discovery tool (JSON-Schema projection).
7. Admin UI: scope picker (visual, per-resource×action), expiry presets, rotation, connect-snippet generator.
8. `lib/cms/services/*` extraction for any inline route logic the adapters need.

## 12. The downflow — fruit-of-the-poisonous-tree risks

1. **CSRF-vs-bearer:** the MCP route must stay bearer-only; calling `/api/csrf` would 403 every tool call.
2. **Tier ceiling enforced against the classified action + role, not the tool name** (+ underlying `requireRole` as depth).
3. **Scope granularity designed now**, not retrofitted — the `scopes` column + visual picker ship in this build.
4. **Audience binding documented; token never forwarded downstream.**
5. **Version/conflict:** writes require versions by default (last-write-wins opt-in only).
6. **Discovery tool present:** without `describe_block_types` the agent guesses block shapes, fails Zod, and thrashes.
7. **Prompt injection** is unsolved at the protocol layer — defended by elicitation on dangerous tools + drafts-default + soft-delete, not by auth choice.
8. **Content representation** stays block-JSON (§6) — a Markdown boundary would be the deepest poison.

## 13. Security hardening checklist

- `verifyApiToken` on every request; session ≠ auth.
- HTTPS-only, header-only token; distinctive UA.
- Per-token expiry default (90d for AI preset), rotation, instant + bulk revoke.
- Per-token rate bucket; per-token audit attribution.
- Drafts-by-default; explicit, elicitation-gated publish; soft-delete with explicit delete flag.
- Reauth-gated surfaces remain categorically off-limits (no MCP tool routes around `requireFreshReauth`).
- ssh-mcp-style audit redaction (truncate → redact → strip control chars; never log the token).
- Leak-resistant setup copy.

## 14. Testing & verification (#0.26 / #0.27)

- **Unit:** tier classifier, `scopes.can()`, token verify with viewer role + scopes, idempotency dedupe, version→409.
- **Integration:** each tool against the test install — assert DB writes, `version` bumps, audit rows with `tokenId`, soft-deletes, draft state.
- **Real customer journey (mandatory):** connect a real MCP client (Claude Code `claude mcp add --transport http …` and/or MCP Inspector) to `test.derricksiawor.com`, then **exercise every tool**: `whoami` handshake; `inspect_page`/`inspect_block`; `edit_page` happy path + a deliberate stale-version 409 + retry; a Zod-invalid edit → structured error → self-correct; `create_page` (lands draft); `publish_page` → elicitation prompt → confirm; `delete_block` → elicitation → soft-delete verified by SELECT; a `viewer`-scoped token proving write tools are **absent** from the tool list. Report what was clicked + observed per tool. Smoke tests are banned.
- All edits performed through the MCP tools (the real path), never via raw SQL/API shortcuts.

## 15. Out of scope (with upgrade path)

- **OAuth 2.1 authorization server.** Rejected for a single-tenant-per-domain fleet: each
  domain would be its own issuer (N issuers), requiring RFC 9728 + RFC 8414 + PKCE +
  RFC 8707 + dynamic client registration per install — higher build cost and, without DCR,
  *higher* friction than a token. Its one advantage (keychain-stored, no secret in config)
  is approximated by short expiry + rotation + scoping. The token model is built so it can
  later sit behind a per-instance OAuth AS without a rewrite. Trigger to revisit: going
  multi-tenant / public connector directory.
- Multi-tenant hosting, marketplace listing, non-owner delegation.

## 16. Open questions for implementation plan

1. Exact list of `/api/cms/*` routes whose logic must be extracted into `lib/cms/services/*` for in-process adapter reuse vs already-extractable.
2. Idempotency-key storage (in-memory TTL map vs a small table) — and dedupe window.
3. Whether `describe_block_types` ships the full JSON-Schema projection or a trimmed agent-optimized subset per block (token-cost tuning).
4. Scope-picker UX in the API-tokens admin screen (visual per-resource×action grid).

---

*Grounding sources: line-by-line reads of `ssh-mcp-server/src/*`, CaveCMS `lib/auth/*`,
`lib/cms/*`, `lib/ai/*`, `app/api/cms/*`, `db/schema/*`; live DB block distribution;
current-truth web research on the MCP authorization spec and the Stripe + Notion MCP
servers (2025–2026).*
