// Shared theme-tone resolver for the project lead-form sections
// (InquiryForm + Brochure). These components used to hard-pin a cream
// surface + near-black/warm-stone/copper text, which ignored the brand
// palette and broke on a dark surface. This maps an operator-chosen tone
// to a full, legible class bundle — surface, headings, body, accent,
// panels, hairlines, and the form-input treatment — all brand-linked
// (the underlying tokens route through --brand-* like the header/footer
// themes, so Settings → Theme re-skins the forms too).
//
// Built on the same 5 brand tones the footer exposes (FOOTER_THEMES) so
// the vocabulary stays consistent across the site chrome. Class strings
// are STATIC literals so Tailwind's JIT scanner emits every utility.

import { FOOTER_THEMES, type FooterTheme } from './footerTheme'

export type SectionTone = FooterTheme // 'cream' | 'obsidian' | 'ivory' | 'champagne' | 'bone'

export interface SectionToneClasses {
  /** Section wrapper: background + base text colour. */
  surface: string
  /** Eyebrow + icon accent. */
  accent: string
  /** Full-strength heading colour (matches the surface base). */
  heading: string
  /** Body / supporting copy. */
  muted: string
  /** Rich-text (`prose`) body wrapper — inverts on dark surfaces. */
  proseBody: string
  /** Raised card / pill surface that reads on the tone. */
  panel: string
  /** Hairline border. */
  border: string
  /** Form input treatment (bg + border + text + placeholder + focus). */
  field: string
  /** True for dark surfaces (text flips light). */
  isDark: boolean
}

// Only obsidian is a dark surface among the five brand tones.
const DARK_TONES = new Set<SectionTone>(['obsidian'])

export function resolveSectionTone(
  tone: SectionTone | undefined,
): SectionToneClasses {
  const t: SectionTone = tone ?? 'cream'
  const f = FOOTER_THEMES[t]
  const isDark = DARK_TONES.has(t)
  // Full-strength heading colour = the surface's base foreground.
  // cream uses near-black; the other light tones (ivory/champagne/bone)
  // sit on obsidian text; obsidian (dark) flips to ivory.
  const heading = isDark
    ? 'text-ivory'
    : t === 'cream'
      ? 'text-near-black'
      : 'text-obsidian'
  return {
    surface: f.surface,
    accent: f.accent,
    heading,
    muted: f.muted,
    proseBody: isDark
      ? 'prose prose-lg prose-invert prose-p:text-ivory/75 prose-p:leading-relaxed'
      : t === 'cream'
        ? 'prose prose-lg prose-p:text-near-black/70 prose-p:leading-relaxed'
        : 'prose prose-lg prose-p:text-obsidian/70 prose-p:leading-relaxed',
    panel: isDark
      ? 'border border-ivory/15 bg-ivory/[0.06]'
      : t === 'cream'
        ? 'border border-near-black/8 bg-cream-50'
        : 'border border-obsidian/10 bg-ivory/60',
    border: f.border,
    field: f.field,
    isDark,
  }
}

// Legible form-input class for a DARK section tone — the light
// bordered/filled defaults (warm-stone border, inherited near-black
// text) vanish on obsidian. Sections pass this as the form's
// `fieldClassName` when `tone.isDark`. Static literal for JIT.
export const DARK_FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-ivory/25 bg-ivory/[0.06] px-3 py-2 text-ivory placeholder:text-ivory/40 focus:outline-none focus:ring-2 focus:ring-champagne'

// Editor select options (label order: light tones first, dark last).
export const SECTION_TONE_OPTIONS: ReadonlyArray<{
  value: SectionTone
  label: string
}> = [
  { value: 'cream', label: 'Cream (current)' },
  { value: 'ivory', label: 'Ivory' },
  { value: 'bone', label: 'Bone' },
  { value: 'champagne', label: 'Champagne — gold' },
  { value: 'obsidian', label: 'Obsidian — dark' },
]
