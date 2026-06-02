// Bundle preflight validator. Runs on the PROD side at stage time (and in the
// CLI's --dry-run validate-only mode). Collects EVERY error before returning —
// a push that would fail is rejected whole, naming each offending item, with
// zero writes. The same parse boundary every block write uses (parseAndSanitize:
// Zod + DOMPurify) validates each widget, so a bundle that passes preflight is
// guaranteed insertable.

import type { z } from 'zod'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { SLUG_RE, SLUG_MIN, SLUG_MAX } from '@/lib/cms/slug'
import { RESERVED } from '@/lib/cms/page-slug'
import { registry } from '@/lib/cms/settings-registry'
import {
  SectionMetaSchema,
  ColumnMetaSchema,
  WidgetMetaSchema,
} from '@/lib/cms/blockMeta'
import { canonicalContentHash } from './contentHash'
import { toContentGraph } from './contentGraph'
import { setMediaIdAtPath, isSafeMediaField } from './mediaPaths'
import {
  PUSH_SETTING_KEYS,
  bodyMediaPlaceholderRe,
  type SyncBundleT,
  type WidgetBundleT,
} from './bundleTypes'

export interface PreflightError {
  scope: 'settings' | 'page' | 'post' | 'project' | 'media' | 'bundle'
  ref?: string // slug / settings key / bundleKey
  blockType?: string
  reason: string
  detail?: string
}

export interface PreflightResult {
  ok: boolean
  errors: PreflightError[]
  summary: {
    pages: number
    posts: number
    projects: number
    media: number
    settings: number
  }
}

function slugOk(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && SLUG_RE.test(slug)
}

export function validateBundle(
  bundle: SyncBundleT,
  opts: { loginPath?: string } = {},
): PreflightResult {
  const errors: PreflightError[] = []
  const mediaKeys = new Set(bundle.media.map((m) => m.bundleKey))
  const loginPath = opts.loginPath?.toLowerCase()

  const requireMedia = (
    key: string | null,
    scope: PreflightError['scope'],
    ref: string,
    label: string,
  ) => {
    if (key != null && !mediaKeys.has(key)) {
      errors.push({ scope, ref, reason: 'media_unresolved', detail: `${label} -> ${key}` })
    }
  }

  // 1. settings keys ⊆ allowlist AND each value passes its registry schema —
  //    the SAME boundary interactive settings writes enforce.
  const settingsRegistry = registry as Record<string, { schema: z.ZodTypeAny }>
  const settingsRefs = bundle.settingsMediaRefs ?? {}
  for (const key of Object.keys(bundle.settings)) {
    if (!(PUSH_SETTING_KEYS as readonly string[]).includes(key)) {
      errors.push({ scope: 'settings', ref: key, reason: 'settings_key_not_allowed' })
      continue
    }
    const entry = settingsRegistry[key]
    if (!entry) continue

    // Reject a forged literal media_id in the (lifted) settings value — like
    // widget data, legit values carry NO media_id (it lives in settingsMediaRefs).
    for (const stray of collectMediaPaths(bundle.settings[key])) {
      errors.push({ scope: 'settings', ref: key, reason: 'media_id_not_allowed', detail: stray.field })
    }

    // Validate lifted media refs (safe path + resolves), then inject placeholder
    // media_ids so the registry mediaRef schema (which requires media_id) passes.
    const value = structuredClone(bundle.settings[key]) as Record<string, unknown>
    for (const [field, bkey] of Object.entries(settingsRefs[key] ?? {})) {
      if (!isSafeMediaField(field)) {
        errors.push({ scope: 'settings', ref: key, reason: 'media_ref_path_invalid', detail: field })
        continue
      }
      if (!mediaKeys.has(bkey)) {
        errors.push({ scope: 'settings', ref: key, reason: 'media_unresolved', detail: `${field} -> ${bkey}` })
        continue
      }
      setMediaIdAtPath(value, field, 1)
    }

    const r = entry.schema.safeParse(value)
    if (!r.success) {
      errors.push({
        scope: 'settings',
        ref: key,
        reason: 'settings_value_invalid',
        detail: r.error.issues[0]?.message?.slice(0, 160),
      })
    }
  }

  // 2. Page-set floor. The cutover wholesale-replaces pages/content_blocks, so
  //    an empty or home-less bundle would silently wipe the prod homepage / all
  //    pages. Reject both outright (matching the template-install guard) — these
  //    are almost always a reset/mis-pointed source, never an intentional push.
  const homes = bundle.pages.filter((p) => p.isHome)
  if (bundle.pages.length === 0) {
    errors.push({
      scope: 'bundle',
      reason: 'empty_bundle',
      detail: 'a push must contain at least one page (refusing to wipe the target)',
    })
  } else if (homes.length === 0) {
    errors.push({
      scope: 'bundle',
      reason: 'no_home_page',
      detail: 'a public site needs exactly one home page',
    })
  } else if (homes.length > 1) {
    errors.push({
      scope: 'bundle',
      reason: 'multiple_home',
      detail: homes.map((h) => h.slug).join(', '),
    })
  } else if (!homes[0]!.published) {
    // The cutover wholesale-replaces pages; an UNPUBLISHED home leaves prod's
    // `/` rendering the empty-home failsafe after a "successful" push — a blank
    // public site. Refuse rather than silently ship a dead homepage.
    errors.push({
      scope: 'bundle',
      reason: 'home_unpublished',
      detail: `the home page "${homes[0]!.slug}" is a draft — publish it before pushing`,
    })
  }

  // 3. pages: slug, media keys, every widget validates.
  for (const page of bundle.pages) {
    if (!slugOk(page.slug)) {
      errors.push({ scope: 'page', ref: page.slug, reason: 'slug_invalid' })
    }
    // A non-system page must not claim a route-reserved slug (admin/api/blog/…)
    // or the target's secret login path — that would create a dead/conflicting
    // page (static routes win) or shadow an internal route. System pages legit-
    // imately use the intentional reserved slugs (contact/privacy/terms/projects).
    if (!page.system) {
      const sl = page.slug.toLowerCase()
      if (RESERVED.has(sl) || (loginPath && sl === loginPath)) {
        errors.push({ scope: 'page', ref: page.slug, reason: 'slug_reserved' })
      }
    }
    requireMedia(page.ogImageKey, 'page', page.slug, 'ogImage')
    requireMedia(page.heroImageKey, 'page', page.slug, 'heroImage')
    // html_id is unique per page (generated stored column + unique index); a
    // cross-block dup would abort the cutover opaquely — catch it here.
    const htmlIds = new Set<string>()
    const checkHtmlId = (meta: Record<string, unknown> | null | undefined) => {
      const id = meta?.htmlId
      if (typeof id === 'string' && id !== '') {
        if (htmlIds.has(id)) {
          errors.push({ scope: 'page', ref: page.slug, reason: 'html_id_duplicate', detail: id })
        }
        htmlIds.add(id)
      }
    }
    // block_key is unique per page (idx_blocks_page_key) — a dup aborts the
    // cutover opaquely, so catch it here too.
    const blockKeys = new Set<string>()
    for (const section of page.sections) {
      checkMetaWithRefs(SectionMetaSchema, section.meta, section._metaMediaRefs, mediaKeys, page.slug, 'section', errors)
      checkHtmlId(section.meta)
      for (const column of section.columns) {
        if (column.meta || column._metaMediaRefs) {
          checkMetaWithRefs(ColumnMetaSchema, column.meta, column._metaMediaRefs, mediaKeys, page.slug, 'column', errors)
        }
        checkHtmlId(column.meta)
        for (const widget of column.widgets) {
          if (widget.meta || widget._metaMediaRefs) {
            checkMetaWithRefs(WidgetMetaSchema, widget.meta, widget._metaMediaRefs, mediaKeys, page.slug, 'widget', errors)
          }
          checkHtmlId(widget.meta)
          if (typeof widget.blockKey === 'string' && widget.blockKey !== '') {
            if (blockKeys.has(widget.blockKey)) {
              errors.push({ scope: 'page', ref: page.slug, reason: 'block_key_duplicate', detail: widget.blockKey })
            }
            blockKeys.add(widget.blockKey)
          }
          validateWidget(widget, page.slug, mediaKeys, errors)
        }
      }
    }
  }

  // 4. posts (+ inline body-image placeholders must resolve in the manifest).
  for (const post of bundle.posts) {
    if (!slugOk(post.slug)) {
      errors.push({ scope: 'post', ref: post.slug, reason: 'slug_invalid' })
    }
    requireMedia(post.heroImageKey, 'post', post.slug, 'heroImage')
    requireMedia(post.ogImageKey, 'post', post.slug, 'ogImage')
    for (const m of post.bodyMd.matchAll(bodyMediaPlaceholderRe())) {
      const key = m[1]!.toLowerCase()
      if (!mediaKeys.has(key)) {
        errors.push({ scope: 'post', ref: post.slug, reason: 'media_unresolved', detail: `body -> ${key}` })
      }
    }
  }

  // 5. projects.
  for (const project of bundle.projects) {
    if (!slugOk(project.slug)) {
      errors.push({ scope: 'project', ref: project.slug, reason: 'slug_invalid' })
    }
    requireMedia(project.heroImageKey, 'project', project.slug, 'heroImage')
    requireMedia(project.brochurePdfKey, 'project', project.slug, 'brochurePdf')
    requireMedia(project.ogImageKey, 'project', project.slug, 'ogImage')
  }

  // 5b. Duplicate slugs within a resource type collide on the unique index
  //     mid-cutover (aborting the whole swap with an opaque error) — catch here.
  const dupCheck = (items: Array<{ slug: string }>, scope: PreflightError['scope']) => {
    const seen = new Set<string>()
    for (const it of items) {
      if (seen.has(it.slug)) errors.push({ scope, ref: it.slug, reason: 'duplicate_slug' })
      seen.add(it.slug)
    }
  }
  dupCheck(bundle.pages, 'page')
  dupCheck(bundle.posts, 'post')
  dupCheck(bundle.projects, 'project')

  // 6. bundle self-integrity: recomputed content hash must match the manifest.
  const recomputed = canonicalContentHash(
    toContentGraph({
      pages: bundle.pages,
      posts: bundle.posts,
      projects: bundle.projects,
      settings: bundle.settings,
      settingsMediaRefs: bundle.settingsMediaRefs,
    }),
  )
  if (recomputed !== bundle.manifest.contentHash) {
    errors.push({
      scope: 'bundle',
      reason: 'hash_mismatch',
      detail: `manifest=${bundle.manifest.contentHash.slice(0, 12)} recomputed=${recomputed.slice(0, 12)}`,
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      pages: bundle.pages.length,
      posts: bundle.posts.length,
      projects: bundle.projects.length,
      media: bundle.media.length,
      settings: Object.keys(bundle.settings).length,
    },
  }
}

// Validate a block's meta object, handling lifted media refs (backgroundImage)
// exactly like validateWidget handles data refs: (1) no literal media_id may
// survive in meta — the serializer lifts them all into _metaMediaRefs, so a
// stray one is forged (it would mint a media_references row pointing at arbitrary
// LIVE prod media at cutover — a confused-deputy); (2) every lifted ref uses a
// safe path and resolves in the manifest; (3) the schema validates a clone with
// PLACEHOLDER media_ids re-injected (the schema requires media_id, which the
// stripped bundle form lacks). The real prod media_id is injected later, at
// stage time, from the uploaded media map.
function checkMetaWithRefs(
  schema: z.ZodTypeAny,
  rawMeta: Record<string, unknown> | null | undefined,
  metaRefs: Record<string, string> | undefined,
  mediaKeys: Set<string>,
  pageSlug: string,
  kind: string,
  errors: PreflightError[],
): void {
  const meta = (rawMeta ?? {}) as Record<string, unknown>
  for (const stray of collectMediaPaths(meta)) {
    errors.push({
      scope: 'page',
      ref: pageSlug,
      reason: `${kind}_meta_media_id_not_allowed`,
      detail: stray.field,
    })
  }
  const refs = metaRefs ?? {}
  const clone = structuredClone(meta)
  for (const [field, bkey] of Object.entries(refs)) {
    if (!isSafeMediaField(field)) {
      errors.push({ scope: 'page', ref: pageSlug, reason: `${kind}_meta_ref_path_invalid`, detail: field })
      continue
    }
    if (!mediaKeys.has(bkey)) {
      errors.push({ scope: 'page', ref: pageSlug, reason: 'media_unresolved', detail: `${field} -> ${bkey}` })
      continue
    }
    if (!setMediaIdAtPath(clone, field, 1)) {
      errors.push({ scope: 'page', ref: pageSlug, reason: `${kind}_meta_ref_path_unresolved`, detail: field })
    }
  }
  const r = schema.safeParse(clone)
  if (!r.success) {
    errors.push({
      scope: 'page',
      ref: pageSlug,
      reason: `${kind}_meta_invalid`,
      detail: r.error.issues[0]?.message?.slice(0, 160),
    })
  }
}

function validateWidget(
  widget: WidgetBundleT,
  pageSlug: string,
  mediaKeys: Set<string>,
  errors: PreflightError[],
): void {
  // Every lifted media ref must (a) use a safe collectMediaPaths-shaped path —
  // no __proto__/constructor/prototype walk — and (b) resolve in the manifest.
  const refs = widget._mediaRefs ?? {}
  for (const [field, key] of Object.entries(refs)) {
    if (!isSafeMediaField(field)) {
      errors.push({
        scope: 'page',
        ref: pageSlug,
        blockType: widget.blockType,
        reason: 'media_ref_path_invalid',
        detail: field,
      })
      continue
    }
    if (!mediaKeys.has(key)) {
      errors.push({
        scope: 'page',
        ref: pageSlug,
        blockType: widget.blockType,
        reason: 'media_unresolved',
        detail: `${field} -> ${key}`,
      })
    }
  }

  // Legitimate pushed widget data carries NO literal media_id — the serializer
  // strips every ref into _mediaRefs. Any media_id present is forged and would
  // otherwise mint a media_references row + un-quarantine arbitrary prod media
  // at cutover. Reject it.
  for (const stray of collectMediaPaths(widget.data)) {
    errors.push({
      scope: 'page',
      ref: pageSlug,
      blockType: widget.blockType,
      reason: 'media_id_not_allowed',
      detail: stray.field,
    })
  }

  // Re-inject a PLACEHOLDER media_id at each ref path so the Zod schema (which
  // requires media_id) validates the structure. The real prod media_id is
  // injected later, at stage time, from the uploaded media map. If a ref path
  // doesn't resolve in the data, the bundle is malformed (the _mediaRefs map
  // claims a path the data doesn't have) — flag it rather than silently skip.
  const data = structuredClone(widget.data)
  for (const field of Object.keys(refs)) {
    if (!setMediaIdAtPath(data, field, 1)) {
      errors.push({
        scope: 'page',
        ref: pageSlug,
        blockType: widget.blockType,
        reason: 'media_ref_path_unresolved',
        detail: field,
      })
    }
  }

  try {
    parseAndSanitize(widget.blockType, data)
  } catch (e) {
    errors.push({
      scope: 'page',
      ref: pageSlug,
      blockType: widget.blockType,
      reason: 'block_invalid',
      detail: e instanceof Error ? e.message.slice(0, 200) : String(e),
    })
  }
}
