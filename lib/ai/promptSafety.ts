import 'server-only'

// Operator-prompt safety gate shared by the inline (/api/ai/stream) and
// chat (/api/ai/propose) surfaces. Both routes reject any user-supplied
// prompt text containing:
//   - C0 control chars (U+0000–U+001F, excluding tab/newline/CR which
//     are stripped at a different layer)
//   - DEL (U+007F)
//   - Bidi overrides (U+202A–U+202E, U+2066–U+2069) — RLO/PDF/etc can
//     visually spoof rendered output
//   - Zero-width chars (U+200B–U+200D, U+FEFF) — invisible to the
//     operator + can smuggle prompt-override sequences past human
//     review
//
// The gate runs ONCE on each operator-controlled string before it
// reaches the model. It does NOT cover Gemini's output (a separate
// DOMPurify pass on richtext fields handles that surface).
//
// Two helpers:
//   - containsUnsafePromptChars(s)  predicate
//   - assertSafePrompt(s, label)    throws Error('unsafe_prompt:<label>')

// Built via a code-point range so the source is grep-able and avoids
// embedding raw bidi-override / zero-width literals in the source (a
// past version inlined them and it tripped editor display + diff
// tooling). The compiled RegExp matches the same set the inline
// runProposal.ts regex covers.
const UNSAFE_RANGES: ReadonlyArray<[number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x007f],
  [0x200b, 0x200d],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
]

function buildPattern(): RegExp {
  const parts = UNSAFE_RANGES.map(([lo, hi]) => {
    const start = `\\u${lo.toString(16).padStart(4, '0')}`
    if (lo === hi) return start
    const end = `\\u${hi.toString(16).padStart(4, '0')}`
    return `${start}-${end}`
  })
  return new RegExp(`[${parts.join('')}]`)
}

const UNSAFE_PATTERN = buildPattern()

export function containsUnsafePromptChars(s: string): boolean {
  return UNSAFE_PATTERN.test(s)
}

export class UnsafePromptError extends Error {
  readonly name = 'UnsafePromptError'
  readonly label: string
  constructor(label: string) {
    super(`unsafe_prompt:${label}`)
    this.label = label
  }
}

export function assertSafePrompt(s: string, label: string): void {
  if (UNSAFE_PATTERN.test(s)) {
    throw new UnsafePromptError(label)
  }
}
