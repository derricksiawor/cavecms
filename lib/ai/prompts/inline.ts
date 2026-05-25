import 'server-only'

// Per-intent prompt + responseSchema builders for the inline AI
// sparkle. Each function returns:
//   - userMessage: the string handed to Gemini as the user turn
//   - responseSchema: the JSON Schema fragment Gemini fills in
//
// The system prompt (from `prompts/system.ts`) is the same across
// every intent. The intent prompts add ONE thing: the operator's
// specific request, scoped to one of the four affordances.
//
// All responseSchemas are NARROW. We deliberately do NOT serialise
// the full block-registry Zod schema as a JSON Schema for Gemini —
// Zod's union/refine/effect features don't round-trip cleanly to
// JSON Schema, and Gemini's responseSchema support is most reliable
// on plain primitive trees. Instead:
//
//   - Rewrite / Translate / Fillin → { fields: { [path]: string } }
//     Path keys are restricted to the block's resolved field paths.
//     After Gemini responds, mergeFieldValues writes those strings
//     into a copy of the block data, then parseAndSanitize re-
//     validates the full block — the safety wall is the Zod schema
//     PLUS DOMPurify, not Gemini's schema awareness.
//
//   - Suggest → { options: [string, string, string] } (exactly 3)
//     Suggest only runs on blocks with a single primary short scalar.
//     The operator picks one option; we write it into that one field.

import type { ResolvedField } from '../inlineEligibility'
import {
  TONE_CHIPS,
  TRANSLATE_LANGUAGES,
  isTranslateLanguage,
  type ToneChip,
  type TranslateLanguageCode,
} from './inlineCatalog'

// Re-export the client-safe catalogs so server callers can keep a
// single import site. Client callers (popover UI cards) import
// directly from `inlineCatalog` to avoid pulling in the server-only
// prompt builders below.
export {
  TONE_CHIPS,
  TRANSLATE_LANGUAGES,
  isTranslateLanguage,
  type ToneChip,
  type TranslateLanguageCode,
}

const TONE_EXPANSIONS: Record<ToneChip, string> = {
  punchier:
    'Make it punchier — same meaning, fewer words, more energy. Cut filler. Stronger verbs.',
  shorter:
    'Make it shorter — reduce length by roughly 30% without losing the meaning. Cut adjectives first, then redundant clauses.',
  longer:
    'Make it longer — expand to roughly 40% more length by adding concrete detail, examples, or supporting context. Stay on topic; do not pad with filler.',
  warmer:
    'Make it warmer and friendlier — more inviting, more conversational, more human. Use "you" if it fits.',
  professional:
    'Make it more professional — crisper, business-appropriate, less casual. Trim hedging and chatty asides.',
  casual:
    'Make it more casual — loosen up, drop formality. Contractions are fine. Sound like a person, not a press release.',
  playful:
    'Make it more playful — light, witty, a touch unexpected. Keep one tasteful moment of personality; do not overdo it.',
  authoritative:
    'Make it more authoritative — confident, declarative, expert voice. Drop hedges ("might", "could", "perhaps"). Make claims directly.',
  simpler:
    'Make it simpler — use plain language, drop jargon, use shorter words and sentences. Aim for easier reading.',
  elegant:
    'Make it more elegant — considered, editorial, magazine-quality. Concrete nouns. Quietly capable. Avoid hype words.',
}

const TRANSLATE_LANGUAGE_BY_CODE = new Map(
  TRANSLATE_LANGUAGES.map((l) => [l.code, l.label] as const),
)

// ── Gemini responseSchema shapes ────────────────────────────────────
// The Gemini SDK accepts a Schema object (their flavour of JSON Schema)
// at `config.responseSchema`. We pass a plain JS object that the SDK
// converts internally. `type` is a string enum, `properties` is the
// object-shape map, `required` is an array. No `additionalProperties`
// — the SDK rejects unknown keys, which means we have to enumerate
// every accepted field path explicitly in the `properties` object.

interface GeminiSchema {
  type: 'object' | 'string' | 'array' | 'integer' | 'number' | 'boolean'
  description?: string
  properties?: Record<string, GeminiSchema>
  required?: string[]
  items?: GeminiSchema
  minItems?: number
  maxItems?: number
  maxLength?: number
}

/** Build the rewrite/translate/fillin responseSchema. Each operator-
 *  facing field path becomes a string property; all are required so
 *  Gemini cannot silently elide one. Per-field maxLength caps mirror
 *  the Zod schema so a runaway generation gets clipped at the
 *  Gemini side before round-tripping. */
function buildFieldsSchema(fields: ReadonlyArray<ResolvedField>): GeminiSchema {
  const properties: Record<string, GeminiSchema> = {}
  const required: string[] = []
  for (const f of fields) {
    properties[f.path] = {
      type: 'string',
      maxLength: f.maxLength,
      description:
        f.kind === 'richtext'
          ? `Replacement HTML for ${f.path}. Allowed tags: <p>, <br>, <strong>, <em>, <a href>, <ul>, <ol>, <li>.`
          : `Replacement plain text for ${f.path}.`,
    }
    required.push(f.path)
  }
  return {
    type: 'object',
    properties: {
      fields: { type: 'object', properties, required },
    },
    required: ['fields'],
  }
}

/** Suggest schema — exactly 3 string options for the block's single
 *  primary scalar. minItems = maxItems = 3 so Gemini cannot return
 *  2 or 4. The shorter of the field's maxLength vs 200 caps each
 *  individual option — Suggest options render side-by-side so they
 *  need to be short. */
function buildSuggestSchema(primary: ResolvedField): GeminiSchema {
  return {
    type: 'object',
    properties: {
      options: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'string',
          maxLength: Math.min(primary.maxLength, 200),
          description: `One of three alternative options for ${primary.path}.`,
        },
      },
    },
    required: ['options'],
  }
}

// ── User message builders ───────────────────────────────────────────

export interface IntentBaseArgs {
  fields: ReadonlyArray<ResolvedField>
  freeText?: string
}

export interface RewriteIntentArgs extends IntentBaseArgs {
  intent: 'rewrite'
  toneChip?: ToneChip
}
export interface TranslateIntentArgs extends IntentBaseArgs {
  intent: 'translate'
  language: TranslateLanguageCode
}
export interface FillinIntentArgs extends IntentBaseArgs {
  intent: 'fillin'
}
export interface SuggestIntentArgs extends IntentBaseArgs {
  intent: 'suggest'
}

export type IntentArgs =
  | RewriteIntentArgs
  | TranslateIntentArgs
  | FillinIntentArgs
  | SuggestIntentArgs

export interface BuiltIntent {
  userMessage: string
  responseSchema: GeminiSchema
}

/** Compose the user-turn message for the intent + the matching
 *  responseSchema. The system prompt (built separately) carries the
 *  voice/site/block context; this function adds ONLY the per-call
 *  instruction. */
export function buildIntent(args: IntentArgs): BuiltIntent {
  // Collapse \r \n \t to single spaces before interpolation. The
  // request-body validator's UNSAFE_PROMPT_CHARS allows whitespace
  // because operators legitimately paste multi-line clipboards. But
  // inlining raw newlines into the user-turn would let an attacker's
  // free-text mimic the system-prompt's markdown headers
  // (`## SYSTEM OVERRIDE\n...`) and increase the chance Gemini treats
  // it as authoritative. Single-line interpolation is safe.
  const cleanFree = (args.freeText ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  if (args.intent === 'rewrite') {
    const toneLine = args.toneChip
      ? TONE_EXPANSIONS[args.toneChip]
      : 'Rewrite the existing text while keeping its meaning and structure intact.'
    const freeLine = cleanFree
      ? `Additional operator direction: ${cleanFree}`
      : ''
    return {
      userMessage: [
        'Rewrite the editable text fields of this block.',
        toneLine,
        freeLine,
        '',
        'For each editable field listed in section 4 of your system prompt, return the rewritten value at the same path key under `fields`. Keep field-to-field meaning correspondence — do not move content between fields.',
      ]
        .filter(Boolean)
        .join('\n'),
      responseSchema: buildFieldsSchema(args.fields),
    }
  }
  if (args.intent === 'translate') {
    const langLabel = TRANSLATE_LANGUAGE_BY_CODE.get(args.language) ?? args.language
    const freeLine = cleanFree
      ? `Translation notes from the operator: ${cleanFree}`
      : ''
    return {
      userMessage: [
        `Translate the editable text fields of this block into ${langLabel}.`,
        'Translate faithfully — preserve the brand voice, tone, and emphasis of the original. Translate idioms into idioms; do not transliterate proper nouns or brand names. Keep numbers, dates, and contact details intact unless they are clearly localisable.',
        freeLine,
        '',
        'For each editable field listed in section 4 of your system prompt, return the translated value at the same path key under `fields`.',
      ]
        .filter(Boolean)
        .join('\n'),
      responseSchema: buildFieldsSchema(args.fields),
    }
  }
  if (args.intent === 'fillin') {
    const freeLine = cleanFree
      ? `Operator brief: ${cleanFree}`
      : 'No specific brief — write a sensible starting draft based on the block type, site context, and surrounding content.'
    return {
      userMessage: [
        'This block is empty or nearly empty. Fill in a complete, ready-to-edit starter draft for every editable field.',
        freeLine,
        '',
        'For each editable field listed in section 4 of your system prompt, return a complete starting value at the same path key under `fields`. Keep individual fields concise — short headlines, body text proportional to the field\'s max-length but not pushing the cap. The operator will refine afterwards.',
      ].join('\n'),
      responseSchema: buildFieldsSchema(args.fields),
    }
  }
  // suggest — find the single primary scalar. The runtime already
  // gates Suggest behind supportsSuggest(blockType); throwing here
  // is a defensive fail-closed against a route bug, not a user-
  // facing error path.
  const primary = args.fields.find((f) => f.primary)
  if (!primary) {
    throw new Error('buildIntent: suggest intent requires a primary field')
  }
  const freeLine = cleanFree
    ? `Operator hint: ${cleanFree}`
    : ''
  return {
    userMessage: [
      `Suggest three distinct alternative options for the primary field "${primary.path}".`,
      'Each option should be standalone and complete — not three variations of the same phrase. Mix angle, tone, and length within the field\'s constraints. Stay on-brand and on-topic.',
      freeLine,
      '',
      'Return exactly three options in the `options` array. Each option must fit in a single short line.',
    ]
      .filter(Boolean)
      .join('\n'),
    responseSchema: buildSuggestSchema(primary),
  }
}

// ── Defence-in-depth: parse the model's response back into a {path:
// string} map BEFORE handing to mergeFieldValues. Catches edge cases
// where Gemini ignores the schema (rare) or wraps the response in
// commentary (caught by the JSON.parse) — either way we surface
// validation_failed cleanly. ─────────────────────────────────────────

export interface ParsedFieldsResponse {
  fields: Record<string, string>
}
export interface ParsedSuggestResponse {
  options: string[]
}

export function parseFieldsResponse(
  raw: string,
  allowedPaths: ReadonlySet<string>,
): ParsedFieldsResponse | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const fields = (obj as Record<string, unknown>)['fields']
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null
  const out: Record<string, string> = {}
  for (const [path, val] of Object.entries(fields as Record<string, unknown>)) {
    if (!allowedPaths.has(path)) {
      // Gemini returned a path we didn't request — drop it. The
      // safety wall would also catch this on re-validation, but
      // dropping early keeps the audit log clean.
      continue
    }
    if (typeof val !== 'string') continue
    if (path === '__proto__' || path === 'constructor' || path === 'prototype') {
      continue
    }
    out[path] = val
  }
  if (Object.keys(out).length === 0) return null
  return { fields: out }
}

export function parseSuggestResponse(raw: string): ParsedSuggestResponse | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const options = (obj as Record<string, unknown>)['options']
  if (!Array.isArray(options)) return null
  const cleaned: string[] = []
  for (const item of options) {
    if (typeof item !== 'string') continue
    cleaned.push(item)
    if (cleaned.length >= 3) break
  }
  if (cleaned.length !== 3) return null
  return { options: cleaned }
}
