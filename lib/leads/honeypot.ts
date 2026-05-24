// Honeypot field name. Real humans never see this input (CSS off-
// screen, aria-hidden, tabindex -1, autoComplete=off). Mass-fill
// bots set every field; the route silently drops submissions where
// this is non-empty.
//
// Exported as a constant so a future name rotation (when bots learn
// 'company_url') touches a single point instead of every form + route.
// All 4 lead routes' Zod schemas key off this name; all 4 form
// components render this exact name.
// Importable from both server routes AND client form components —
// no `server-only` tag here because the value is pure data, no
// side effects on import.
export const HONEYPOT_FIELD = 'company_url'

export function honeypotTripped(
  value: string | null | undefined,
): boolean {
  return typeof value === 'string' && value.length > 0
}
