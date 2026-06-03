// Drift-detection hash for the local→prod content push.
//
// The drift gate answers exactly one question at cutover time: did prod's
// content graph change since the operator pulled (the baseline)? If yes,
// refuse (unless --force) so a direct-on-prod edit is never silently
// clobbered. The hash is therefore:
//   - order-independent (pages/posts/projects/settings sorted by stable key)
//   - free of volatile fields (ids, version, updated_at, timestamps) — those
//     are excluded by the ContentGraph shape, which carries only the content
//     that actually renders
//   - content-addressed for media (refs are bundleKeys, not media_ids), so the
//     SAME image on two installs with different media_ids hashes equal
//
// Pure: no DB, no Node-server imports beyond node:crypto. Imported by the
// prod /api/cms/sync/hash route AND the local serializer, so both sides
// compute the identical hash over the identical serialized form.

import { createHash } from 'node:crypto'

// Deterministic stringify: object keys sorted recursively; array order is
// preserved (array order is semantic — block/widget order matters).
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  const obj = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(obj[k]))
      .join(',') +
    '}'
  )
}

// Content-addressed media identity. NOT a byte hash (too expensive to compute
// on every cutover) — the (originalName, byteSize, width, height) tuple is
// stable across installs and cheap. A re-encoded-but-identical image counts as
// new media (extra upload, never data loss); acceptable for v1.
export function mediaBundleKey(m: {
  originalName: string
  byteSize: number
  width: number | null
  height: number | null
  mime: string
  // sha256 of the original bytes when known. Folding it in means two DIFFERENT
  // files that share (name, bytes, dims, mime) get DIFFERENT keys — so they
  // never collide on the bundle filename or collapse to one media row. NULL/
  // absent (pre-content_hash rows) falls back to the metadata tuple as before.
  contentHash?: string | null
}): string {
  // mime is part of the identity so it matches the stage-time dedup tuple
  // (which keys on byte_size|original_name|mime_type|w|h) — otherwise two
  // distinct-mime files with the same name/size/dims collapse to one bundleKey.
  return createHash('sha256')
    .update(
      `${m.originalName}|${m.byteSize}|${m.width ?? ''}|${m.height ?? ''}|${m.mime}|${m.contentHash ?? ''}`,
    )
    .digest('hex')
    .slice(0, 16)
}

// A page in the hashable graph. `sections` is the SAME serialized shape the
// bundle ships (SectionBundle[] with media refs already expressed as
// bundleKeys, no ids/versions). The drift gate only ever compares
// PROD-computed hashes (baseline-at-pull vs live-at-cutover), so it is exact.
// A source bundle's hash also matches prod's post-cutover hash AS LONG AS the
// content was authored through the normal write path (parseAndSanitize applies
// Zod defaults at save time, so the stored form is already canonical) on the
// SAME block-schema version. A hand-crafted bundle, or a cross-version default
// drift, can make the source hash differ from prod's re-export — that does NOT
// affect drift safety, only the cosmetic source-vs-target sha comparison.
export interface HashablePage {
  slug: string
  title: string
  isHome: boolean
  system: boolean
  published: boolean
  seoTitle: string | null
  seoDescription: string | null
  ogImageKey: string | null
  heroImageKey: string | null
  sections: unknown[]
}

export interface HashablePost {
  slug: string
  title: string
  excerpt: string | null
  bodyMd: string
  published: boolean
  seoTitle: string | null
  seoDescription: string | null
  heroImageKey: string | null
  ogImageKey: string | null
}

export interface HashableProject {
  slug: string
  name: string
  tagline: string | null
  status: string
  location: string | null
  featuredOrder: number | null
  published: boolean
  seoTitle: string | null
  seoDescription: string | null
  heroImageKey: string | null
  brochurePdfKey: string | null
  ogImageKey: string | null
}

export interface ContentGraph {
  pages: HashablePage[]
  posts: HashablePost[]
  projects: HashableProject[]
  settings: Record<string, unknown> // only the 8 push keys (media refs lifted)
  // settingKey -> { path -> bundleKey } — folded into the hash so a logo/favicon
  // swap is drift-detectable even though media_id is stripped from the values.
  settingsMediaRefs?: Record<string, Record<string, string>>
}

export function canonicalContentHash(g: ContentGraph): string {
  // NOTE: projects are deliberately EXCLUDED. The cutover UPSERTS projects (it
  // never deletes prod projects absent from the bundle), so a prod-extra
  // project would make source-hash != target-hash forever and the drift gate /
  // identity comparison would never agree. The hash covers exactly what the
  // cutover wholesale-REPLACES (pages, posts) plus the upserted settings — the
  // surfaces where a stale-overwrite actually matters.
  // Code-point ordering (NOT localeCompare): the source builds the manifest hash
  // on one machine and prod recomputes it on another (preflight hash_mismatch
  // check), so the sort MUST be locale-/ICU-independent. `<`/`>` on strings is
  // pure UTF-16 code-point order — identical on every machine.
  const byCodePoint = (a: { slug: string }, b: { slug: string }) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  const pages = [...g.pages].sort(byCodePoint).map((p) => stable(p))
  const posts = [...g.posts].sort(byCodePoint).map((p) => stable(p))
  const refs = g.settingsMediaRefs ?? {}
  const settings = Object.keys(g.settings)
    .sort()
    .map((k) => k + '=' + stable(g.settings[k]) + '#' + stable(refs[k] ?? {}))

  const h = createHash('sha256')
  h.update('pages\n')
  pages.forEach((s) => h.update(s + '\n'))
  h.update('posts\n')
  posts.forEach((s) => h.update(s + '\n'))
  h.update('settings\n')
  settings.forEach((s) => h.update(s + '\n'))
  return h.digest('hex')
}
