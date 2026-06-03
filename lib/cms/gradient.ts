// Structured, SAFE gradient descriptor + CSS compiler.
//
// Used across the platform for ANY gradient surface — section/column
// backgrounds, gradient TEXT (heading / text / eyebrow via
// background-clip:text), and button fills (lx_action). The descriptor is
// STRUCTURED (kind + angle + hex color stops), never raw CSS, so it is:
//   1. builder-pickable (a visual gradient picker edits the stops), and
//   2. injection-proof — every value is a bounded number or a hex color
//      validated by HEX_COLOR_RE, so the compiled string can never carry
//      arbitrary CSS / url() / expression().
//
// This is the gradient analogue of `backgroundColor` (exact hex): the
// same "exact value, not just an enum token" philosophy, extended to
// multi-stop gradients. Both MCP/REST payloads and the dashboard builder
// write the same shape; the renderers compile it the same way.
import { z } from 'zod'
import { HEX_COLOR_RE } from './designTokens'

export const GradientStopSchema = z
  .object({
    // #rgb / #rrggbb / #rrggbbaa — alpha stops are allowed so a gradient
    // can fade to transparent (a common premium hero treatment).
    color: z.string().regex(HEX_COLOR_RE),
    // 0–100 (%). Optional — when omitted across stops, CSS auto-distributes
    // them evenly, which is the usual case for a simple two-stop gradient.
    position: z.number().min(0).max(100).optional(),
  })
  .strict()

export const GradientSchema = z
  .object({
    kind: z.enum(['linear', 'radial']).default('linear'),
    // Linear angle in degrees (0 = up, 90 = right, 180 = down). Ignored
    // for radial. Bounded so the compiled string is always a sane CSS angle.
    angle: z.number().min(0).max(360).default(180),
    // 2–6 stops. Two is the common case; the cap keeps the picker tidy and
    // the compiled string bounded.
    stops: z.array(GradientStopSchema).min(2).max(6),
  })
  .strict()

export type Gradient = z.infer<typeof GradientSchema>
export type GradientStop = z.infer<typeof GradientStopSchema>

// Tolerant parse for render-time (mirrors parseSectionMeta's posture):
// a malformed / partial blob renders as "no gradient" rather than throwing.
export function parseGradient(raw: unknown): Gradient | undefined {
  const r = GradientSchema.safeParse(raw)
  return r.success ? r.data : undefined
}

// Compile a descriptor → a CSS gradient string suitable for `background-image`
// (backgrounds + button fills) OR the background half of a gradient-text
// (background-clip:text) treatment. Returns undefined when there's nothing
// renderable, so callers can `if (css)` cleanly.
export function compileGradient(g: Gradient | null | undefined): string | undefined {
  if (!g || !Array.isArray(g.stops) || g.stops.length < 2) return undefined
  const stops = g.stops
    .map((s) => (typeof s.position === 'number' ? `${s.color} ${s.position}%` : s.color))
    .join(', ')
  if (g.kind === 'radial') return `radial-gradient(circle at center, ${stops})`
  const angle = typeof g.angle === 'number' ? g.angle : 180
  return `linear-gradient(${angle}deg, ${stops})`
}

// The inline-style fragment that paints TEXT with a gradient (the
// background-clip:text technique). Spread into a style object on the text
// element. Returns {} when there's no gradient so callers can spread freely.
export function gradientTextStyle(g: Gradient | null | undefined): {
  backgroundImage?: string
  WebkitBackgroundClip?: 'text'
  backgroundClip?: 'text'
  color?: string
  WebkitTextFillColor?: 'transparent'
} {
  const css = compileGradient(g)
  if (!css) return {}
  return {
    backgroundImage: css,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
  }
}
