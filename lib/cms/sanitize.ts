import 'server-only'

// Server entry point for the rich-text sanitizer. The actual
// implementation lives in `sanitize-shared.ts` (no `server-only`
// marker) so the client-side InlineEditable can pre-sanitize using
// the IDENTICAL allowlist + anchor hook. The server boundary (this
// file + parse.ts walkAndSanitize) remains the authority — the
// client pre-pass is a UX nice-to-have, not a security layer.
export { sanitizeRichText } from './sanitize-shared'
// Re-export types alongside the function so a future server-side
// consumer doesn't have to know about the shared/server file split.
export type * from './sanitize-shared'
