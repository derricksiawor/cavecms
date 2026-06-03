import 'server-only'

// Server entry point for the markdown → sanitized HTML pipeline. The
// actual implementation lives in `markdown-shared.ts` (no `server-only`
// marker) so the CLIENT-bundled `lx_richtext` block renderer can run the
// IDENTICAL pipeline + allowlist via `renderMarkdownSync`. This mirrors
// the sanitize.ts → sanitize-shared.ts split. Server callers (the
// /blog/[slug] route, the editor preview server action, the help page)
// keep importing `@/lib/cms/markdown` unchanged — this re-export
// preserves the server boundary while the shared module is the single
// source of truth for the pipeline.
export { renderMarkdown, renderMarkdownSync } from './markdown-shared'
