// Pages-CMS 409 recovery: HMAC-signed localStorage diff buffer.
// Spec §3.5 — threat model: defend against attackers who can WRITE
// localStorage (browser extensions without script-injection, sibling
// tabs pre-CSP, stored-XSS that fires AFTER jti rotation) but cannot
// READ the in-memory HMAC key. Live in-context XSS is OUT OF SCOPE
// for this defence — covered upstream by CSP nonce + strict-dynamic +
// DOMPurify.
//
// HKDF derivation (LOCKED):
//   IKM    = jti-bytes (UUIDv4 ASCII from the __Host-bwc_session_jti cookie)
//   info   = "pages-cms-draft:HMAC-SHA256-v1:page-" || pageId-be-bytes
//   salt   = empty (per RFC 5869 §3.1: salt length should ≥ hash output;
//                   a 4-byte pageId-as-salt collides in low bits across
//                   pages, so pageId moves into `info` for per-page
//                   key-separation without the salt-too-short concern)
//   length = 32 bytes
//
// Version bump policy (LOCKED): any change to the HMAC algorithm,
// KDF, MAC primitive, OR the label substring `HMAC-SHA256-v1`
// triggers a new label. Old buffered diffs become unverifiable on
// next mount and silently drop (same operator-facing UX as session
// rotation per spec §11.33).

import { JTI_COOKIE_NAME } from '@/lib/auth/cookie-names'

const HKDF_INFO_PREFIX = 'pages-cms-draft:HMAC-SHA256-v1:page-'
const HMAC_LENGTH_BYTES = 32
const KEY_PREFIX = 'pages-cms:draft:'
const PER_ENTRY_CAP_BYTES = 8 * 1024 // 8KB per key — spec §3.5
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000 // 24h
// MariaDB pages.id is INT (2^31 - 1 max). Anything beyond that can
// neither exist in the DB nor be encoded as a 32-bit big-endian
// unsigned integer. Reject explicitly with a clear error so a future
// pageId widening (BIGINT) triggers a deliberate version bump rather
// than silently truncating into a colliding info.
const PAGEID_MAX = 0xffffffff

// ─── In-memory fallback when localStorage is full ─────────────────────
// QuotaExceededError mid-write leaves the diff with nowhere to go.
// Stash on window.__pagesCmsDraftBuffer so a reload-from-tab-still-open
// recovers; cleared automatically once the operator successfully saves.
declare global {
  interface Window {
    __pagesCmsDraftBuffer?: Record<string, BufferedDraft>
  }
}

// ─── Public types ─────────────────────────────────────────────────────
export interface BufferedDraft {
  pageId: number
  baseVersion: number
  // `diff` is the operator's in-progress field changes — the editor's
  // dirty form state at the moment 409 surfaced. Schema is consumer-
  // defined (the editor knows what to re-apply); this module treats it
  // as opaque JSON.
  diff: unknown
  // ISO timestamp for the 24h TTL sweep.
  createdAt: string
  // HMAC-SHA256(hkdf-key, JSON.stringify({pageId, baseVersion, diff, createdAt}))
  // Hex-encoded for round-trip through localStorage (binary survives
  // less reliably than ASCII across browser extensions / DevTools).
  sig: string
}

export type BufferReadOutcome =
  | { kind: 'ok'; drafts: BufferedDraft[] }
  | { kind: 'no-key' } // no jti cookie / no session
  | { kind: 'rotated'; droppedCount: number } // some entries failed HMAC (session rotation)

// ─── jti cookie reader ────────────────────────────────────────────────
function readJtiCookie(): string | null {
  if (typeof document === 'undefined') return null
  const name = JTI_COOKIE_NAME
  // Anchored to start OR semicolon-space so a substring of another
  // cookie's name can't match. Cookie values are URL-encoded by the
  // setter when needed; jti is a UUIDv4 (no encoding required) but
  // defensively decode anyway.
  const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&')
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${escaped}=([^;]*)`),
  )
  return match ? decodeURIComponent(match[1] ?? '') : null
}

// ─── HKDF + HMAC primitives (Web Crypto) ──────────────────────────────
async function deriveHmacKey(jti: string, pageId: number): Promise<CryptoKey | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  if (!Number.isInteger(pageId) || pageId <= 0 || pageId > PAGEID_MAX) {
    return null
  }
  const encoder = new TextEncoder()
  const ikm = encoder.encode(jti)
  const prefix = encoder.encode(HKDF_INFO_PREFIX)
  const pidBuf = new ArrayBuffer(4)
  new DataView(pidBuf).setUint32(0, pageId, /* littleEndian */ false)
  const info = new Uint8Array(prefix.length + 4)
  info.set(prefix, 0)
  info.set(new Uint8Array(pidBuf), prefix.length)

  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info,
    },
    ikmKey,
    HMAC_LENGTH_BYTES * 8,
  )
  return crypto.subtle.importKey(
    'raw',
    bits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function toHex(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes)
  let out = ''
  for (let i = 0; i < arr.length; i++) {
    out += arr[i]!.toString(16).padStart(2, '0')
  }
  return out
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// Canonical payload for sign/verify. Including `createdAt` in the
// signed envelope ensures a replayed (old) entry from a prior session
// still fails verification even if the attacker somehow knew the
// stale jti — because the new jti's derived key won't match.
interface SignedEnvelope {
  pageId: number
  baseVersion: number
  diff: unknown
  createdAt: string
}

function canonicalize(env: SignedEnvelope): string {
  // Fixed-key order. JSON.stringify on this exact object literal is
  // stable across engines that preserve insertion order (V8, JSC,
  // SpiderMonkey all do for string keys). Future-proofing against an
  // engine that re-orders: build the JSON ourselves.
  return JSON.stringify({
    pageId: env.pageId,
    baseVersion: env.baseVersion,
    diff: env.diff,
    createdAt: env.createdAt,
  })
}

async function signEnvelope(
  env: SignedEnvelope,
  key: CryptoKey,
): Promise<string> {
  const data = new TextEncoder().encode(canonicalize(env))
  const sig = await crypto.subtle.sign('HMAC', key, data)
  return toHex(sig)
}

async function verifyEnvelope(
  env: SignedEnvelope,
  sigHex: string,
  key: CryptoKey,
): Promise<boolean> {
  const sigBytes = fromHex(sigHex)
  if (!sigBytes) return false
  const data = new TextEncoder().encode(canonicalize(env))
  // BufferSource variance fix: crypto.subtle.verify wants
  // ArrayBufferView<ArrayBuffer> | ArrayBuffer (NOT ArrayBufferLike,
  // which would include SharedArrayBuffer). Allocating a fresh
  // Uint8Array(length) yields a view whose underlying buffer is
  // unambiguously ArrayBuffer — and tiny (32 bytes) so the copy is
  // free.
  const copy = new Uint8Array(sigBytes.byteLength)
  copy.set(sigBytes)
  return crypto.subtle.verify('HMAC', key, copy, data)
}

// ─── localStorage helpers (silent failure) ────────────────────────────

function safeLsSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch (e) {
    if (
      e instanceof DOMException &&
      (e.name === 'QuotaExceededError' || e.code === 22)
    ) {
      return false
    }
    return false
  }
}

function safeLsRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // SecurityError (Safari private mode) — non-fatal.
  }
}

// In-memory fallback bucket. Keyed identically to localStorage so a
// consumer can recover from either store transparently.
function memoryBucket(): Record<string, BufferedDraft> {
  if (typeof window === 'undefined') {
    return {}
  }
  if (!window.__pagesCmsDraftBuffer) {
    window.__pagesCmsDraftBuffer = {}
  }
  return window.__pagesCmsDraftBuffer
}

// ─── Public API ───────────────────────────────────────────────────────

export interface WriteOutcome {
  kind: 'ok' | 'too-large' | 'no-key' | 'quota-fallback'
}

/**
 * HMAC-sign + persist a 409-recovery diff. Returns:
 *   - 'ok'              — written to localStorage successfully.
 *   - 'too-large'       — serialized payload > 8KB cap; NOT written.
 *                         Consumer surfaces stronger modal per spec.
 *   - 'no-key'          — no jti cookie / no Web Crypto; NOT written.
 *   - 'quota-fallback'  — localStorage threw QuotaExceededError; fell
 *                         back to in-memory window.__pagesCmsDraftBuffer.
 *                         Consumer surfaces toast: "Local recovery
 *                         storage is full — keep this tab open".
 */
export async function writeDraftBuffer(
  pageId: number,
  baseVersion: number,
  diff: unknown,
): Promise<WriteOutcome> {
  const jti = readJtiCookie()
  if (!jti) return { kind: 'no-key' }
  const key = await deriveHmacKey(jti, pageId)
  if (!key) return { kind: 'no-key' }

  const env: SignedEnvelope = {
    pageId,
    baseVersion,
    diff,
    createdAt: new Date().toISOString(),
  }
  const sig = await signEnvelope(env, key)
  const draft: BufferedDraft = { ...env, sig }
  const json = JSON.stringify(draft)
  // Cap is on the SERIALIZED payload (the localStorage byte cost).
  // Each char in a non-Latin-1 string costs ≥2 bytes in localStorage
  // engines that store UTF-16 internally; we measure UTF-8 byte length
  // for a conservative cap that matches what nginx / CDN intermediaries
  // would meter.
  const byteSize = new TextEncoder().encode(json).length
  if (byteSize > PER_ENTRY_CAP_BYTES) {
    return { kind: 'too-large' }
  }

  const lsKey = `${KEY_PREFIX}${pageId}:${baseVersion}`
  const ok = safeLsSet(lsKey, json)
  if (!ok) {
    memoryBucket()[lsKey] = draft
    return { kind: 'quota-fallback' }
  }
  return { kind: 'ok' }
}

/**
 * Enumerate ALL `pages-cms:draft:{pageId}:*` keys for `pageId` (multi-
 * tab support: three tabs editing concurrently can produce three
 * buffered diffs at different baseVersion values). Each entry's HMAC
 * is verified against the current session's derived key; entries that
 * fail verification are dropped silently from the result.
 *
 * Returns:
 *   - 'no-key'    — no jti cookie / no Web Crypto (pre-login render).
 *                   Caller should not surface any recovery UI.
 *   - 'rotated'   — at least one entry failed HMAC AND zero entries
 *                   succeeded. Signals "this looks like a session-
 *                   rotation drop" so the caller can emit the
 *                   one-time toast: "Recovered drafts from before
 *                   this session were discarded for security."
 *   - 'ok'        — zero or more valid drafts. If `drafts` is empty
 *                   the caller suppresses the recovery banner.
 */
export async function readDraftBuffer(
  pageId: number,
): Promise<BufferReadOutcome> {
  const jti = readJtiCookie()
  if (!jti) return { kind: 'no-key' }
  const key = await deriveHmacKey(jti, pageId)
  if (!key) return { kind: 'no-key' }

  const prefix = `${KEY_PREFIX}${pageId}:`
  const candidates: Array<{ key: string; raw: string }> = []

  // Pull from localStorage.
  if (typeof window !== 'undefined') {
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (k && k.startsWith(prefix)) {
          const raw = window.localStorage.getItem(k)
          if (raw !== null) candidates.push({ key: k, raw })
        }
      }
    } catch {
      // Safari private mode etc — silent.
    }
  }
  // ALSO pull from the in-memory fallback bucket. A QuotaExceededError
  // entry from this session wouldn't be in localStorage but should
  // still surface in the recovery banner.
  const mem = memoryBucket()
  for (const [k, v] of Object.entries(mem)) {
    if (k.startsWith(prefix)) {
      candidates.push({ key: k, raw: JSON.stringify(v) })
    }
  }

  const valid: BufferedDraft[] = []
  let droppedCount = 0
  const now = Date.now()

  for (const { key: lsKey, raw } of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Garbage JSON — drop the entry. Could be a partial write from a
      // process crash or a manual DevTools edit.
      safeLsRemove(lsKey)
      droppedCount++
      continue
    }
    const draft = toBufferedDraft(parsed)
    if (!draft) {
      safeLsRemove(lsKey)
      droppedCount++
      continue
    }
    // TTL: drop entries past 24h. The clock-skew tolerance is one
    // tick; we don't try to be precise here (a buffered draft expiring
    // 1s later than expected is benign).
    const createdMs = Date.parse(draft.createdAt)
    if (!Number.isFinite(createdMs) || now - createdMs > ENTRY_TTL_MS) {
      safeLsRemove(lsKey)
      droppedCount++
      continue
    }
    // Same-page sanity check — a future bug could mis-key entries.
    if (draft.pageId !== pageId) {
      safeLsRemove(lsKey)
      droppedCount++
      continue
    }
    const env: SignedEnvelope = {
      pageId: draft.pageId,
      baseVersion: draft.baseVersion,
      diff: draft.diff,
      createdAt: draft.createdAt,
    }
    const ok = await verifyEnvelope(env, draft.sig, key).catch(() => false)
    if (!ok) {
      // Silent drop on HMAC mismatch — defence against tampered or
      // session-rotated entries. Spec §3.5: cleared on next mount with
      // a one-time toast per §11.33.
      safeLsRemove(lsKey)
      droppedCount++
      continue
    }
    valid.push(draft)
  }

  // Newest baseVersion first — operator reviews the latest state first.
  valid.sort((a, b) => b.baseVersion - a.baseVersion)

  if (droppedCount > 0 && valid.length === 0) {
    return { kind: 'rotated', droppedCount }
  }
  return { kind: 'ok', drafts: valid }
}

/**
 * Remove a specific buffered diff after the operator has either
 * re-applied or discarded it. Idempotent — calling on a missing key
 * is a no-op.
 */
export function discardDraft(pageId: number, baseVersion: number): void {
  const lsKey = `${KEY_PREFIX}${pageId}:${baseVersion}`
  safeLsRemove(lsKey)
  delete memoryBucket()[lsKey]
}

/**
 * Best-effort shape guard for a parsed localStorage entry. Returns the
 * typed value or null if any required field is missing / wrong type.
 * The `diff` field is intentionally typed `unknown` — the consumer
 * (editor) owns its schema.
 */
function toBufferedDraft(value: unknown): BufferedDraft | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (
    typeof o.pageId === 'number' &&
    Number.isInteger(o.pageId) &&
    o.pageId > 0 &&
    typeof o.baseVersion === 'number' &&
    Number.isInteger(o.baseVersion) &&
    o.baseVersion >= 0 &&
    'diff' in o &&
    typeof o.createdAt === 'string' &&
    typeof o.sig === 'string'
  ) {
    return {
      pageId: o.pageId,
      baseVersion: o.baseVersion,
      diff: o.diff,
      createdAt: o.createdAt,
      sig: o.sig,
    }
  }
  return null
}
