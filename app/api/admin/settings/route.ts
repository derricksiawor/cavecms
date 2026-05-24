import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { registry, type SettingsKey } from '@/lib/cms/settings-registry'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { env } from '@/lib/env'
import {
  guardIpLists,
  guardMaintenance,
  guardRecaptcha,
  guardLoginPath,
  SecurityGuardFailure,
} from '@/lib/security/patchGuards'
import { clearZohoAccessTokenCache } from '@/lib/crm/zoho'

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date
}

function jsonGuardFail(err: SecurityGuardFailure): Response {
  return new Response(JSON.stringify(err.payload), {
    status: 422,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
}

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    ORDER BY \`key\`
  `)) as unknown as [SettingRow[]]
  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})

const Body = z
  .object({
    key: z.string().min(1).max(60),
    value: z.unknown(),
    version: z.number().int().nonnegative(),
  })
  .strict()

interface UpdateResult {
  affectedRows: number
}

// PATCH /api/admin/settings — write one registry-key at a time. Two
// validation passes: outer Zod (envelope shape) then the per-key
// schema from settings-registry. A mismatched value bounces at the
// registry layer before the UPDATE, with the Zod error mapped to a
// generic 400 by withError. version is bumped only on a real change;
// version-drift conflicts surface as 409 so the client reloads.
export const PATCH = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = Body.parse(await readJsonBody(req))
  const entry = (registry as Record<string, { schema: z.ZodTypeAny }>)[body.key]
  if (!entry) throw new HttpError(400, 'unknown_setting')

  // Step-up reauth gate is scoped to security-sensitive setting keys
  // (login_path, recaptcha config, IP allow/deny lists, maintenance
  // mode, session policies) PLUS the CRM credential keys
  // (integrations_hubspot, integrations_zoho_crm) — both of which
  // store API tokens that grant a third-party CRM full lead-write
  // access. The `security_` prefix convention covers the first
  // class; the explicit allowlist below covers the second so the
  // two CRM keys aren't gated by name-only convention. Routine
  // analytics/tracking/widget integrations + mobile_cta + footer +
  // SEO + contact don't re-prompt.
  const REAUTH_KEYS = new Set<string>(['integrations_hubspot', 'integrations_zoho_crm'])
  if (body.key.startsWith('security_') || REAUTH_KEYS.has(body.key)) {
    await requireFreshReauth(ctx.jti)
  }

  // Credential-preserving merge for the two CRM keys. The admin
  // Integrations page redacts secret fields before shipping the row
  // to the client form (privateAppAccessToken / oauthClientSecret /
  // oauthRefreshToken). The form sends those fields as empty strings
  // when the operator didn't touch the input. If we ran Zod against
  // those empty strings the .min(20) refinements would reject the
  // save — and even if Zod accepted, we'd clobber the stored secret
  // with empty. Merge incoming undefined/empty credentials with the
  // existing row's stored values BEFORE validation so an untouched
  // input means "keep the existing token". Operator clearing a token
  // explicitly sends `null` (form Button: "Clear stored token").
  let valueForValidation = body.value
  // Tracks whether Zoho CRM credentials actually changed (vs the
  // operator just editing region / formSourceMap). Used post-commit
  // to decide whether to invalidate the in-process access-token
  // cache — flushing on every settings save would force an
  // unnecessary refresh-token round-trip after benign edits.
  let zohoCredsChanged = false
  if (body.key === 'integrations_hubspot' || body.key === 'integrations_zoho_crm') {
    const [existingRows] = (await db.execute(sql`
      SELECT value FROM settings WHERE \`key\` = ${body.key}
    `)) as unknown as [Array<{ value: unknown }>]
    const existing: Record<string, unknown> =
      existingRows[0]
        ? typeof existingRows[0].value === 'string'
          ? (() => {
              try {
                return JSON.parse(existingRows[0].value as string) as Record<string, unknown>
              } catch {
                return {}
              }
            })()
          : ((existingRows[0].value as Record<string, unknown>) ?? {})
        : {}
    const incoming = (body.value && typeof body.value === 'object' && !Array.isArray(body.value)
      ? (body.value as Record<string, unknown>)
      : {})
    const credentialFields =
      body.key === 'integrations_hubspot'
        ? ['privateAppAccessToken']
        : ['oauthClientId', 'oauthClientSecret', 'oauthRefreshToken']
    const merged: Record<string, unknown> = { ...incoming }
    for (const field of credentialFields) {
      const incomingVal = merged[field]
      const existingVal = existing[field]
      // Empty string OR undefined → "keep stored" (operator didn't
      // touch the redacted field). null → "clear explicitly".
      if (incomingVal === undefined || incomingVal === '') {
        if (existingVal !== undefined) merged[field] = existingVal
        else delete merged[field]
      } else if (incomingVal === null) {
        delete merged[field]
      }
    }
    valueForValidation = merged
    // Compare per-credential delta for the Zoho cache-invalidation
    // decision. The HubSpot integration has no in-process cache, so
    // we only track Zoho.
    if (body.key === 'integrations_zoho_crm') {
      zohoCredsChanged = credentialFields.some(
        (f) => (merged[f] ?? null) !== (existing[f] ?? null),
      )
    }
  }

  const parsed = entry.schema.parse(valueForValidation)
  const meta = auditMetaFromRequest(req)

  // Resolve saver IP for the lockout guards. nginx prod sets x-real-ip;
  // clientIpFromHeaders falls back to 0.0.0.0 when no trusted source
  // is available. 0.0.0.0 will fail every CIDR check unless the
  // operator explicitly lists 0.0.0.0/0 — operator error in that case.
  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const saverIp = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'

  // Lockout-risk guards for the security_* keys. Pure-value guards
  // (ip_lists, maintenance) run here before the TX so an early reject
  // returns 422 without holding a row lock. DB-touching guards
  // (recaptcha, login_path) run INSIDE the TX below — they need the
  // previous row's value + a chance to write the pending row inside
  // the same atomic commit.
  //
  // SecurityGuardFailure carries a structured payload — caught by the
  // outer try/catch and rendered as 422 JSON the client maps to a
  // precise lockout message.
  if (body.key === 'security_ip_lists') {
    try {
      guardIpLists(parsed as never, saverIp)
    } catch (err) {
      if (err instanceof SecurityGuardFailure) return jsonGuardFail(err)
      throw err
    }
  }
  if (body.key === 'security_maintenance') {
    try {
      guardMaintenance(parsed as never, saverIp)
    } catch (err) {
      if (err instanceof SecurityGuardFailure) return jsonGuardFail(err)
      throw err
    }
  }

  // UPDATE + audit insert wrapped in a single TX so a partial commit
  // can't leave a setting changed without a forensic trail. The earlier
  // version ran the audit insert post-UPDATE without a TX — settings
  // mutations are rare, but they're also exactly the events operators
  // need to trace, so the gap was worth closing.
  //
  // Returns true if a real change landed, false on no-op. The
  // post-TX revalidate is gated on that flag — no point bumping the
  // cache tag when nothing changed.
  const newValueJson = JSON.stringify(parsed)
  let changed: boolean
  try {
    changed = await db.transaction<boolean>(async (tx) => {
    // SELECT current value + version under FOR UPDATE so we can
    // detect (a) version conflict, (b) row-not-seeded, (c) no-op
    // (same value re-submitted) in one trip. Storing JSON strings
    // means a deterministic JSON.stringify comparison is reliable
    // — registry-validated values are structurally clean.
    const [rows] = (await tx.execute(sql`
      SELECT value, version FROM settings
      WHERE \`key\` = ${body.key as SettingsKey}
      FOR UPDATE
    `)) as unknown as [Array<{ value: unknown; version: number }>]

    // Resolve prevValue for the DB-touching guards: parsed JSON from
    // the row (if exists), else the registry default (first-save).
    const prevValueForGuards: unknown = rows[0]
      ? typeof rows[0].value === 'string'
        ? (() => {
            try {
              return JSON.parse(rows[0].value as string)
            } catch {
              return null
            }
          })()
        : rows[0].value
      : (registry as Record<string, { default: unknown }>)[body.key]?.default

    // In-TX guards. recaptcha guard needs userId + session jti + prev
    // keys to decide whether a fresh verification row is required
    // (session-bound so a stolen session can't replay). login_path
    // guard writes the pending row alongside the path change so the
    // change + revert are atomic, and records the saver's userId for
    // the same-user check on confirm.
    if (body.key === 'security_recaptcha') {
      await guardRecaptcha(tx, ctx.userId, ctx.jti, prevValueForGuards as never, parsed as never)
    }
    if (body.key === 'security_login_path') {
      // prev path: existing DB value OR env.LOGIN_PATH bootstrap fallback.
      const prevPath =
        (prevValueForGuards as { path?: string } | null | undefined)?.path ?? env.LOGIN_PATH
      await guardLoginPath(tx, (parsed as { path: string }).path, prevPath, ctx.userId)
    }

    // First-save path: the admin Settings page synthesizes a
    // `{version:0, value: registry.default}` row for any registry key
    // that hasn't been seeded yet, so the operator can edit a freshly-
    // added setting without first running `pnpm db:seed`. INSERT the
    // row with version=1 + an audit entry, then return changed=true so
    // the cache-bust runs.
    if (!rows[0]) {
      if (body.version !== 0) {
        // Operator sent a non-zero version against a non-existent
        // row — implies they're saving against a stale page state
        // after the row was deleted (rare, but possible via SQL
        // surgery). Treat as a conflict, not a 404.
        throw new HttpError(409, 'version_conflict')
      }
      await tx.execute(sql`
        INSERT INTO settings (\`key\`, value, version, updated_by)
        VALUES (${body.key as SettingsKey}, ${newValueJson}, 1, ${ctx.userId})
      `)
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'create',
        resourceType: 'setting',
        resourceId: body.key,
        diff: { key: body.key, version_from: 0 } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
      return true
    }
    if (rows[0].version !== body.version) {
      throw new HttpError(409, 'version_conflict')
    }
    // Comparison: stringify the row's parsed value with the same
    // serializer we'll write. JSON column comes back parsed via
    // mysql2 → drizzle. Object key order is deterministic for
    // registry-typed shapes (Zod outputs key-ordered objects).
    const currentJson = JSON.stringify(rows[0].value)
    if (currentJson === newValueJson) {
      // No-op: skip UPDATE + audit. Return ok:true so the client
      // bumps its local version counter forward to stay in sync.
      return false
    }
    const [result] = (await tx.execute(sql`
      UPDATE settings
      SET value = ${newValueJson},
          version = version + 1,
          updated_by = ${ctx.userId}
      WHERE \`key\` = ${body.key as SettingsKey}
        AND version = ${body.version}
    `)) as unknown as [UpdateResult]
    if (result.affectedRows === 0) {
      // Race: another writer slipped in between SELECT and UPDATE.
      // Throw to roll back and surface as 409.
      throw new HttpError(409, 'version_conflict')
    }
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'update',
      resourceType: 'setting',
      resourceId: body.key,
      diff: {
        key: body.key,
        version_from: body.version,
      } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
    return true
  })
  } catch (err) {
    if (err instanceof SecurityGuardFailure) return jsonGuardFail(err)
    throw err
  }

  // Await safeRevalidate BEFORE constructing the response. Earlier
  // version used queueMicrotask to defer the call, but Next 15 requires
  // revalidateTag to run inside the request context — a microtask
  // queued after the response was already partially constructed risks
  // landing outside that context, which silently no-ops the bust.
  // Awaiting it adds <1ms (in-memory tag invalidation) and removes the
  // fragility. Skipped on no-op (changed=false).
  if (changed) {
    await safeRevalidate([tag.settings]).catch(() => undefined)
    // Invalidate the in-process Zoho OAuth access-token cache ONLY
    // when the operator actually rotated / cleared OAuth
    // credentials. Region or formSourceMap edits don't require a
    // token flush — a previously minted token is still valid against
    // the (region, clientId) pair the operator has unchanged.
    if (zohoCredsChanged) {
      clearZohoAccessTokenCache()
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
