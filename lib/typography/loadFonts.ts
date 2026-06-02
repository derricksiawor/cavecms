/**
 * Side-effect imports for every catalog font. Importing a `@fontsource`
 * package injects its `@font-face` rules (self-hosted woff2, served from
 * our own origin). Imported ONCE by app/layout.tsx so every page has the
 * full catalog's `@font-face` available — but the browser only downloads
 * a family's woff2 when text actually renders in it, so unused fonts cost
 * nothing on the wire.
 *
 * MUST stay in sync with lib/typography/catalog.ts. Variable packages
 * default-import the wght-axis CSS (one file spans the whole weight
 * range). Marcellus is static (single 400 weight).
 *
 * These are static string imports on purpose — Next/Turbopack can only
 * bundle CSS from literal import specifiers, never a computed loop.
 */

// ── Serif ──────────────────────────────────────────────────────────────
import '@fontsource/marcellus'
import '@fontsource-variable/cormorant-garamond'
import '@fontsource-variable/playfair-display'
import '@fontsource-variable/eb-garamond'
import '@fontsource-variable/lora'
import '@fontsource-variable/source-serif-4'
import '@fontsource-variable/fraunces'
// ── Sans ───────────────────────────────────────────────────────────────
import '@fontsource-variable/montserrat'
import '@fontsource-variable/inter'
import '@fontsource-variable/work-sans'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/manrope'
import '@fontsource-variable/plus-jakarta-sans'
import '@fontsource-variable/figtree'
import '@fontsource-variable/raleway'
// ── Display ─────────────────────────────────────────────────────────────
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/archivo'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/syne'
// ── Mono ────────────────────────────────────────────────────────────────
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/fira-code'
