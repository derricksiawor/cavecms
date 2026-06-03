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
import {
  AAD_AI_CONFIG_API_KEY,
  AAD_SEO_INDEXING_API,
  encryptSecret,
  last4 as last4Of,
} from '@/lib/security/secretCipher'
import { resetActiveAiClientCache } from '@/lib/ai/client'

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

// Credential fields per key — stripped server-side before serialization.
// Mirrors the per-page redaction at:
//   - app/(admin)/admin/settings/integrations/page.tsx (HubSpot,
//     Zoho CRM)
//   - app/(admin)/admin/settings/email/page.tsx (SMTP password)
// The /api/admin/settings GET serves the SAME admin who can read
// those pages, but a stolen-session attacker or a browser XSS pulls
// the unredacted JSON in one curl. Same redaction discipline as the
// individual pages.
const CREDENTIAL_FIELDS_BY_KEY: Record<string, string[]> = {
  smtp_config: ['password'],
  integrations_hubspot: ['privateAppAccessToken'],
  integrations_zoho_crm: [
    'oauthClientId',
    'oauthClientSecret',
    'oauthRefreshToken',
  ],
  // Google reCAPTCHA server secret — used by siteverify on the auth
  // login route + every public lead form. Leaking it lets an attacker
  // mint valid g-recaptcha-response tokens against the operator's
  // site, bypassing bot protection on every form.
  security_recaptcha: ['secretKey'],
  // Encrypted Gemini API key envelope. We redact even the CIPHERTEXT
  // before serving GETs — defence-in-depth: a stolen admin session
  // shouldn't get the envelope to take offline. The UI shows
  // `apiKeyLast4` ("ends in 1234") to confirm a key is on file.
  ai_config: ['apiKey'],
  // Encrypted Google Indexing API service-account JSON envelope. Redact
  // even the ciphertext on GET — the operator confirms it's on file via
  // the cleartext `serviceAccountEmail` display field.
  seo_indexing_api: ['serviceAccountJson'],
}

function redactSettingsRow(row: SettingRow): SettingRow {
  const fields = CREDENTIAL_FIELDS_BY_KEY[row.key]
  if (!fields) return row
  // Value may arrive as a JSON string (MariaDB LONGTEXT-aliased JSON
  // column) or a parsed object (some drivers). Handle both.
  let parsed: Record<string, unknown>
  if (typeof row.value === 'string') {
    try {
      parsed = JSON.parse(row.value) as Record<string, unknown>
    } catch {
      return row
    }
  } else if (row.value && typeof row.value === 'object' && !Array.isArray(row.value)) {
    parsed = { ...(row.value as Record<string, unknown>) }
  } else {
    return row
  }
  for (const f of fields) {
    // Blank ANY present credential, not just string-shaped ones. The
    // CRM/SMTP/reCAPTCHA secrets are strings, but ai_config.apiKey and
    // seo_indexing_api.serviceAccountJson are object-shaped EncryptedSecret
    // ENVELOPES — a `typeof === 'string'` check let their ciphertext cross
    // the wire on GET. The UI confirms "on file" via the cleartext
    // apiKeyLast4 / serviceAccountEmail fields, never the envelope itself.
    const v = parsed[f]
    if (v != null && v !== '') {
      parsed[f] = ''
    }
  }
  // Return same wire-shape as the original (string vs object).
  return {
    ...row,
    value: typeof row.value === 'string' ? JSON.stringify(parsed) : parsed,
  }
}

// API tokens (Bearer) may READ/WRITE ONLY these content/branding/SEO/contact
// keys via /api/admin/settings. Everything else — session_config, updates,
// install_state/updates_state, every integrations_* (the GTM/GA4/Ads/Hotjar
// keys inject third-party script onto every public page → stored-XSS reach),
// all security_* (security_login_path is the hidden admin login URL!),
// smtp_config, ai_config — is DENIED to tokens regardless of reauth state.
// Explicit allowlist so any newly-added settings key is token-denied by
// default until reviewed. Single source for BOTH the GET read filter and the
// PATCH write guard so the two cannot drift.
const TOKEN_WRITABLE_SETTINGS = new Set<string>([
  'contact_info',
  'social_links',
  'default_seo',
  'footer',
  'site_header',
  'organization_json_ld',
  'theme_palette',
  // Typography roles (which catalog font each role uses) — presentational
  // branding, same trust level as theme_palette. An AI agent can restyle the
  // site's typefaces via the API.
  'typography_roles',
  // NOTE: site_general is deliberately NOT here — its `siteUrl` sets the
  // origin of outbound tokenized email links (newsletter confirm/unsubscribe,
  // brochure) and the canonical host, so a token writing it could harvest
  // per-recipient tokens / hijack the canonical host. siteUrl changes stay
  // interactive-admin + reauth only.
  'mobile_cta',
  // ─── SEO suite (programmatic SEO is a first-class use case) ───
  // An AI agent / automation can manage title templates, social/schema
  // defaults, sitemap config, verification codes, IndexNow, the analysis
  // engine config, robots additions, and the global index policy via the
  // API. These are content/meta-class, same trust level as default_seo.
  // seo_indexing_api is DELIBERATELY excluded — it holds the AES-GCM
  // service-account secret and is reauth-gated like ai_config.
  'seo_titles',
  'seo_indexing',
  'seo_social',
  'seo_schema',
  'seo_sitemap',
  'seo_webmaster',
  'seo_indexnow',
  'seo_robots',
  'seo_analysis',
  // `satisfies SettingsKey[]` makes the build FAIL if any literal stops being
  // a real registry key (rename/typo), so the cap can't silently drift open.
] satisfies SettingsKey[])

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    ORDER BY \`key\`
  `)) as unknown as [SettingRow[]]
  // API-token read cap, symmetric to the write guard: a token must never
  // read security/auth/secret/operational keys (e.g. security_login_path
  // leaks the hidden admin login URL). Filter BEFORE redaction so those keys
  // never reach a token client at all.
  const visible = ctx.viaApiToken
    ? rows.filter((r) => TOKEN_WRITABLE_SETTINGS.has(r.key))
    : rows
  const redacted = visible.map(redactSettingsRow)
  return new Response(JSON.stringify({ items: redacted }), {
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

  // custom_fonts is managed exclusively by /api/admin/fonts (which validates
  // the on-disk binary before adding a row). Editing it through the generic
  // settings PATCH would let an admin point a `file` at an arbitrary path /
  // register a font with no backing file, so it's rejected here.
  if (body.key === 'custom_fonts') {
    throw new HttpError(400, 'managed_by_fonts_endpoint')
  }

  // google_fonts is managed exclusively by /api/admin/fonts/google (which
  // fetches + verifies the woff2 server-side before adding a row). Editing it
  // through the generic settings PATCH would let an admin point a `file` at an
  // arbitrary path / register a font with no backing file, so it's rejected
  // here — same as custom_fonts.
  if (body.key === 'google_fonts') {
    throw new HttpError(400, 'managed_by_fonts_endpoint')
  }

  // API-token write cap — tokens write CONTENT + BRANDING only. A bearer
  // token reaches this route (middleware allows /api/admin/settings) but is
  // refused on any non-allowlisted key. This is the gate that actually
  // enforces the cap for tokens: the reauth gate below covers only a subset
  // (security_* + the credential keys), while several token-dangerous keys
  // (session_config, updates, analytics integrations_*) aren't reauth-gated.
  if (ctx.viaApiToken && !TOKEN_WRITABLE_SETTINGS.has(body.key)) {
    throw new HttpError(403, 'forbidden')
  }

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
  const REAUTH_KEYS = new Set<string>([
    'integrations_hubspot',
    'integrations_zoho_crm',
    // SMTP password is credential-class — gate behind step-up reauth
    // for the same reason CRM tokens are.
    'smtp_config',
    // Gemini API key is credential-class — gate behind step-up reauth.
    // A stolen short-lived admin session must NOT be able to rotate
    // the AI key (would let an attacker proxy all AI traffic through
    // their own key + harvest block content + prompts).
    'ai_config',
    // Google Indexing API service-account JSON — credential-class (a
    // GCP key granting indexing-API write on the operator's property).
    'seo_indexing_api',
  ])
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
  if (
    body.key === 'integrations_hubspot' ||
    body.key === 'integrations_zoho_crm' ||
    body.key === 'smtp_config' ||
    body.key === 'security_recaptcha'
  ) {
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
        : body.key === 'integrations_zoho_crm'
          ? ['oauthClientId', 'oauthClientSecret', 'oauthRefreshToken']
          : body.key === 'smtp_config'
            ? ['password']
            : ['secretKey']
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

  // ─── ai_config: encrypt-on-write credential merge ───
  // Same redaction discipline as the integrations branch, but the form
  // sends apiKey as a PLAINTEXT string (the operator just pasted the
  // key) while the registry schema expects an EncryptedSecret envelope.
  // We transform here: encrypt plaintext → envelope BEFORE Zod parse.
  //
  // Field rules:
  //   apiKey == '' or undefined → preserve stored envelope + last4
  //                              + verifiedAt (operator didn't touch
  //                              the redacted field).
  //   apiKey == null            → clear stored (operator explicit
  //                              "Remove key" button).
  //   apiKey == "<plaintext>"   → encrypt with AAD, derive last4
  //                              server-side, CLEAR verifiedAt
  //                              (re-verification required after
  //                              rotation).
  //
  // apiKeyLast4 from the client is IGNORED — derived server-side from
  // plaintext only. Mitigates the "tampered last4 misleads operator
  // about which key is on file" desync attack.
  let aiKeyChanged = false
  if (body.key === 'ai_config') {
    const [existingRows] = (await db.execute(sql`
      SELECT value FROM settings WHERE \`key\` = 'ai_config'
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
    const merged: Record<string, unknown> = { ...incoming }
    // ALWAYS strip client-supplied apiKeyLast4 — server-derived only.
    delete merged.apiKeyLast4
    const incomingKey = merged.apiKey
    if (incomingKey === undefined || incomingKey === '') {
      // Preserve everything: envelope, last4, verifiedAt.
      if (existing.apiKey !== undefined) merged.apiKey = existing.apiKey
      else delete merged.apiKey
      if (typeof existing.apiKeyLast4 === 'string') {
        merged.apiKeyLast4 = existing.apiKeyLast4
      }
      if (typeof existing.verifiedAt === 'string' && merged.verifiedAt === undefined) {
        merged.verifiedAt = existing.verifiedAt
      }
    } else if (incomingKey === null) {
      // Explicit clear.
      delete merged.apiKey
      delete merged.apiKeyLast4
      delete merged.verifiedAt
      aiKeyChanged = true
    } else if (typeof incomingKey === 'string') {
      const plaintext = incomingKey.trim()
      if (plaintext.length === 0) {
        // Treat whitespace-only as "no change" — same as empty.
        if (existing.apiKey !== undefined) merged.apiKey = existing.apiKey
        else delete merged.apiKey
        if (typeof existing.apiKeyLast4 === 'string') {
          merged.apiKeyLast4 = existing.apiKeyLast4
        }
        if (typeof existing.verifiedAt === 'string' && merged.verifiedAt === undefined) {
          merged.verifiedAt = existing.verifiedAt
        }
      } else {
        // Fresh plaintext → encrypt with AAD, derive last4, clear verifiedAt.
        merged.apiKey = encryptSecret(plaintext, AAD_AI_CONFIG_API_KEY)
        const tail = last4Of(plaintext)
        if (tail) merged.apiKeyLast4 = tail
        else delete merged.apiKeyLast4
        // Force re-verification on rotation. The verify route only
        // sets verifiedAt — this PATCH route never sets it for a fresh
        // key, by design.
        delete merged.verifiedAt
        aiKeyChanged = true
      }
    } else {
      // Anything else (object, number, boolean) is operator error
      // or a malformed client. Fail closed.
      throw new HttpError(400, 'invalid_api_key_value')
    }
    valueForValidation = merged
  }

  // ─── seo_indexing_api: encrypt-on-write credential merge ───
  // Same discipline as ai_config. The form sends serviceAccountJson as a
  // PLAINTEXT JSON string (the operator pasted the GCP key file); the
  // schema expects an EncryptedSecret envelope. We encrypt here.
  //   '' or undefined → preserve stored envelope + serviceAccountEmail.
  //   null            → clear stored (operator "Remove key").
  //   "<json>"        → encrypt with AAD; derive serviceAccountEmail from
  //                     the JSON's client_email (display-only confirmation).
  if (body.key === 'seo_indexing_api') {
    const [existingRows] = (await db.execute(sql`
      SELECT value FROM settings WHERE \`key\` = 'seo_indexing_api'
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
    const incoming =
      body.value && typeof body.value === 'object' && !Array.isArray(body.value)
        ? (body.value as Record<string, unknown>)
        : {}
    const merged: Record<string, unknown> = { ...incoming }
    // serviceAccountEmail is SERVER-DERIVED from the pasted JSON's
    // client_email — NEVER trust the client's value (same discipline as
    // ai_config stripping client-supplied apiKeyLast4). Drop it up front;
    // the branches below re-establish it from the stored row or the
    // freshly-parsed key, so a hand-edited email can't desync from the
    // credential actually on file.
    delete merged.serviceAccountEmail
    const preserveExisting = () => {
      if (existing.serviceAccountJson !== undefined) {
        merged.serviceAccountJson = existing.serviceAccountJson
      } else {
        delete merged.serviceAccountJson
      }
      if (typeof existing.serviceAccountEmail === 'string') {
        merged.serviceAccountEmail = existing.serviceAccountEmail
      }
    }
    const incomingKey = merged.serviceAccountJson
    if (incomingKey === undefined || incomingKey === '') {
      preserveExisting()
    } else if (incomingKey === null) {
      // Explicit clear — serviceAccountEmail already stripped above.
      delete merged.serviceAccountJson
    } else if (typeof incomingKey === 'string') {
      const trimmed = incomingKey.trim()
      if (trimmed.length === 0) {
        preserveExisting()
      } else {
        // Normalise before encrypting: if the paste is valid JSON, minify
        // it (reformatted/pretty-printed JSON can't then inflate the
        // ciphertext past the envelope cap) and derive client_email for
        // the display-only confirmation field. If it isn't valid JSON,
        // encrypt the raw text — the operator learns it's wrong when they
        // test indexing, not via a cryptic 400 here.
        let plaintext = trimmed
        try {
          const sa = JSON.parse(trimmed) as Record<string, unknown>
          if (sa && typeof sa === 'object' && !Array.isArray(sa)) {
            plaintext = JSON.stringify(sa)
            if (typeof sa.client_email === 'string' && sa.client_email.length <= 200) {
              merged.serviceAccountEmail = sa.client_email
            }
          }
        } catch {
          /* not JSON — encrypt raw, leave serviceAccountEmail unset */
        }
        merged.serviceAccountJson = encryptSecret(plaintext, AAD_SEO_INDEXING_API)
      }
    } else {
      throw new HttpError(400, 'invalid_service_account_value')
    }
    valueForValidation = merged
  }

  const parsed = entry.schema.parse(valueForValidation)
  const meta = auditMetaFromRequest(req)

  // SMTP enable-gate. Operators can save the form with `enabled: false`
  // freely while iterating on credentials. Flipping `enabled: true`
  // REQUIRES a successful SMTP handshake against the candidate config
  // — otherwise the operator could persist broken credentials in the
  // "on" state, which would then silently drop every lead notification
  // / password reset / update alert.
  if (body.key === 'smtp_config') {
    const candidate = parsed as {
      enabled?: boolean
      host?: string
      port?: number
      secure?: boolean
      user?: string
      password?: string
      fromAddress?: string
      fromName?: string
    }
    if (candidate.enabled) {
      const { verifyTransport } = await import('@/lib/email/transport')
      const result = await verifyTransport({
        host: candidate.host,
        port: candidate.port ?? 587,
        secure: candidate.secure ?? false,
        user: candidate.user,
        password: candidate.password,
        fromAddress: candidate.fromAddress ?? '',
        fromName: candidate.fromName,
      })
      if (!result.ok) {
        return new Response(
          JSON.stringify({
            error: 'smtp_verify_failed',
            detail: result.error,
          }),
          {
            status: 422,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          },
        )
      }
    }
  }

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
    // Invalidate the in-process Gemini client cache when the
    // operator rotated / cleared the AI API key. Other ai_config
    // edits (toggling enabled, switching models, changing voice
    // preset) don't need a flush — the cache is keyed on the
    // ciphertext's iv+tag which only changes when the key itself
    // is re-encrypted, but we belt-and-braces flush here too so a
    // future cache-key change in lib/ai/client.ts can never miss
    // a rotation event.
    if (aiKeyChanged) {
      resetActiveAiClientCache()
    }
  }

  // Return the AUTHORITATIVE post-write version so the client stays in
  // sync even on a no-op save. When `changed` is true the stored version
  // was bumped to body.version + 1; when false (value unchanged) the
  // optimistic lock above guarantees the stored version still equals
  // body.version, so we echo it back. Purely additive — existing settings
  // clients that ignore the field keep their current behavior; SEO clients
  // adopt this value instead of blindly incrementing, which previously
  // drifted client/server versions on no-op saves and 409'd the next save.
  return new Response(
    JSON.stringify({ ok: true, version: changed ? body.version + 1 : body.version }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})
