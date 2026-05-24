import 'server-only'
import { parseBlockData, type BlockData } from './block-registry'
import { parseSectionData } from './project-section-registry'
import { sanitizeRichText } from './sanitize'
import { HttpError } from '@/lib/auth/requireRole'

// Object keys that carry HTML. The walker sanitizes their string values
// BEFORE Zod parsing — so the Zod string-length cap is enforced against
// the post-sanitization payload (not the raw input the editor sent).
// Add a new richtext field name here AND keep the Zod schema's max(...)
// length aligned.
//
// The first two are content_blocks fields (block-registry); the rest
// are project_sections fields (project-section-registry). Sharing one
// set across both registries keeps the sanitize boundary uniform — a
// future block-type that adopts `summary_richtext` doesn't need any
// extra wiring here.
const RICHTEXT_FIELDS = new Set([
  'body_richtext',
  'quote',
  'summary_richtext',
  'value_richtext',
  'gate_message_richtext',
])

// Keys that prototype-pollute the output object when used as bracket
// assignment targets. `out['__proto__'] = x` sets the prototype, not an
// own property — Zod's `data[key]` access then traverses the chain and
// can see fields the caller never owned. Skip these unconditionally; any
// payload that "needs" them is malicious.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Depth cap. The 256KB jsonBody ceiling implicitly bounds shape, but a
// pathological array-of-array payload can still recurse past Node's
// default stack budget on slim worker handlers. 32 levels is well past
// any legitimate block payload (deepest registered block has 3 nested
// objects).
const MAX_DEPTH = 32

function walkAndSanitize(value: unknown, depth = 0): unknown {
  // Malformed REQUEST, not server fault — surface as 400 like ZodError
  // does. Matches the UnknownBlockTypeError pattern: bounded structured
  // error code, no attacker input in err.message.
  if (depth > MAX_DEPTH) throw new HttpError(400, 'payload_too_deep')
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((v) => walkAndSanitize(v, depth + 1))
  }
  // Object.create(null) — no inherited keys; cannot be polluted from the
  // walker's own writes. Cast back to Record at return.
  const out = Object.create(null) as Record<string, unknown>
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) continue
    out[k] =
      RICHTEXT_FIELDS.has(k) && typeof v === 'string'
        ? sanitizeRichText(v)
        : walkAndSanitize(v, depth + 1)
  }
  return out
}

/**
 * Write boundary. Editor payloads pass through here exactly once on the way
 * to a database write. Sanitizes every RICHTEXT_FIELDS value, then runs the
 * Zod schema for `type` — bounds + shape + literal unions.
 *
 * Throws ZodError on shape failure (caught by withError → 400); throws
 * Error('unknown_block_type:...') for a missing schema (caught the same way).
 */
export function parseAndSanitize(type: string, raw: unknown): BlockData {
  const sanitized = walkAndSanitize(raw)
  return parseBlockData(type, sanitized)
}

/**
 * Read boundary. Every block fetched from the database goes through this
 * before reaching the renderer — defence-in-depth against:
 *  - a DB restore that re-introduces pre-sanitizer payloads
 *  - a future migration that bypasses the parse boundary
 *  - operator-level INSERT that skips the API entirely
 *
 * Same code path as the write boundary so we cannot diverge.
 */
export function parseForRead(type: string, raw: unknown): BlockData {
  return parseAndSanitize(type, raw)
}

/**
 * Write boundary for project sections — same shape as parseAndSanitize
 * but dispatches to project-section-registry instead of block-registry.
 * Sanitize first (so Zod's max(...) caps run on post-DOMPurify output),
 * then parse + validate via the section's Zod schema.
 *
 * Throws ZodError on shape failure (→ 400 via withError); throws
 * Error('unknown_section_key:...') if `key` isn't a registered section.
 */
export function parseProjectSectionAndSanitize(
  key: string,
  raw: unknown,
): unknown {
  const sanitized = walkAndSanitize(raw)
  return parseSectionData(key, sanitized)
}

/**
 * Read boundary for project sections. Symmetric with parseForRead for
 * blocks — protects the public render path from a tampered DB cell or
 * a DB restore that re-introduces pre-sanitizer payloads.
 */
export function parseProjectSectionForRead(
  key: string,
  raw: unknown,
): unknown {
  return parseProjectSectionAndSanitize(key, raw)
}
