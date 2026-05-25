import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkAiVerifyRate } from '@/lib/auth/cmsRateLimit'
import { buildAiClient } from '@/lib/ai/client'
import { AI_MODEL_IDS } from '@/lib/cms/settings-registry'
import {
  AAD_AI_CONFIG_API_KEY,
  decryptSecret,
  type EncryptedSecret,
} from '@/lib/security/secretCipher'

// POST /api/admin/ai/verify — probe Gemini credentials WITHOUT
// persisting them. Used by the Settings → AI Assistant "Test
// connection" button so the operator can validate their API key
// before flipping `enabled: true` on the ai_config row.
//
// SECURITY MODEL:
//
//   - Only `admin` role can hit this (editor/viewer cannot, even though
//     they can use AI features once enabled).
//   - CSRF required.
//   - Dedicated 5/min/user rate-limit bucket (checkAiVerifyRate). The
//     generic 300/min mutation bucket is way too loose: each verify
//     burns the operator's Gemini quota AND lets a stolen-session
//     attacker use the box as an oracle for "is this Gemini API key
//     live?" 5/min is the human cadence.
//   - When a key is ALREADY stored on the ai_config row, the route
//     refuses an arbitrary fresh `apiKey` candidate. This prevents the
//     "validate-arbitrary-Gemini-keys-via-operator's-server" oracle
//     pattern. Operators who genuinely need to rotate their key go
//     through the Settings PATCH (step-up reauth gated in PR 2) — the
//     verify probe re-runs against the just-saved ciphertext.
//
// PATTERN MIRROR: this route's shape mirrors /api/admin/email/verify.
// Where the two diverge:
//   - This route has the dedicated AI-verify rate limit (Gemini quota
//     is non-trivial to refill).
//   - This route honours an `AbortSignal.timeout(10s)` and checks
//     `signal.aborted` in the catch (the @google/genai SDK doesn't
//     reliably set err.name on timeouts, so a name-based check misses).
//
// VERIFIED_AT: this route does NOT update settings.ai_config.verifiedAt
// on success — that's the settings PATCH route's job (lands in PR 2).
// Pure probe.

export const dynamic = 'force-dynamic'

const VERIFY_TIMEOUT_MS = 10_000

// Strict body shape. Pass-through for unknown fields (the Settings form
// may send the full ai_config draft; we only read apiKey + model).
// Plaintext apiKey capped at 200 chars to cover Google's longest known
// key format with headroom; characters constrained to ASCII printable
// because Gemini keys are URL-safe.
const Body = z.object({
  apiKey: z
    .string()
    .max(200)
    .regex(
      /^[\x21-\x7e]*$/,
      'invalid_api_key_chars',
    )
    .optional(),
  model: z.enum(AI_MODEL_IDS).optional(),
})

// First-time verify (no stored key, no model picked yet) falls back to
// the cheapest GA model so the operator can validate the key shape
// before picking a model in the settings form.
const VERIFY_FALLBACK_MODEL = 'gemini-2.5-flash' as const

interface SettingValueRow {
  value: unknown
}

interface VerifyOkResponse {
  ok: true
  model: string
  latencyMs: number
}

interface VerifyFailResponse {
  ok: false
  // Stable error code for the client to switch on. `detail` is a short
  // human-readable line for the toast — it does NOT echo raw SDK error
  // messages (which could carry operator key fragments in pathological
  // cases).
  error:
    | 'no_key'
    | 'arbitrary_key_refused'
    | 'unauthorized'
    | 'unknown_model'
    | 'allowlist_drift'
    | 'rate_limited'
    | 'timeout'
    | 'network_error'
    | 'decrypt_failed'
    | 'verify_failed'
  detail?: string
}

function json(
  body: VerifyOkResponse | VerifyFailResponse,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
}

// Map an SDK error to a stable code. Two-stage:
//   1. If the AbortSignal aborted, surface as `timeout` regardless of
//      what the SDK threw. The signal is the source of truth.
//   2. Otherwise classify by HTTP status or message inspection.
// Never echo raw SDK message text into the response — `detail` is
// operator-facing copy we control.
function classifyGeminiError(
  err: unknown,
  signal: AbortSignal,
  modelFromAllowlist: boolean,
): { error: VerifyFailResponse['error']; detail: string } {
  if (signal.aborted) {
    return { error: 'timeout', detail: 'Gemini did not respond within 10 seconds.' }
  }
  const e = err as {
    status?: number
    message?: string
    name?: string
    cause?: { name?: string; message?: string }
  }
  const msg = (e?.message ?? '').toLowerCase()
  const causeMsg = (e?.cause?.message ?? '').toLowerCase()
  if (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    causeMsg.includes('econnrefused') ||
    causeMsg.includes('enotfound')
  ) {
    return {
      error: 'network_error',
      detail: 'Could not reach generativelanguage.googleapis.com.',
    }
  }
  if (typeof e?.status === 'number') {
    if (e.status === 401 || e.status === 403) {
      return { error: 'unauthorized', detail: 'Gemini rejected the API key.' }
    }
    if (e.status === 404) {
      // 404 with a model that's in OUR allowlist means Google
      // deprecated it on us — operators get a CMS-side message,
      // not blamed for picking a bad ID. 404 with a non-allowlist
      // model never actually happens (Zod gate at body parse),
      // but the branch is defensive.
      if (modelFromAllowlist) {
        return {
          error: 'allowlist_drift',
          detail: 'This Gemini model is no longer offered. Update CaveCMS or pick a different model.',
        }
      }
      return {
        error: 'unknown_model',
        detail: 'Gemini does not recognise this model ID.',
      }
    }
    if (e.status === 429) {
      return {
        error: 'rate_limited',
        detail: 'Gemini rate limit hit. Try again in a moment.',
      }
    }
  }
  return { error: 'verify_failed', detail: 'Gemini returned an error.' }
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkAiVerifyRate(ctx.userId)

  const body = Body.parse(await readJsonBody(req))

  // Resolve plaintext apiKey + model with this priority:
  //   1. Operator pasted a fresh apiKey in this request → use it
  //      (but ONLY if no key is currently stored — see arbitrary_key_refused).
  //   2. Operator left apiKey empty → decrypt the stored ciphertext.
  //   3. No stored key AND no incoming → 422 no_key.
  let plaintext = (body.apiKey ?? '').trim()
  let modelChoice = body.model
  // Track whether a stored key exists; we use this to gate against the
  // "validate arbitrary keys via operator quota" oracle pattern.
  let storedKeyExists = false

  // Always read the stored row (we need it for storedKeyExists + the
  // model fallback). Cheap — single indexed select.
  const [rows] = (await db.execute(sql`
    SELECT value FROM settings WHERE \`key\` = 'ai_config'
  `)) as unknown as [SettingValueRow[]]
  if (rows[0]) {
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
    if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
      const stored = parsedJson as {
        apiKey?: EncryptedSecret | null
        models?: { inline?: string }
      }
      storedKeyExists = !!stored.apiKey
      // Reuse stored apiKey only when incoming was empty.
      if (!plaintext && stored.apiKey) {
        try {
          plaintext = decryptSecret(stored.apiKey, AAD_AI_CONFIG_API_KEY)
        } catch {
          return json(
            {
              ok: false,
              error: 'decrypt_failed',
              // Most likely cause: SECRETS_ENCRYPTION_KEY rotated since
              // this row was written. Every encrypted-at-rest secret then
              // needs to be re-entered through the dashboard. Operator
              // gets one actionable line, not a stack trace.
              detail: 'Stored key could not be decrypted (likely after a SECRETS_ENCRYPTION_KEY rotation). Re-enter the key to refresh.',
            },
            422,
          )
        }
      }
      // Same fallback hierarchy for model choice.
      if (!modelChoice && stored.models?.inline) {
        const candidate = stored.models.inline
        if ((AI_MODEL_IDS as readonly string[]).includes(candidate)) {
          modelChoice = candidate as (typeof AI_MODEL_IDS)[number]
        }
      }
    }
  }

  // Oracle defence: when a key is ALREADY on file, a fresh apiKey in
  // the request body would let any admin (or a stolen session) probe
  // arbitrary Gemini keys through the operator's server. Refuse. The
  // operator's path to rotate is Settings → AI → paste new key → Save
  // (which triggers re-verify against the new stored ciphertext).
  if (storedKeyExists && (body.apiKey ?? '').trim().length > 0) {
    return json(
      {
        ok: false,
        error: 'arbitrary_key_refused',
        detail: 'Save your new key first; verify runs against the stored value.',
      },
      422,
    )
  }

  if (!plaintext) {
    return json(
      {
        ok: false,
        error: 'no_key',
        detail: 'Paste your Gemini API key, then click Test connection.',
      },
      422,
    )
  }

  const model = modelChoice ?? VERIFY_FALLBACK_MODEL
  const modelFromAllowlist = (AI_MODEL_IDS as readonly string[]).includes(model)
  const client = buildAiClient({ apiKey: plaintext })

  // AbortSignal is the source-of-truth for the 10s deadline. The SDK
  // may or may not set err.name on timeouts; the post-catch
  // signal.aborted check (in classifyGeminiError) handles both cases.
  const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    await client.models.generateContent({
      model,
      contents: 'ping',
      config: {
        maxOutputTokens: 1,
        abortSignal: signal,
      },
    })
    const latencyMs = Date.now() - startedAt
    return json({ ok: true, model, latencyMs }, 200)
  } catch (err) {
    const { error, detail } = classifyGeminiError(err, signal, modelFromAllowlist)
    return json({ ok: false, error, detail }, 422)
  }
})
