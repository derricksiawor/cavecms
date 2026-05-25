import 'server-only'
import { GoogleGenAI } from '@google/genai'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { registry } from '@/lib/cms/settings-registry'
import {
  AAD_AI_CONFIG_API_KEY,
  decryptSecret,
  type EncryptedSecret,
} from '@/lib/security/secretCipher'

// Gemini client factory. Two entry points:
//
//   getActiveAiClient()    — RUNTIME path. Reads ai_config from the
//                            settings table, decrypts the stored API
//                            key, builds a per-process cached client.
//                            Cache invalidates on settings PATCH (the
//                            route calls `resetActiveAiClientCache()`)
//                            and additionally on every fresh encryption
//                            (the cache key includes the ciphertext's
//                            iv+tag pair, unique per write).
//
//   buildAiClient({apiKey}) — VERIFY path. The Settings → AI Assistant
//                            "Test connection" button submits a plaintext
//                            candidate that hasn't been saved yet. The
//                            verify endpoint passes it here directly,
//                            bypassing DB read + decryption.
//
// Concurrency: getActiveAiClient guards the rebuild path with an
// in-flight Promise singleton (`pendingBuild`) so two simultaneous
// requests after a cache invalidation share ONE decrypt+construct,
// not two. Without this, key-rotation events would briefly trigger
// per-request decryption thrash.

interface AiClientCacheEntry {
  cacheKey: string
  client: GoogleGenAI
}

let cachedClient: AiClientCacheEntry | null = null
let pendingBuild: Promise<AiClientCacheEntry> | null = null

interface AiConfigRow {
  enabled: boolean
  provider: 'gemini'
  apiKey?: EncryptedSecret | null
  apiKeyLast4?: string
  models?: { inline?: string; chat?: string }
  inlineEnabled: boolean
  chatEnabled: boolean
  voicePreset: string
  customVoiceNotes?: string
  verifiedAt?: string
}

interface SettingValueRow {
  value: unknown
}

// Read + parse the stored ai_config row. Returns the validated shape
// on success; returns `null` for "row missing" OR "row present but
// schema-malformed". The latter would normally be a hard fail-closed,
// but the Settings → AI page (PR 2) needs a path to display + repair
// a corrupt row without taking the whole admin surface down with a
// ZodError 500. Callers that need stricter behaviour can grep for
// `ai_config_corrupt` in the structured-log output.
export async function getStoredAiConfig(): Promise<AiConfigRow | null> {
  const [rows] = (await db.execute(sql`
    SELECT value FROM settings WHERE \`key\` = 'ai_config'
  `)) as unknown as [SettingValueRow[]]
  if (!rows[0]) return null
  const raw = rows[0].value
  const parsedJson: unknown =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw)
          } catch {
            return null
          }
        })()
      : raw
  if (parsedJson === null) return null
  const parseResult = registry.ai_config.schema.safeParse(parsedJson)
  if (!parseResult.success) {
    // Log structured-error and treat as unconfigured. Operator visits
    // the dashboard, sees "AI is not configured", can re-save to fix.
    // Better than a 500 from every consumer of this function.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'ai_config_corrupt',
        issues: parseResult.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      }),
    )
    return null
  }
  return parseResult.data as AiConfigRow
}

// Build a fresh client. The verify endpoint calls this with a plaintext
// candidate before saving; the runtime path uses getActiveAiClient.
export function buildAiClient(opts: { apiKey: string }): GoogleGenAI {
  if (typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
    throw new Error('buildAiClient: apiKey is required')
  }
  return new GoogleGenAI({ apiKey: opts.apiKey })
}

// Runtime entry. Throws when AI is disabled, not configured, or the
// stored key fails to decrypt — callers wrap in their route's error
// boundary so the user sees a clean message instead of a stack trace.
export async function getActiveAiClient(): Promise<{
  client: GoogleGenAI
  config: AiConfigRow
}> {
  const config = await getStoredAiConfig()
  if (!config) {
    throw new AiUnconfiguredError('ai_not_configured')
  }
  if (!config.enabled) {
    throw new AiDisabledError()
  }
  if (!config.apiKey) {
    throw new AiUnconfiguredError('ai_key_missing')
  }
  // Cache key derived from the stored ciphertext's iv+tag pair — these
  // change on every re-encryption (fresh IV per write), so a key
  // rotation invalidates the cache automatically. Explicit
  // resetActiveAiClientCache() is also called by the settings PATCH
  // route as belt-and-braces.
  const cacheKey = `${config.apiKey.iv}.${config.apiKey.tag}`
  if (cachedClient && cachedClient.cacheKey === cacheKey) {
    return { client: cachedClient.client, config }
  }
  // Promise-singleton: if another request is already building the
  // client for the same cacheKey, await its result instead of
  // duplicating the decrypt+construct work.
  if (pendingBuild) {
    const entry = await pendingBuild
    if (entry.cacheKey === cacheKey) {
      return { client: entry.client, config }
    }
    // Stale build (different cacheKey) — fall through to a fresh
    // rebuild. Bounded recursion: pendingBuild was non-null only for
    // the duration of that prior promise.
  }
  const buildPromise = (async (): Promise<AiClientCacheEntry> => {
    let plaintext: string
    try {
      plaintext = decryptSecret(config.apiKey!, AAD_AI_CONFIG_API_KEY)
    } catch (err) {
      throw new AiDecryptError(
        err instanceof Error ? err.message : 'unknown',
      )
    }
    const client = buildAiClient({ apiKey: plaintext })
    return { cacheKey, client }
  })()
  pendingBuild = buildPromise
  try {
    const entry = await buildPromise
    cachedClient = entry
    return { client: entry.client, config }
  } finally {
    // Clear the in-flight singleton only if it's still the one we set
    // (another invalidation could have started a fresh build mid-wait).
    if (pendingBuild === buildPromise) pendingBuild = null
  }
}

// Force-flush the cache. Called from /api/admin/settings PATCH after a
// successful ai_config write — settings.value just changed, the next
// getActiveAiClient call must re-read + re-decrypt. Safe to call
// repeatedly; no-op if cache is already empty.
export function resetActiveAiClientCache(): void {
  cachedClient = null
  // Note: an in-flight `pendingBuild` is NOT cancelled — that promise
  // resolves to a client for the PREVIOUS cacheKey and its waiters
  // proceed with that old client (one final request). The cacheKey
  // check in getActiveAiClient ensures waiters whose cacheKey doesn't
  // match fall through to a fresh build. Net effect: at most one
  // stale-client response per rotation window, never more.
}

// Typed errors so the verify route + future propose route can return
// clean status codes without sniffing error messages. The `detail`
// field on AiDecryptError is intentionally absent (was removed) — its
// only producer is decryptSecret throws, and those carry stable
// codes (cipher_bad_*) we don't want to echo to clients.
export class AiUnconfiguredError extends Error {
  readonly code: 'ai_not_configured' | 'ai_key_missing'
  readonly name = 'AiUnconfiguredError'
  constructor(code: 'ai_not_configured' | 'ai_key_missing') {
    super(code)
    this.code = code
  }
}

export class AiDisabledError extends Error {
  readonly code = 'ai_disabled' as const
  readonly name = 'AiDisabledError'
  constructor() {
    super('ai_disabled')
  }
}

export class AiDecryptError extends Error {
  readonly code = 'ai_key_decrypt_failed' as const
  readonly name = 'AiDecryptError'
  // Internal-only detail (the underlying cipher_bad_* code from
  // decryptSecret). NOT surfaced to clients by route handlers.
  readonly innerCode: string
  constructor(innerCode: string) {
    super('ai_key_decrypt_failed')
    this.innerCode = innerCode
  }
}
