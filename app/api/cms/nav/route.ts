import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { registry } from '@/lib/cms/settings-registry'
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

async function readSetting(
  key: 'site_header' | 'footer',
): Promise<{ value: Record<string, unknown>; version: number }> {
  const entry = registryEntry(key)
  const [rows] = (await db.execute(sql`
    SELECT value, version FROM settings WHERE \`key\` = ${key}
  `)) as unknown as [Array<{ value: unknown; version: number }>]
  const raw = rows[0] ? parseStored(rows[0].value) : parseStored(entry.default)
  const version = rows[0]?.version ?? 0
  // Validate fail-closed to the registry default — mirrors lib/cms/getSettings
  // so the public API serves the SAME schema-clean tree the renderer shows
  // (an out-of-band-tampered / over-cap / extra-key row degrades to the safe
  // default here exactly as it does in SiteHeader/SiteFooter). `version` is
  // read from the raw row (it is not part of the Zod schema).
  const result = entry.schema.safeParse(raw)
  const value = (result.success ? result.data : entry.default) as Record<string, unknown>
  return { value, version }
}

// ── GET /api/cms/nav — public-readable menu trees ────────────────────
export const GET = withError(async () => {
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
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      authed = false
    } else {
      throw err
    }
  }

  const header = await readSetting('site_header')
  const footer = await readSetting('footer')
  const headerItems = Array.isArray(header.value.navItems) ? header.value.navItems : []
  const footerCols = Array.isArray(footer.value.columns) ? footer.value.columns : []

  const payload = authed
    ? {
        header: { items: headerItems, version: header.version },
        footer: { columns: footerCols, version: footer.version },
      }
    : {
        header: { items: headerItems },
        footer: { columns: footerCols },
      }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Public reads are cacheable for a short window; authed reads carry
      // version data scoped to the caller and must never be shared-cached.
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
  checkMutationRate(ctx.userId)

  const body = Body.parse(await readJsonBody(req))
  const menu = body.menu as MenuKey
  const key = SETTING_KEY[menu]
  const field = TREE_FIELD[menu]
  const schema = registryEntry(key).schema
  const meta = auditMetaFromRequest(req)

  const changed = await db.transaction<boolean>(async (tx) => {
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
        action: 'create',
        resourceType: 'setting',
        resourceId: key,
        diff: { key, field, via: 'api/cms/nav' } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
      return true
    }

    // No-op short-circuit on identical stored JSON (comparison on the
    // PARSED stored value vs the parsed candidate — both schema-clean, so
    // the client's transient `__id` keys never cause a false diff).
    if (JSON.stringify(parseStored(rows[0].value)) === newJson) return false

    const [result] = (await tx.execute(sql`
      UPDATE settings SET value = ${newJson}, version = version + 1, updated_by = ${ctx.userId}
      WHERE \`key\` = ${key} AND version = ${body.version}
    `)) as unknown as [UpdateResult]
    if (result.affectedRows === 0) throw new HttpError(409, 'version_conflict')

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'update',
      resourceType: 'setting',
      resourceId: key,
      diff: { key, field, via: 'api/cms/nav', version_from: body.version } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
    return true
  })

  if (changed) await safeRevalidate([tag.settings]).catch(() => undefined)

  // Echo the resulting version for round-trip clients.
  const after = await readSetting(key)
  return new Response(JSON.stringify({ ok: true, version: after.version }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
