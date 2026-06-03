// Wire format for the local→prod content push ("publish") feature.
//
// A SyncBundle is the complete, self-contained payload the `cavecms push`
// CLI builds from a LOCAL install and uploads to a prod install's
// /api/cms/sync/stage endpoint. It carries pages (as block trees), posts
// (markdown), projects (entity metadata only — the legacy project_sections
// layer is excluded, and a project's visible content rides in `pages`), the
// 8 token-writable branding/SEO settings, and every referenced media file.
//
// This module is the single source of truth for the bundle contract and is
// imported by BOTH the local serializer and the prod stage/cutover handlers,
// so it must stay free of Node-only / server-only imports (only `zod`).

import { z } from 'zod'

export const BUNDLE_FORMAT_VERSION = 1 as const

// The 8 settings keys a content push may write. Byte-for-byte the same set
// as TOKEN_WRITABLE_SETTINGS in app/api/admin/settings/route.ts — a push
// must never touch security_*, smtp, ai, integrations, session, or site_general.
// (Kept as a literal here so the serializer + cutover share one list; a test
// asserts it matches the route's allowlist.)
export const PUSH_SETTING_KEYS = [
  'contact_info',
  'social_links',
  'default_seo',
  'footer',
  'site_header',
  'organization_json_ld',
  'theme_palette',
  'mobile_cta',
] as const
export type PushSettingKey = (typeof PUSH_SETTING_KEYS)[number]

// Install-independent placeholder for a media URL embedded in a post's markdown
// body: cavecms://m/<bundleKey>/<variant>. The serializer rewrites a source
// /uploads/<uuid> URL to this; the stage step rewrites it to the TARGET's URL.
// Factory (not a shared instance) so the global-flag lastIndex never leaks
// between matchAll/replace callers.
export function bodyMediaPlaceholder(bundleKey: string, variant: string): string {
  return `cavecms://m/${bundleKey}/${variant}`
}
export const bodyMediaPlaceholderRe = (): RegExp =>
  /cavecms:\/\/m\/([0-9a-f]{16})\/(thumb|md|lg|og|original)/gi

// A media file shipped with the bundle. `bundleKey` is a content-addressed
// stable id (see mediaBundleKey in contentHash.ts) so the same image hashes
// equal across installs even though its media_id differs per install. The
// `files` map holds bundle-relative paths for whichever variants this kind has
// (images: thumb/md/lg/og; pdfs: pdf).
export const MediaBundleEntry = z.object({
  bundleKey: z.string().min(1).max(64),
  // Bounds match the media table column caps so an oversized field is rejected
  // at preflight, not mid-INSERT (which would abort the whole stage transaction).
  originalName: z.string().max(255),
  mime: z.string().max(80),
  alt: z.string().max(320),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  byteSize: z.number().int().nonnegative(),
  // sha256 of the original bytes (when the source row has it). Carried so the
  // target dedup can discriminate content, not just metadata.
  contentHash: z.string().max(64).nullable().optional(),
  kind: z.enum(['image', 'pdf']),
  files: z.object({
    thumb: z.string().optional(),
    md: z.string().optional(),
    lg: z.string().optional(),
    og: z.string().optional(),
    pdf: z.string().optional(),
  }),
})
export type MediaBundleEntryT = z.infer<typeof MediaBundleEntry>

// Widget node. Media refs inside `data` are NOT stored as { media_id } here —
// they are lifted into `_mediaRefs` (path-in-data -> bundleKey) at serialize
// time and re-injected to real prod media_ids at stage time. The path uses the
// SAME bracket notation collectMediaPaths emits (e.g. "image", "gallery[0]").
//
// `_metaMediaRefs` does the SAME lifting for the block's META object — section/
// column/widget meta can carry a `backgroundImage.media_id` (the cover-image
// feature). Without lifting it, the raw LOCAL media_id would ship across installs
// and render a broken/wrong background on the target. Same content-addressed
// contract as `_mediaRefs`, applied to meta instead of data.
export const WidgetBundle = z.object({
  kind: z.literal('widget'),
  blockType: z.string(),
  blockKey: z.string().nullable().optional(),
  data: z.record(z.unknown()),
  meta: z.record(z.unknown()).nullable().optional(),
  _mediaRefs: z.record(z.string()).optional(),
  _metaMediaRefs: z.record(z.string()).optional(),
})
export type WidgetBundleT = z.infer<typeof WidgetBundle>

export const ColumnBundle = z.object({
  kind: z.literal('column'),
  meta: z.record(z.unknown()).nullable().optional(),
  widgets: z.array(WidgetBundle),
  _metaMediaRefs: z.record(z.string()).optional(),
})
export type ColumnBundleT = z.infer<typeof ColumnBundle>

export const SectionBundle = z.object({
  kind: z.literal('section'),
  meta: z.record(z.unknown()),
  columns: z.array(ColumnBundle),
  _metaMediaRefs: z.record(z.string()).optional(),
})
export type SectionBundleT = z.infer<typeof SectionBundle>

export const PageBundle = z.object({
  slug: z.string(),
  title: z.string(),
  isHome: z.boolean(),
  system: z.boolean(),
  published: z.boolean(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  ogImageKey: z.string().nullable(),
  heroImageKey: z.string().nullable(),
  sections: z.array(SectionBundle),
})
export type PageBundleT = z.infer<typeof PageBundle>

export const PostBundle = z.object({
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  bodyMd: z.string(),
  published: z.boolean(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  heroImageKey: z.string().nullable(),
  ogImageKey: z.string().nullable(),
})
export type PostBundleT = z.infer<typeof PostBundle>

export const ProjectBundle = z.object({
  slug: z.string(),
  name: z.string(),
  tagline: z.string().nullable(),
  status: z.enum([
    'coming_soon',
    'under_construction',
    'selling',
    'sold_out',
  ]),
  location: z.string().nullable(),
  featuredOrder: z.number().int().nullable(),
  published: z.boolean(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  heroImageKey: z.string().nullable(),
  brochurePdfKey: z.string().nullable(),
  ogImageKey: z.string().nullable(),
})
export type ProjectBundleT = z.infer<typeof ProjectBundle>

export const SyncManifest = z.object({
  formatVersion: z.literal(BUNDLE_FORMAT_VERSION),
  createdAt: z.string(),
  sourceUrl: z.string(),
  // The prod content hash at pull-time, used as the drift baseline. Null when
  // the bundle was built from a local install that was never seeded from prod.
  baselineContentHash: z.string().nullable(),
  // Hash of THIS bundle's content graph (self-integrity + drift compare).
  contentHash: z.string(),
  counts: z.object({
    pages: z.number().int(),
    posts: z.number().int(),
    projects: z.number().int(),
    media: z.number().int(),
    settings: z.number().int(),
  }),
})
export type SyncManifestT = z.infer<typeof SyncManifest>

export const SyncBundle = z.object({
  manifest: SyncManifest,
  pages: z.array(PageBundle),
  posts: z.array(PostBundle),
  projects: z.array(ProjectBundle),
  // Keys validated to be ⊆ PUSH_SETTING_KEYS during preflight (not in the
  // schema, so an out-of-allowlist key produces a precise preflight error
  // rather than an opaque parse failure). Settings values have their media
  // refs (logo/favicon media_id) LIFTED into settingsMediaRefs, same as widget
  // data — so they re-resolve to prod media_ids at stage time.
  settings: z.record(z.unknown()),
  // settingKey -> { json-path -> bundleKey } for the media refs lifted out of
  // settings values.
  settingsMediaRefs: z.record(z.record(z.string())).optional(),
  media: z.array(MediaBundleEntry),
})
export type SyncBundleT = z.infer<typeof SyncBundle>
