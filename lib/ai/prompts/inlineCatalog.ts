// Client-safe catalogs for the inline AI sparkle.
//
// Tone chips + translate language list are pure data — string literal
// tuples that both the server (prompt builder, request validator) AND
// the client (popover tone chip row, language combobox) need to read.
//
// Kept in a separate module without `import 'server-only'` so the
// client bundle can import these names without dragging in the server-
// side prompt builders, the Gemini SDK, or any Node-only dependency.
//
// `lib/ai/prompts/inline.ts` (server-only) re-exports these for
// callers that prefer one import site. Either path is fine; the
// safety boundary is the server-only marker on inline.ts.

export const TONE_CHIPS = [
  'punchier',
  'shorter',
  'longer',
  'warmer',
  'professional',
  'casual',
  'playful',
  'authoritative',
  'simpler',
  'elegant',
] as const

export type ToneChip = (typeof TONE_CHIPS)[number]

// 30 languages — must equal the marketing promise. Each entry pairs
// a BCP-47-ish code with an English label. Add a new entry here +
// to the request-body validator's enum in lib/ai/runProposal.ts.
export const TRANSLATE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'da', label: 'Danish' },
  { code: 'fi', label: 'Finnish' },
  { code: 'pl', label: 'Polish' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'el', label: 'Greek' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'he', label: 'Hebrew' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'fa', label: 'Persian' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
] as const

export type TranslateLanguageCode = (typeof TRANSLATE_LANGUAGES)[number]['code']

const CODE_SET = new Set<string>(TRANSLATE_LANGUAGES.map((l) => l.code))

export function isTranslateLanguage(value: string): value is TranslateLanguageCode {
  return CODE_SET.has(value)
}
