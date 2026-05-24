// Isomorphic DOMPurify wrapper — shared by the server write boundary
// (lib/cms/sanitize.ts, gated with 'server-only') and the client-side
// pre-pass inside InlineEditable. No `server-only` marker here because
// the client-side path needs this exact same allowlist + anchor hook
// so that a paste-then-blur-then-save round trip can't diverge between
// what the operator sees mid-typing and what the server persists.
//
// isomorphic-dompurify ships a browser build (uses native DOM) and a
// node build (uses jsdom). The lazy `ensureHook` install pattern keeps
// module load side-effect-free on both — the hook is installed on the
// first call, not at import time. That avoids the Next build-time
// route-analysis ENOENT-on-jsdom-stylesheet failure documented in the
// `sanitize.ts` history. Single-threaded JS makes the
// globalThis-sentinel check-and-set effectively atomic.

import DOMPurify from 'isomorphic-dompurify'

// Allow-list. Anything outside is dropped (whole element for disallowed
// tag; attribute only for disallowed attr — DOMPurify decides per its
// config). The hook AFTER attribute sanitization forces every surviving
// <a> to carry rel=noopener noreferrer nofollow + target=_blank —
// defends against tabnabbing and SEO link-juice leakage.
const CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li'],
  ALLOWED_ATTR: ['href', 'rel', 'target'],
  // http(s), mailto, tel only. Anything else (javascript:, data:, blob:,
  // vbscript:, file:) is stripped by DOMPurify's URI screening.
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
}

// Unicode bidi-OVERRIDE + zero-width characters that can spoof the
// rendered output (e.g., U+202E RIGHT-TO-LEFT OVERRIDE flips
// subsequent text right-to-left so "evil.com" reads as "moc.live").
// DOMPurify only handles HTML tag/attribute hygiene — it doesn't
// strip Unicode confusables. We post-process the serialized output
// to remove these characters. The same regex lives in
// lib/cms/block-registry.ts `BIDI_OR_ZWS_RE` for short-text Zod
// refines — keep them in sync.
//
// Strip set:
//   U+200B–U+200D — ZWSP, ZWNJ, ZWJ. Zero-width invisibles.
//   U+202A–U+202E — LRE, RLE, PDF, LRO, RLO. Bidi overrides
//                    (primary spoofing vector).
//   U+2066–U+2069 — LRI, RLI, FSI, PDI. Isolate-overrides.
//   U+FEFF        — BOM / ZWNBSP. Zero-width.
//
// PRESERVED (intentionally NOT stripped):
//   U+200E (LRM), U+200F (RLM), U+061C (ALM) — directional MARKS.
//   These don't override strong-direction characters; they only
//   affect rendering of weak/neutral characters next to them.
//   Required for legitimate mixed-script content (English + Arabic
//   / Hebrew). BWC is English-only today but stripping these would
//   mangle any future RTL content. Marks alone cannot spoof
//   "evil.com" — the strong-LTR characters are unaffected.
//
// HTML entity references (&#x202E;) are decoded by DOMPurify's
// parser before serialization, so post-process strip catches them
// too (the literal character is in the output, not the entity).
const BIDI_OR_ZWS_HTML_RE = /[\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/g

// Module-scoped sentinel. Per-realm by definition (each module instance
// lives in one realm), un-writable by hostile in-page scripts (no
// `globalThis` exposure). A future worker_threads / Next worker
// runtime adoption gets per-worker isolation because each worker
// instantiates its own module instance.
let hookInstalled = false

function ensureHook(): void {
  if (hookInstalled) return
  hookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer nofollow')
      node.setAttribute('target', '_blank')
    }
  })
}

export function sanitizeRichText(html: string): string {
  ensureHook()
  const sanitized = String(DOMPurify.sanitize(html, CONFIG))
  // Post-pass: strip Unicode bidi-override + zero-width characters
  // from the serialized HTML. See BIDI_OR_ZWS_HTML_RE comment above
  // for the rationale. .replace with global flag returns a new string
  // (no in-place mutation).
  return sanitized.replace(BIDI_OR_ZWS_HTML_RE, '')
}
