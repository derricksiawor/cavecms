// Canonical JS-side motion tokens for the project-sections cluster.
// Mirrors the @theme tokens in app/globals.css so Framer Motion
// transitions don't drift from the CSS animation rhythm. CSS is the
// authority; these constants reproduce the same numbers in JS-land.
//
// Why duplicated: framer-motion's `transition.ease` expects a number
// tuple (array of 4 floats) — CSS custom properties cannot be read by
// the JS transition engine. The duplication is intentional and the
// only correct way to keep both sides in lockstep.
//
// Surface deliberately small — only the curves + durations that
// framer-motion call sites in this cluster actually consume. If a
// future motion edit needs --ease-decelerate / --ease-luxury or
// --duration-drawer/reveal/elegant in JS, add them then. Dead exports
// invite drift.
//
// If a Chunk D follow-up changes the canonical curves, update BOTH
// places — globals.css `@theme` AND this file. No automated pin yet
// (a vitest pin requires parsing CSS custom properties out of the
// stylesheet); keep this checklist accurate by manual review during
// motion edits.

export const EASE_STANDARD = [0.4, 0, 0.2, 1] as const

// Seconds (framer-motion convention) to match the CSS millisecond
// tokens: quick=200ms, standard=300ms.
export const DUR = {
  quick: 0.2,
  standard: 0.3,
} as const
