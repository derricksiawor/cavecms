// Per-breakpoint responsive overrides (E17). Emits a scoped <style> with
// media queries targeting `.cms-r-{id}` (a unique class per block instance).
// Used for exact typographic overrides (font-size / line-height / letter-
// spacing) that the operator wants different on tablet / mobile — the one
// thing inline styles can't express. The declarations carry `!important` so
// they reliably beat the block's inline base style + utility classes at the
// breakpoint. Values are validated upstream (cssTypoValue), so this never
// emits operator-controlled selectors or arbitrary CSS.
//
// Breakpoints mirror Tailwind: tablet = max-width 1024px (≤ lg), mobile =
// max-width 640px (≤ sm).

import { CSS_TYPO_VALUE_RE } from '@/lib/cms/designTokens'

const BP = { tablet: 1024, mobile: 640 } as const

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}
function declsToCss(decls: Record<string, string | undefined>): string {
  return Object.entries(decls)
    // Defense-in-depth: re-validate at the <style> emitter (mirrors
    // buildScopedCss). Values are schema-checked upstream (cssTypoValue), but
    // dropping anything that doesn't match CSS_TYPO_VALUE_RE here makes a
    // rule-breakout (`}`, `;`, `</style>`) structurally impossible regardless
    // of how the value reached this renderer (seed, migration, future path).
    .filter(([, v]) => v != null && v !== '' && CSS_TYPO_VALUE_RE.test(v))
    .map(([k, v]) => `${kebab(k)}:${v} !important`)
    .join(';')
}

export function ResponsiveStyle({
  id,
  tablet,
  mobile,
}: {
  id: number | string
  tablet?: Record<string, string | undefined>
  mobile?: Record<string, string | undefined>
}) {
  const sel = `.cms-r-${id}`
  let css = ''
  const t = tablet ? declsToCss(tablet) : ''
  const m = mobile ? declsToCss(mobile) : ''
  if (t) css += `@media (max-width:${BP.tablet}px){${sel}{${t}}}`
  if (m) css += `@media (max-width:${BP.mobile}px){${sel}{${m}}}`
  if (!css) return null
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}

/** True when at least one tablet/mobile override is present. */
export function hasResponsive(
  tablet?: Record<string, string | undefined>,
  mobile?: Record<string, string | undefined>,
): boolean {
  const any = (o?: Record<string, string | undefined>) =>
    !!o && Object.values(o).some((v) => v != null && v !== '')
  return any(tablet) || any(mobile)
}
