import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { z } from 'zod'
import { env } from '@/lib/env'

// AES-256-GCM envelope for operator-provided secrets stored at rest in
// the settings table (currently: ai_config.apiKey; SMTP password is
// flagged for a follow-up migration to this same helper).
//
// Why GCM:
//   - Authenticated encryption — a tampered ciphertext fails decryption
//     loudly instead of silently returning garbage that downstream code
//     might then send to an attacker-controlled endpoint.
//   - 12-byte IV is the GCM standard (96 bits). Larger IVs trigger the
//     internal CBC-style derivation which weakens collision resistance.
//   - 16-byte tag, full strength. Truncation is allowed by the spec but
//     pointless for our payload sizes (we're not bandwidth-constrained).
//
// Why versioned envelope:
//   - The `v` field future-proofs against algorithm rotation. A reader
//     that doesn't recognise the version refuses, never silently
//     "best-effort"s — the operator gets a clear error in `verify` and
//     can re-enter the secret under the new scheme.
//
// Why AAD constants (not stringly-typed):
//   - AAD binds ciphertext to its intended storage location. If a
//     hostile operator (or a buggy patch) copy-pastes the encrypted
//     ai_config.apiKey ciphertext into another settings field that
//     decrypts secrets, the AAD mismatch trips GCM's tag verification
//     and decryption fails. A stringly-typed AAD parameter risks a
//     contributor typing `'aiConfig:apiKey'` at the encrypt site and
//     `'ai_config:apiKey'` at the decrypt site, silently locking the
//     operator out of their own key. The exported constants below are
//     the single source of truth.
//
// Master key:
//   - SECRETS_ENCRYPTION_KEY is required at boot (zod schema in env.ts)
//     and validated to decode to exactly 32 bytes here on first use.
//     Generate with: openssl rand -base64 32

export interface EncryptedSecret {
  v: 1
  alg: 'aes-256-gcm'
  iv: string  // base64
  tag: string // base64
  ct: string  // base64
}

// AAD CONSTANTS — single source of truth. Any module that encrypts an
// ai_config.apiKey MUST import this constant and pass it to encryptSecret;
// the verify route + getActiveAiClient pass the same constant to decrypt.
// Drift between encrypt and decrypt sites would cause silent operator
// lockout from a perfectly valid stored key.
export const AAD_AI_CONFIG_API_KEY = 'ai_config:apiKey' as const
// Google Indexing API service-account JSON (SEO suite). Same binding
// discipline as the AI key — ciphertext is bound to this exact field so
// it can't be copy-pasted into another secret-decrypting setting.
export const AAD_SEO_INDEXING_API = 'seo_indexing_api:serviceAccountJson' as const

const ENVELOPE_VERSION = 1 as const
const ALG = 'aes-256-gcm' as const
const IV_BYTES = 12
const KEY_BYTES = 32

// Stable error codes — never interpolate attacker-controlled values
// (envelope version, algorithm name) into the message string, because
// these end up in error logs and the inner `withError` path in dev mode
// echoes them back to the caller. Code values are matched verbatim by
// the verify route's classifier; do not rename without updating the
// route in app/api/admin/ai/verify/route.ts.
export const CIPHER_ERR_BAD_BASE64 = 'cipher_bad_base64' as const
export const CIPHER_ERR_BAD_PAYLOAD = 'cipher_bad_payload' as const
export const CIPHER_ERR_BAD_VERSION = 'cipher_bad_version' as const
export const CIPHER_ERR_BAD_ALG = 'cipher_bad_alg' as const
export const CIPHER_ERR_BAD_IV_LEN = 'cipher_bad_iv_len' as const
export const CIPHER_ERR_BAD_KEY_LEN = 'cipher_bad_key_len' as const

// Zod schema for the envelope. Settings registry entries that carry an
// encrypted secret embed this so a tampered DB cell (or a malformed
// PATCH body that bypasses the form) is rejected at the same validation
// boundary as every other setting. Lengths are deterministic at the
// chosen IV (12 bytes → 16 base64 chars) and tag (16 bytes → 24 base64
// chars) sizes; the decrypt path independently verifies the decoded
// byte length so the Zod check is the first of two gates.
export const encryptedSecretSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal('aes-256-gcm'),
    iv: z.string().length(16),   // 12 bytes base64 = exactly 16 chars
    tag: z.string().length(24),  // 16 bytes base64 = exactly 24 chars
    // Defensive cap only (the decrypt path re-verifies byte lengths and
    // the GCM tag). 8192 base64 chars ≈ 6KB plaintext — comfortably
    // fits both API keys AND a full GCP service-account JSON (incl.
    // RSA-4096 keys, ~3.8KB → ~5.1KB base64). The SEO suite stores SA
    // JSON in this envelope (seo_indexing_api.serviceAccountJson).
    ct: z.string().max(8192),
  })
  .strict()

let cachedMasterKey: Buffer | null = null

// Strict base64 alphabet — Node's Buffer.from(..., 'base64') is LENIENT
// (silently strips invalid characters), so a copy-paste error that
// embeds whitespace/newlines in the env value would silently produce
// a different 32-byte key than intended. Reject upfront.
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey
  const raw = env.SECRETS_ENCRYPTION_KEY
  if (!STRICT_BASE64.test(raw)) {
    throw new Error(`${CIPHER_ERR_BAD_BASE64}: SECRETS_ENCRYPTION_KEY contains non-base64 characters`)
  }
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `${CIPHER_ERR_BAD_KEY_LEN}: SECRETS_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). Generate with: openssl rand -base64 32`,
    )
  }
  cachedMasterKey = decoded
  return decoded
}

export function encryptSecret(plaintext: string, aad?: string): EncryptedSecret {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptSecret: plaintext must be a string')
  }
  const key = getMasterKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALG, key, iv)
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: ENVELOPE_VERSION,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function decryptSecret(payload: EncryptedSecret, aad?: string): string {
  if (!payload || typeof payload !== 'object') {
    throw new Error(CIPHER_ERR_BAD_PAYLOAD)
  }
  if (payload.v !== ENVELOPE_VERSION) {
    throw new Error(CIPHER_ERR_BAD_VERSION)
  }
  if (payload.alg !== ALG) {
    throw new Error(CIPHER_ERR_BAD_ALG)
  }
  const key = getMasterKey()
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const ct = Buffer.from(payload.ct, 'base64')
  if (iv.length !== IV_BYTES) {
    throw new Error(CIPHER_ERR_BAD_IV_LEN)
  }
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'))
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

// Display-only suffix. We never reveal the full key back to the
// operator — they re-enter it if rotating — but a short suffix helps
// them confirm "yes, this is the key I just pasted" in the Settings UI.
// Stripe/SendGrid use the same pattern. Trims whitespace defensively
// because the verify route + future settings PATCH both .trim() at
// input boundaries but a direct programmatic caller might not.
// For plaintexts ≤ 4 chars we return '' instead of the whole string —
// a 3-char test key would otherwise show its entire contents in the UI,
// which is dangerous in screenshots / docs.
export function last4(plaintext: string): string {
  if (typeof plaintext !== 'string') return ''
  const trimmed = plaintext.trim()
  if (trimmed.length <= 4) return ''
  return trimmed.slice(-4)
}

// Stable identity hash for a plaintext secret, suitable for "has this
// exact key been seen before" comparisons WITHOUT round-tripping
// through decryption. Returns the last 8 hex chars of SHA-256 — full
// hash collapses to a fingerprint short enough for log lines but with
// enough entropy (~32 bits) that an attacker can't easily preimage
// a candidate key from one observation.
export function fingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(-8)
}

// Test-only cache reset. Guarded so a stray production caller (an
// accidentally-imported test util, a code-coverage scanner that touches
// every exported symbol) cannot force a key re-read at runtime. The
// next getMasterKey() call after reset re-decodes from env — harmless
// in tests, surprising in prod.
export function __resetMasterKeyCacheForTests(): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error('__resetMasterKeyCacheForTests: not_test_runtime')
  }
  cachedMasterKey = null
}
