import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { registry } from '@/lib/cms/settings-registry'
import { getSetting } from '@/lib/cms/getSettings'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'

// Dedicated read/write API for the navigation menus (header dropdowns +
// footer columns). The menus live inside the `site_header` / `footer`
// settings rows; this route reads/splices just the menu tree so integrators
// don't have to hand-craft the whole setting blob.
//   GET  — public-readable (the menus are public content). Authed callers
//          additionally receive each menu's `version` for round-trip writes.
//   PUT  — admin session OR API token (both /api/cms/* + the keys are
//          token-writable). CSRF-protected for sessions. Read-modify-write
//          with an optimistic version lock; re-validates the WHOLE setting
//          so a half-valid header/footer can never be persisted.

type MenuKey = 'header' | 'footer'
const SETTING_KEY: Record<MenuKey, 'site_header' | 'footer'> = {
  header: 'site_header',
  footer: 'footer',
}
const TREE_FIELD: Record<MenuKey, 'navItems' | 'columns'> = {
  header: 'navItems',
  footer: 'columns',
}

// `key` is always one of the two real registry keys (from SETTING_KEY), but
// the indexed access is `T | undefined` under noUncheckedIndexedAccess — this
// asserts the entry exists so callers read `.schema` / `.default` cleanly.
function registryEntry(key: 'site_header' | 'footer'): { schema: z.ZodTypeAny; default: unknown } {
  const e = (registry as Record<string, { schema: z.ZodTypeAny; default: unknown }>)[key]
  if (!e) throw new HttpError(500, 'unknown_setting')
  return e
}

function parseStored(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

// Per-IP throttle for ANONYMOUS reads. This is the only anonymous /api/cms
// route, so it gets its own sliding window as defense-in-depth against a
// cache-busting request loop (authed callers are limited by checkReadRate
// instead). Generous: a headless frontend caches the menu itself and won't
// poll anywhere near this.
const anonNavReadLimit = rateLimit('cms_nav_anon_read', { limit: 60, windowSec: 60 })

// Fresh, mutually-consistent value + version in ONE read, validated fail-closed
// to the registry default (mirrors lib/cms/getSettings). Used for the AUTHED
// GET branch: the value and version MUST come from the same point-in-time read,
// because an authed caller round-trips them through PUT's optimistic lock —
// pairing a cache-stale value with a fresh version would let the caller PUT at
// a version that no longer reflects what they saw and silently clobber an
// intervening write. Anonymous reads use the cached getSetting path instead
// (they get no version and cannot write, so staleness is harmless there).
async function readFreshSetting(
  key: 'site_header' | 'footer',
): Promise<{ value: Record<string, unknown>; version: number }> {
  const entry = registryEntry(key)
  const [rows] = (await db.execute(sql`
    SELECT value, version FROM settings WHERE \`key\` = ${key}
  `)) as unknown as [Array<{ value: unknown; version: number }>]
  const raw = rows[0] ? parseStored(rows[0].value) : parseStored(entry.default)
  const version = rows[0]?.version ?? 0
  const result = entry.schema.safeParse(raw)
  const value = (result.success ? result.data : entry.default) as Record<string, unknown>
  return { value, version }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

// ── GET /api/cms/nav — public-readable menu trees ────────────────────
export const GET = withError(async (req: Request) => {
  // Resolve an admin/editor/viewer or API-token caller if present; anonymous
  // reads are allowed (the middleware lets GET /api/cms/nav through). Only an
  // auth failure (401/403) means "anonymous" — any other error is a real
  // fault and must propagate.
  let authed = false
  try {
    const ctx = await requireRole(['admin', 'editor', 'viewer'])
    checkReadRate(ctx.userId)
    authed = true
  } catch (err) {
    if (!(err instanceof HttpError && (err.status === 401 || err.status === 403))) throw err
    // Anonymous → per-IP throttle BEFORE any read work.
    const headerObj: Record<string, string | undefined> = {}
    req.headers.forEach((v, k) => {
      headerObj[k] = v
    })
    const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
    if (!anonNavReadLimit(ip)) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'retry-after': '60',
        },
      })
    }
  }

  let payload: unknown
  if (authed) {
    // Fresh, mutually-consistent value+version (single read per key) so the
    // round-trip write contract holds — see readFreshSetting.
    const [h, f] = await Promise.all([
      readFreshSetting('site_header'),
      readFreshSetting('footer'),
    ])
    payload = {
      header: { items: asArray(h.value.navItems), version: h.version },
      footer: { columns: asArray(f.value.columns), version: f.version },
    }
  } else {
    // Anonymous → cached + validated read (the SAME revalidate-bounded,
    // schema-clean path the public renderer uses). Repeated anonymous reads
    // collapse onto one DB hit per revalidation window (tag 'settings', bumped
    // by PUT) instead of a fresh SELECT per request, so the public endpoint
    // can't be turned into a DB-amplification surface. No version is returned
    // (anonymous callers can't write), so cache staleness is harmless here.
    const header = await getSetting('site_header')
    const footer = await getSetting('footer')
    payload = {
      header: { items: asArray(header.navItems) },
      footer: { columns: asArray(footer.columns) },
    }
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Body differs by auth state (authed adds `version`), so a shared cache
      // must key the public copy separately from authed requests.
      vary: 'Cookie, Authorization',
      // Public reads are shared-cacheable for a short window; authed reads
      // carry caller-scoped version data and must never be shared-cached.
      'cache-control': authed ? 'private, no-store' : 'public, max-age=30',
    },
  })
})

const Body = z
  .object({
    menu: z.enum(['header', 'footer']),
    tree: z.unknown(),
    version: z.number().int().nonnegative(),
  })
  .strict()

interface UpdateResult {
  affectedRows: number
}

// ── PUT /api/cms/nav — replace one menu's tree ───────────────────────
export const PUT = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'nav', 'write')
  checkCmsMutationRate(ctx)

  const body = Body.parse(await readJsonBody(req))
  const menu = body.menu as MenuKey
  const key = SETTING_KEY[menu]
  const field = TREE_FIELD[menu]
  const schema = registryEntry(key).schema
  const meta = auditMetaFromRequest(req)

  // The transaction returns the resulting version directly so the response
  // never re-reads the row post-commit — a transient blip on a re-read must
  // not turn a successful write into a 500 (which a retrying client would then
  // see as a phantom 409 against its now-stale version).
  let result: { changed: boolean; version: number }
  try {
    result = await db.transaction<{ changed: boolean; version: number }>(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT value, version FROM settings WHERE \`key\` = ${key} FOR UPDATE
    `)) as unknown as [Array<{ value: unknown; version: number }>]

    const existing = rows[0]
      ? parseStored(rows[0].value)
      : parseStored(registryEntry(key).default)
    const currentVersion = rows[0]?.version ?? 0
    if (currentVersion !== body.version) throw new HttpError(409, 'version_conflict')

    // Splice the new tree into the FULL setting, then validate the whole
    // shape — the API can never persist a half-valid site_header/footer.
    const spliced = { ...existing, [field]: body.tree }
    let parsed: unknown
    try {
      parsed = schema.parse(spliced)
    } catch {
      throw new HttpError(400, 'invalid_menu')
    }
    const newJson = JSON.stringify(parsed)

    if (!rows[0]) {
      await tx.execute(sql`
        INSERT INTO settings (\`key\`, value, version, updated_by)
        VALUES (${key}, ${newJson}, 1, ${ctx.userId})
      `)
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'create',
        resourceType: 'setting',
        resourceId: key,
        diff: { key, field, via: 'api/cms/nav' } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
      return { changed: true, version: 1 }
    }

    // No-op short-circuit: compare SCHEMA-CLEAN stored value vs the parsed
    // candidate. Parsing the stored side through the same schema (a) drops any
    // transient `__id` an older client persisted, and (b) normalizes legacy/
    // older-version row shapes — so an unchanged menu doesn't spuriously bump
    // the version + write an audit row.
    const storedParsed = schema.safeParse(existing)
    const storedJson = storedParsed.success ? JSON.stringify(storedParsed.data) : null
    if (storedJson === newJson) return { changed: false, version: currentVersion }

    const [updateResult] = (await tx.execute(sql`
      UPDATE settings SET value = ${newJson}, version = version + 1, updated_by = ${ctx.userId}
      WHERE \`key\` = ${key} AND version = ${body.version}
    `)) as unknown as [UpdateResult]
    if (updateResult.affectedRows === 0) throw new HttpError(409, 'version_conflict')

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action: 'update',
      resourceType: 'setting',
      resourceId: key,
      diff: { key, field, via: 'api/cms/nav', version_from: body.version } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
    return { changed: true, version: body.version + 1 }
    })
  } catch (err) {
    // Concurrent first-ever write: two requests both saw no row and both
    // INSERTed; the loser trips the PK dup-key. Report it as the same 409 the
    // UPDATE path uses so a retrying client re-reads the now-existing version
    // rather than seeing a phantom 500.
    if (isDuplicateKey(err)) throw new HttpError(409, 'version_conflict')
    throw err
  }

  if (result.changed) await safeRevalidate([tag.settings]).catch(() => undefined)

  return new Response(JSON.stringify({ ok: true, version: result.version }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
