// Per-block custom CSS (E19) — Elementor's "Custom CSS" escape hatch, made
// SAFE by a declarations-only model. The operator writes CSS DECLARATIONS
// (property: value; pairs) — NOT selectors and NOT at-rules — for the base
// element and, optionally, the hover state. We wrap them in a scoped
// selector (`.cms-r-{id}` — a unique class on the block) so the CSS can
// only ever touch that one block. A denylist rejects anything that could
// escape the declaration context (braces, angle brackets, at-rules,
// url()/expression()/javascript:, comments), so an operator can never emit
// a global selector, import a remote sheet, or inject markup.

const DANGEROUS = /[{}<>@]|expression\s*\(|javascript:|url\s*\(|<\/|\/\*|\\/i

/** Returns the trimmed declarations if safe, else undefined. */
export function sanitizeDeclarations(css: unknown): string | undefined {
  if (typeof css !== 'string') return undefined
  const trimmed = css.trim()
  if (!trimmed || trimmed.length > 1200) return undefined
  if (DANGEROUS.test(trimmed)) return undefined
  // Must look like declarations (contain at least one `prop: value`).
  if (!/[a-z-]+\s*:/i.test(trimmed)) return undefined
  return trimmed
}

/** Build the scoped <style> CSS string for a block's base + hover custom CSS.
 *  Returns '' when nothing safe to emit. */
export function buildScopedCss(
  id: number | string,
  base: unknown,
  hover: unknown,
): string {
  const b = sanitizeDeclarations(base)
  const h = sanitizeDeclarations(hover)
  let out = ''
  if (b) out += `.cms-r-${id}{${b}}`
  if (h) out += `.cms-r-${id}:hover{${h}}`
  return out
}
