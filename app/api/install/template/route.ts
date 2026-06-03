import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, access, unlink, chmod } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'
import { db } from '@/db/client'
import type { Tx } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import {
  ipFromRequest,
  requireInstallToken,
  makeInstallLimit,
  refuseIfInstalled,
  checkRate,
  okJson,
  errJson,
  parseSettingsValue,
} from '@/lib/install/installEndpointHelpers'
import {
  DEFAULT_TEMPLATE_SLUG,
  getTemplate,
  TEMPLATE_SLUGS,
} from '@/lib/cms/siteTemplates'
import type {
  PageSpec,
  SectionSpec,
  SiteTemplate,
  WidgetSpec,
} from '@/lib/cms/siteTemplates'
import { collectImageKeys } from '@/lib/cms/siteTemplates/extractImageKeys'
import { PRIVACY_SECTIONS, TERMS_SECTIONS } from '@/lib/cms/siteTemplates/legalContent'
import { parseAndSanitize } from '@/lib/cms/parse'
import { SectionMetaSchema, ColumnMetaSchema, WidgetMetaSchema } from '@/lib/cms/blockMeta'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { PATHS } from '@/lib/media/storage'

// POST /api/install/template — wizard template chooser.
//
// Wipes existing non-legal pages + their content blocks, then re-seeds
// from the chosen template's PageSpec[] tree. Also writes branding
// defaults (header brandText / theme / nav / CTA, footer columns,
// site_general siteName) into the settings table.
//
// Idempotent by design: re-running with the same slug = same end
// state. Re-running with a different slug switches the install to the
// new template (operator can navigate Back in the wizard and pick
// again). Safe because the endpoint refuses post-install via
// refuseIfInstalled — once the wizard completes, this endpoint is
// permanently locked.
//
// Atomicity: the entire wipe + reseed runs inside `db.transaction()`
// with a SELECT … FOR UPDATE on the install_state settings row at
// entry, so:
//   - a half-completed seed never lands on disk (transaction rolls
//     back on any throw inside the callback)
//   - a concurrent /api/install/complete cannot land its
//     `completedAt` mid-wipe (we hold the row lock until commit)
//   - a concurrent /api/install/template POST from another tab
//     either waits for our lock or is rejected by the per-process
//     busyToken below
//
// Pages PRESERVED (every install keeps these):
//   - privacy + terms (legal pages, seeded by 0015 migration)
//   - thank-you-{enquiry,tour,brochure} (utility pages used by
//     several lead-form flows; never wiped)
//   - blog (the system Blog-index page, seeded by 0034 migration). It
//     is preserved — NOT re-seeded by any template — so that EVERY
//     install (default-welcome AND the 8 industry templates) ends with
//     exactly one slug='blog' kind='page' row regardless of whether the
//     template declares a blog page. The migration guarantees the ROW;
//     the boot backfill (seedBlogPageBlocksIfEmpty / runBlogPageBackfillOnce)
//     fills its block tree when empty. Templates therefore MUST NOT ship a
//     'blog' page (validateTemplateShape rejects one as a preserved-slug
//     collision) — the blog index is template-agnostic by construction.
//
// Everything else (the install-migrate seed of home / about /
// services / contact / projects, and whatever a previous template
// seeded) gets wiped + re-seeded.
//
// The "I'll pick later" tile maps to the default-welcome template
// which IMPORTS the SECTION arrays from db/seeds/systemPageBlocks.ts
// — so picking it produces an install-migrate-equivalent state with
// no drift.

export const dynamic = 'force-dynamic'

// Slugs whose page rows + content_blocks survive the wipe.
// Inline in the wipe SELECT below — see wipeNonLegalPagesAndBlocks.
//
//   privacy / terms        legal pages, seeded by migration 0015
//   thank-you-{enquiry,
//     tour, brochure}      utility lead-form landing pages from 0019
//   blog                   system Blog-index page, seeded by migration 0034
//                          (preserved so /blog never 404s after an industry-
//                          template install — F2)

const Body = z
  .object({
    templateSlug: z
      .enum(TEMPLATE_SLUGS as [string, ...string[]])
      .default(DEFAULT_TEMPLATE_SLUG),
  })
  .strict()

const installLimit = makeInstallLimit('template')
const POS_STEP = 1000

// In-process semaphore. Two operator tabs in the SAME Node process
// both clicking Continue on the Template step would otherwise
// interleave a wipe with another tab's reseed. CaveCMS's default
// PM2 config runs a single instance — this gate catches the common
// double-click + React-strict-mode double-fire cases cheaply.
//
// CROSS-PROCESS (clustered PM2, instances > 1): this gate does NOT
// catch concurrent installs originating in different workers. The
// install_state row-lock in the TX below DOES serialize them
// correctly, so correctness is preserved — the loser just waits
// through the winner's full wipe + reseed rather than getting a
// fast 429. Acceptable given single-instance is the default.
let busyToken: symbol | null = null

interface InsertResult {
  insertId: number | bigint
}

class AlreadyInstalledError extends Error {
  constructor() {
    super('already_installed')
    this.name = 'AlreadyInstalledError'
  }
}

/**
 * Returns the IDs of pages we MUST preserve across a template wipe
 * (the legal pages + the system Blog index — F2). Filtered on
 * `deleted_at IS NULL` so a soft-deleted preserved page (operator
 * deleted /privacy via /admin/pages) doesn't survive as a tombstone —
 * it gets hard-wiped and re-created by the next migration pass. Throws
 * if the expected preserved-page set is missing entirely (i.e.
 * migrations didn't run): we refuse to proceed rather than blanket-wipe.
 */
async function preservedPageIds(tx: Tx): Promise<number[]> {
  const [rows] = (await tx.execute(sql`
    SELECT id FROM pages
    WHERE slug IN ('privacy','terms','thank-you-enquiry','thank-you-tour','thank-you-brochure','blog')
      AND deleted_at IS NULL
  `)) as unknown as [Array<{ id: number }>]
  return rows.map((r) => Number(r.id))
}

async function wipeNonLegalPagesAndBlocks(tx: Tx): Promise<void> {
  const keepIds = await preservedPageIds(tx)
  if (keepIds.length === 0) {
    // No preserved pages survived → migrations didn't run, or someone
    // soft-deleted them all. Either way, we will not silently
    // truncate the entire pages table. Bail loudly.
    throw new Error('preserved_legal_pages_missing')
  }

  // Defensive: make sure no preserved row has is_home=1. The is_home
  // partial-unique index would otherwise reject our home INSERT
  // below. Migrations never set is_home=1 on preserved slugs but a
  // hand-edited DB might.
  await tx.execute(sql`
    UPDATE pages
    SET is_home = 0
    WHERE slug IN ('privacy','terms','thank-you-enquiry','thank-you-tour','thank-you-brochure','blog')
      AND is_home = 1
  `)

  // FK content_blocks.page_id → pages.id has ON DELETE CASCADE, so
  // deleting pages would cascade-delete content_blocks. We DELETE
  // content_blocks first anyway as belt-and-braces — also leaves
  // the FK invariant satisfied for the page DELETE that follows.
  //
  // Scope BOTH deletes to kind='page' so HIDDEN post-body pages
  // (kind='post_body') and their content_blocks SURVIVE the template
  // wipe (spec §4.4): a body page is owned by a post via
  // posts.body_page_id, not part of the operator's page set, and
  // wiping it would orphan the post's body. The legal-page keep-list
  // is unaffected (those are all kind='page'). The content_blocks
  // delete scopes via the page's kind so it never touches a body
  // page's block tree even though body-page ids aren't in the keep-set.
  const idList = sql.join(
    keepIds.map((id) => sql`${id}`),
    sql`, `,
  )
  await tx.execute(sql`
    DELETE cb FROM content_blocks cb
    JOIN pages p ON p.id = cb.page_id
    WHERE cb.page_id NOT IN (${idList})
      AND p.kind = 'page'
  `)
  await tx.execute(sql`
    DELETE FROM pages WHERE id NOT IN (${idList})
      AND kind = 'page'
  `)
}

// ─── Template-bundled stock imagery ──────────────────────────────────
//
// Templates that ship designer-curated stock photos declare them in
// lib/cms/siteTemplates/<slug>/media-sources.json. At release time,
// scripts/release/build-template-media.ts downloads + processes each
// to <dist>/template-media/<slug>/{variants,manifest.json,credits.json},
// and build-zip.mjs copies that tree into the release zip at
// .next/standalone/template-media/<slug>/.
//
// At install time, this endpoint:
//   1. Pre-flight (BEFORE the wipe TX): extract every imageKey the
//      template references, read the bundled manifest, fail 422
//      `template_media_key_missing` if any key is unresolved. A bad
//      template never wipes a live install.
//   2. Inside the TX (BEFORE the page-insert loop): for each
//      manifest entry referenced by the template, generate a fresh
//      UUID, COPY (not rename — bundled originals must survive
//      re-picks) the variant files from <install>/.next/standalone/
//      template-media/<slug>/variants/<key>-* → UPLOADS_ROOT/variants/
//      <uuid>-*, INSERT the media row with variants JSON pointing at
//      /uploads/variants/<uuid>-*. Build a keyToMedia map keyed on
//      the bundled key → { mediaId, alt }.
//   3. In insertSections: for every widget with `_imageKeys`, INJECT
//      the resolved MediaRef ({ media_id, alt }) into widget.data at
//      the named field BEFORE parseAndSanitize fires. Strip
//      _imageKeys / _imageAlts so they never reach the DB.
//   4. After each widget INSERT: write a media_references row per
//      resolved field so DELETE /api/cms/media/[id] refuses to drop
//      the row while it's pinned by a page.

// Defense-in-depth bounds at the parse boundary. The signed release
// zip is the real guarantee that this manifest came from the
// publisher — but the project's standing rule (Security Standards →
// "input validation BEFORE queries reach the database") says we
// still narrow the shape at the Zod gate. Each constraint maps to a
// realistic upper bound + closes a path-traversal / int-overflow
// vector if the upstream contract ever drifts.

// Kebab-case stable key (matches the build-template-media validator).
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,127}$/

// Variant filename: `<key>-<kind>.<ext>` exactly. Rejects any "../"
// or absolute-path smuggling that would let copyFile read from an
// arbitrary location.
const VARIANT_FILENAME_RE = /^[a-z0-9][a-z0-9-]*-(thumb|md|lg|og)\.(webp|jpg)$/

// Width/height: 24 MP cap mirrors lib/media/sharp.ts LIMIT_INPUT_PIXELS.
// byteSize: 50 MiB is generous — Unsplash originals are 1-3 MB, the
//   variants sum is < 1 MB; the cap matches signed-int(32) headroom.
const MAX_DIMENSION = 24_000
const MAX_BYTE_SIZE = 50 * 1024 * 1024
// alt-text upper bound matches the media.alt_text column (320 chars).
const MAX_ALT = 320

const TemplateMediaEntry = z.object({
  key: z.string().regex(KEY_RE, 'invalid_key_format'),
  alt: z.string().min(1).max(MAX_ALT),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif']),
  width: z.number().int().positive().max(MAX_DIMENSION),
  height: z.number().int().positive().max(MAX_DIMENSION),
  byteSize: z.number().int().nonnegative().max(MAX_BYTE_SIZE),
  variants: z.object({
    thumb: z.string().regex(VARIANT_FILENAME_RE, 'invalid_variant_filename'),
    md: z.string().regex(VARIANT_FILENAME_RE, 'invalid_variant_filename'),
    lg: z.string().regex(VARIANT_FILENAME_RE, 'invalid_variant_filename'),
    og: z.string().regex(VARIANT_FILENAME_RE, 'invalid_variant_filename'),
  }),
  sourceUrl: z.string().url(),
  photographer: z.string().max(120),
  license: z.string().min(1).max(40),
})

const TemplateMediaManifest = z.object({
  templateSlug: z.string().regex(KEY_RE, 'invalid_slug_format'),
  generatedAt: z.string().min(1),
  entries: z.record(z.string().regex(KEY_RE), TemplateMediaEntry),
})

type TemplateMediaManifestT = z.infer<typeof TemplateMediaManifest>

/** Per-key resolved media row, built inside the install TX. */
interface ResolvedMedia {
  mediaId: number
  alt: string
}

/**
 * Resolve the absolute filesystem path of a template's bundled-media
 * tree at runtime. PM2 launches the standalone with
 * `cwd: <install>/.next/standalone/` (see ecosystem.config.cjs +
 * start-standalone.mjs), and build-zip.mjs copies dist/template-media/
 * into the same standalone tree at template-media/. So
 * <cwd>/template-media/<slug>/ is the canonical lookup.
 */
function templateMediaDir(slug: string): string {
  return path.join(process.cwd(), 'template-media', slug)
}

/**
 * Pre-TX manifest fetch + cross-check. Returns null when the template
 * declares no imageKeys (text-only template — nothing to provision).
 * Returns the parsed manifest when every key is covered. Returns a
 * Response on validation failure — caller bails before any DB writes.
 *
 * Errors are NEVER thrown from here: callers want to short-circuit a
 * 422 response without rolling back a transaction.
 */
async function loadTemplateMediaManifest(
  template: SiteTemplate,
): Promise<
  | { kind: 'no-media' }
  | { kind: 'ok'; manifest: TemplateMediaManifestT; usedKeys: Set<string> }
  | { kind: 'error'; response: Response }
> {
  const usedKeys = collectImageKeys(template)
  if (usedKeys.size === 0) return { kind: 'no-media' }

  const dir = templateMediaDir(template.slug)
  const manifestPath = path.join(dir, 'manifest.json')
  try {
    await access(manifestPath)
  } catch {
    // Template uses image keys but no bundled media tree exists on
    // disk. Either the release zip didn't include it (build script
    // regression) or this install was made from a pre-imagery release.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'install_template_media_manifest_missing',
        templateSlug: template.slug,
        manifestPath,
      }),
    )
    return {
      kind: 'error',
      response: errJson(500, 'template_media_manifest_missing'),
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'install_template_media_manifest_parse_failed',
        templateSlug: template.slug,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return {
      kind: 'error',
      response: errJson(500, 'template_media_manifest_parse_failed'),
    }
  }

  const parsed = TemplateMediaManifest.safeParse(raw)
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'install_template_media_manifest_invalid',
        templateSlug: template.slug,
        issues: parsed.error.issues.slice(0, 3),
      }),
    )
    return {
      kind: 'error',
      response: errJson(500, 'template_media_manifest_invalid'),
    }
  }

  const manifest = parsed.data
  // Slug-mismatch defense: a misplaced / swapped manifest would
  // silently install template A's imagery under template B's pages.
  // Refuse loudly.
  if (manifest.templateSlug !== template.slug) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'install_template_media_manifest_slug_mismatch',
        expected: template.slug,
        actual: manifest.templateSlug,
      }),
    )
    return {
      kind: 'error',
      response: errJson(500, 'template_media_manifest_slug_mismatch'),
    }
  }
  const missing: string[] = []
  for (const key of usedKeys) {
    if (!manifest.entries[key]) missing.push(key)
  }
  if (missing.length > 0) {
    return {
      kind: 'error',
      response: errJson(422, 'template_media_key_missing', {
        keys: missing.slice(0, 10),
      }),
    }
  }
  return { kind: 'ok', manifest, usedKeys }
}

/**
 * Inside the TX: for each used key, copy the bundled variant files
 * with fresh UUIDs into UPLOADS_ROOT/variants/, INSERT a media row,
 * and return the key → resolved-media map. Per-install UUIDs so a
 * customer who reinstalls or re-picks the template doesn't share
 * variant files across attempts — each install owns its own copies
 * and can edit/delete freely.
 *
 * Variants directory is created if missing (it normally is, per
 * setup.sh / CLI provisioning, but defence-in-depth against an
 * operator-stripped layout).
 */
/**
 * Hard-delete every previous template's bundled-media rows + their
 * media_references (cascade). Returns the absolute filesystem paths
 * of the variant files that should be unlinked AFTER the TX commits.
 *
 * Re-pick scenario: operator picks hotel-solenne → 12 media rows
 * land + their variants on disk + `original_name = 'template/hotel-
 * solenne/<key>'`. Operator clicks Back, picks anara-wellness → if we
 * DON'T clean up the old rows, the Media Library now carries 12 dead
 * "Hôtel Solenne" photos that media_references for now-wiped widgets
 * pin as undeletable, plus 12 variant files leaked on disk per pick.
 * verify-media-refs cron eventually reaps the orphans (7-day window)
 * but operator sees a broken Library immediately. Same applies if the
 * operator re-picks the SAME template — fresh UUIDs land, previous
 * UUIDs orphan.
 *
 * Hard-delete (vs soft-delete + nightly purge) chosen because bundled
 * media has no audit-trail value — the operator never owned it; the
 * "undo" path is to pick the template again, which re-bundles fresh
 * UUIDs from the manifest.
 *
 * Path-extraction defence-in-depth: only unlink paths that resolve
 * INSIDE PATHS.variants. A malformed media.variants JSON cell (post-
 * write tampering / schema drift) must not let us delete arbitrary
 * files from disk.
 */
async function reapPreviousTemplateMedia(tx: Tx): Promise<string[]> {
  const [rows] = (await tx.execute(sql`
    SELECT id, variants FROM media WHERE original_name LIKE 'template/%'
  `)) as unknown as [Array<{ id: number; variants: unknown }>]
  if (rows.length === 0) return []

  const pathsToUnlink: string[] = []
  const idsToDelete: number[] = []
  const variantsRootResolved = path.resolve(PATHS.variants) + path.sep

  for (const row of rows) {
    idsToDelete.push(Number(row.id))
    // mysql2 returns JSON columns as string OR pre-parsed object
    // depending on driver mode. Handle both; ignore malformed cells.
    let parsed: unknown = row.variants
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed)
      } catch {
        continue
      }
    }
    if (!parsed || typeof parsed !== 'object') continue
    const variants = parsed as Record<string, unknown>
    for (const v of Object.values(variants)) {
      if (typeof v !== 'string') continue
      // variants are stored as `/uploads/variants/<uuid>-<kind>.<ext>`
      const PREFIX = '/uploads/variants/'
      if (!v.startsWith(PREFIX)) continue
      const filename = v.slice(PREFIX.length)
      // Reject any path-traversal attempt smuggled into the filename.
      if (filename.includes('/') || filename.includes('..')) continue
      const abs = path.resolve(path.join(PATHS.variants, filename))
      if (!abs.startsWith(variantsRootResolved)) continue
      pathsToUnlink.push(abs)
    }
  }

  // Cascade: media_references.media_id has ON DELETE CASCADE per
  // db/schema/media.ts:53 — DELETE FROM media drops the rows in one
  // shot. Use the IDs we built above (avoids re-running the LIKE).
  const idList = sql.join(
    idsToDelete.map((id) => sql`${id}`),
    sql`, `,
  )
  await tx.execute(sql`DELETE FROM media WHERE id IN (${idList})`)
  return pathsToUnlink
}

async function provisionTemplateMedia(
  tx: Tx,
  templateSlug: string,
  manifest: TemplateMediaManifestT,
  usedKeys: Set<string>,
  writtenPaths: string[],
): Promise<Map<string, ResolvedMedia>> {
  const srcDir = path.join(templateMediaDir(templateSlug), 'variants')
  // mkdir is idempotent with recursive=true. Mode 0o750 matches
  // setup.sh's provisioning so a brand-new variants dir lands with
  // the right perms for nginx to serve from.
  await mkdir(PATHS.variants, { recursive: true, mode: 0o750 })

  const out = new Map<string, ResolvedMedia>()
  for (const key of usedKeys) {
    const entry = manifest.entries[key]
    if (!entry) {
      // Pre-flight already ruled this out, but a paranoid re-check
      // here keeps a future refactor that bypasses pre-flight safe.
      throw new Error(`template_media_key_missing_in_tx:${key}`)
    }
    const uuid = randomUUID()

    // Copy each variant file with the fresh UUID prefix. Use
    // copyFile (not rename) so the bundled tree stays intact for
    // future re-picks of the same template. Append each destination
    // to writtenPaths SYNCHRONOUSLY with the copy — caller unlinks
    // these on TX rollback to avoid leaking 4 files per used key.
    //
    // Defense in depth: the VARIANT_FILENAME_RE Zod constraint
    // already rejects any traversal-flavoured filename, but we ALSO
    // assert the resolved source path stays inside srcDir before
    // every copyFile call. Two independent gates means a future
    // regression in the Zod schema can't open a file-disclosure
    // hole on its own.
    const srcRoot = path.resolve(srcDir) + path.sep
    const copyPlan: Array<{ src: string; dst: string }> = [
      { src: path.join(srcDir, entry.variants.thumb), dst: path.join(PATHS.variants, `${uuid}-thumb.webp`) },
      { src: path.join(srcDir, entry.variants.md),    dst: path.join(PATHS.variants, `${uuid}-md.webp`) },
      { src: path.join(srcDir, entry.variants.lg),    dst: path.join(PATHS.variants, `${uuid}-lg.webp`) },
      { src: path.join(srcDir, entry.variants.og),    dst: path.join(PATHS.variants, `${uuid}-og.jpg`) },
    ]
    for (const { src, dst } of copyPlan) {
      const resolvedSrc = path.resolve(src)
      if (!resolvedSrc.startsWith(srcRoot)) {
        throw new Error(`template_media_path_traversal_blocked:${key}`)
      }
      await copyFile(src, dst)
      // Explicit chmod so the file mode doesn't depend on the
      // process umask. setup.sh provisions PATHS.variants as 0750
      // (cavecms:cavecms); nginx runs as www-data and needs group-
      // read. 0o640 = owner rw, group r, world none. Matches the
      // upload route's intent. Without this, a customer install
      // whose cavecms-user umask is hardened (e.g. 077 in some
      // distros) would land files at 0600 and nginx would 403.
      await chmod(dst, 0o640)
      writtenPaths.push(dst)
    }

    // Variants JSON shape mirrors what the upload route writes — same
    // /uploads/variants/<uuid>-X.webp URL pattern the renderer
    // expects via resolveMedia().
    const variantsJson = {
      thumb: `/uploads/variants/${uuid}-thumb.webp`,
      md: `/uploads/variants/${uuid}-md.webp`,
      lg: `/uploads/variants/${uuid}-lg.webp`,
      og: `/uploads/variants/${uuid}-og.jpg`,
    }

    // Filename: just `<key>.<ext>` so the Media Library's display /
    // search / sort behaves naturally. The template slug is recorded
    // in `media.source` (future column) — for now reapPreviousTemplateMedia
    // identifies bundled rows via the legacy LIKE-pattern below.
    // KEEP the `template/` prefix on filename_uuid lookup until the
    // source-column migration ships, otherwise re-pick cleanup
    // can't find these rows. Compromise: keep the path-shaped name
    // but use the kebab key as the human-readable last segment.
    const ext = entry.mime === 'image/png' ? 'png' : entry.mime === 'image/webp' ? 'webp' : 'jpg'
    const originalName = `template/${templateSlug}/${key}.${ext}`
    const [insertRes] = (await tx.execute(sql`
      INSERT INTO media
        (filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, variants, uploaded_by, created_at)
      VALUES
        (${uuid}, ${originalName}, ${entry.mime}, ${entry.alt},
         ${entry.width}, ${entry.height}, ${entry.byteSize},
         ${JSON.stringify(variantsJson)}, ${null}, NOW(3))
    `)) as unknown as [InsertResult]
    const mediaId = Number(insertRes.insertId)
    out.set(key, { mediaId, alt: entry.alt })
  }
  return out
}

/**
 * Walks a widget's `_imageKeys` map and INJECTS resolved MediaRef
 * objects into widget.data at the named fields. Then strips both
 * `_imageKeys` and `_imageAlts` from the widget so they never reach
 * parseAndSanitize (which would reject unknown top-level fields) or
 * the DB (content_blocks.meta only — never the widget root).
 *
 * MUTATES the widget. The widget here is a structuredClone of the
 * registry singleton (per the top-of-POST clone) so cross-request
 * mutation is impossible.
 *
 * media_references rows are NO LONGER derived from this function's
 * return value — the install route calls `collectMediaPaths(cleaned)`
 * on the post-parse widget data, which is the canonical extractor
 * used by saveBlock + hydratePage. That keeps the install route's
 * reverse-index identical to every other write path in the system.
 */
function injectMediaRefs(
  widget: WidgetSpec,
  keyToMedia: Map<string, ResolvedMedia>,
): void {
  if (!widget._imageKeys) return
  const alts = widget._imageAlts ?? {}
  for (const [field, key] of Object.entries(widget._imageKeys)) {
    const resolved = keyToMedia.get(key)
    if (!resolved) {
      // Pre-flight + provisionTemplateMedia already guard this; throw
      // loudly with structured context if we get here so a future
      // regression is impossible to ignore.
      throw new TemplateMediaUnresolvedError(key, widget.blockType, field)
    }
    widget.data[field] = {
      media_id: resolved.mediaId,
      // Prefer the template-author-provided alt (more contextual than
      // the manifest alt — same image used in two places may want
      // different alt copy).
      alt: alts[field] ?? resolved.alt,
    }
  }
  // Strip the transport fields so the rest of insertSections never
  // sees them and they don't accidentally end up in JSON.stringify of
  // widget.meta.
  delete widget._imageKeys
  delete widget._imageAlts
}

class TemplateMediaUnresolvedError extends Error {
  constructor(
    public readonly key: string,
    public readonly blockType: string,
    public readonly field: string,
  ) {
    super(`template_media_unresolved:${key}`)
    this.name = 'TemplateMediaUnresolvedError'
  }
}

async function insertPage(tx: Tx, spec: PageSpec): Promise<number> {
  const seoTitle = spec.seoTitle ?? spec.title
  const seoDescription = spec.seoDescription ?? null
  const isHome = spec.isHome ? 1 : 0
  const [res] = (await tx.execute(sql`
    INSERT INTO pages
      (slug, title, is_home, system, published, published_at, seo_title, seo_description, created_at)
    VALUES
      (${spec.slug}, ${spec.title}, ${isHome}, 1, 1, NOW(3),
       ${seoTitle}, ${seoDescription}, NOW(3))
  `)) as unknown as [InsertResult]
  return Number(res.insertId)
}

async function insertSections(
  tx: Tx,
  pageId: number,
  sections: SectionSpec[],
  keyToMedia: Map<string, ResolvedMedia>,
): Promise<void> {
  let secPos = POS_STEP
  for (const sec of sections) {
    // Validate section meta at insert time — the template-validator
    // script runs locally + at prebuild, but a future hot-reload edit
    // shouldn't bypass the boundary on the way to the DB.
    const cleanedSecMeta = SectionMetaSchema.parse(sec.meta)
    const [secRes] = (await tx.execute(sql`
      INSERT INTO content_blocks
        (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
      VALUES
        (${pageId}, NULL, 'section', NULL, 'section', ${secPos}, '{}',
         ${JSON.stringify(cleanedSecMeta)}, 0)
    `)) as unknown as [InsertResult]
    const sectionId = Number(secRes.insertId)
    let colPos = POS_STEP
    for (const colSpec of sec.columns) {
      const cleanedColMeta = ColumnMetaSchema.parse(colSpec.meta ?? {})
      const [colRes] = (await tx.execute(sql`
        INSERT INTO content_blocks
          (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
        VALUES
          (${pageId}, ${sectionId}, 'column', NULL, 'column', ${colPos}, '{}',
           ${JSON.stringify(cleanedColMeta)}, 0)
      `)) as unknown as [InsertResult]
      const columnId = Number(colRes.insertId)
      let widPos = POS_STEP
      for (const w of colSpec.widgets) {
        // Inject bundled-template MediaRefs into widget.data BEFORE
        // parseAndSanitize fires. parseAndSanitize would reject
        // widget.data with missing required MediaRef fields, and
        // would strip the _imageKeys / _imageAlts top-level fields
        // we use as transport. The widget here is a structuredClone
        // of the registry singleton (per the top-of-POST clone) so
        // mutating it cannot poison cross-request state.
        injectMediaRefs(w, keyToMedia)

        // Run the widget data through the canonical CMS sanitize+parse
        // gate so any field-level schema violation in a template file
        // surfaces here (transaction rolls back the whole reseed)
        // instead of at next page-render.
        const cleaned = parseAndSanitize(w.blockType, w.data) as Record<string, unknown>
        // Validate widget.meta the same way as data — a typo in a
        // template's `meta: { marginTop: 'smm' }` would land in DB
        // and crash the renderer. SectionMeta + ColumnMeta are
        // already validated above; WidgetMeta closes the symmetry.
        const cleanedMeta = w.meta ? WidgetMetaSchema.parse(w.meta) : null
        const widgetMetaJson = cleanedMeta ? JSON.stringify(cleanedMeta) : null
        const [widRes] = (await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
          VALUES
            (${pageId}, ${columnId}, 'widget', NULL, ${w.blockType}, ${widPos},
             ${JSON.stringify(cleaned)}, ${widgetMetaJson}, 0)
        `)) as unknown as [InsertResult]
        const widgetId = Number(widRes.insertId)

        // Derive media_references from the PARSED data via the
        // canonical walker — same code path as saveBlock + hydrate.
        // This eliminates contract drift between the install route's
        // hand-written ref list and the rest of the system's media-
        // reference shape (e.g. future nested MediaRefs like
        // `gallery[3].image`). INSERT IGNORE matches the blocks
        // route's pattern.
        const refs = collectMediaPaths(cleaned)
        for (const ref of refs) {
          await tx.execute(sql`
            INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${ref.mediaId}, 'content_block', ${widgetId}, ${ref.field})
          `)
        }

        widPos += POS_STEP
      }
      colPos += POS_STEP
    }
    secPos += POS_STEP
  }
}

// Populate the preserved legal pages (privacy, terms) with the shared
// generic content when they carry no content blocks. Runs inside the
// reseed TX, after the wipe (which preserves the legal page rows) and
// after the template pages are inserted. Idempotent + non-destructive:
// a page that already has blocks (operator edited it, or a prior
// install seeded it) is left untouched, so a template re-pick never
// overwrites edited legal copy.
const LEGAL_PAGE_CONTENT: ReadonlyArray<{ slug: string; sections: SectionSpec[] }> = [
  { slug: 'privacy', sections: PRIVACY_SECTIONS },
  { slug: 'terms', sections: TERMS_SECTIONS },
]

async function seedEmptyLegalPages(tx: Tx): Promise<void> {
  for (const { slug, sections } of LEGAL_PAGE_CONTENT) {
    const [rows] = (await tx.execute(sql`
      SELECT p.id AS id, COUNT(b.id) AS blocks
      FROM pages p
      LEFT JOIN content_blocks b ON b.page_id = p.id
      WHERE p.slug = ${slug} AND p.deleted_at IS NULL
      GROUP BY p.id
      LIMIT 1
    `)) as unknown as [Array<{ id: number; blocks: number | string }>]
    const row = rows[0]
    // No legal page row at all → migrations created privacy/terms as
    // preserved system pages, so this shouldn't happen; skip silently
    // rather than throw (the wipe guard already enforces their
    // existence). Non-empty → operator content present, leave it.
    if (!row) continue
    if (Number(row.blocks) > 0) continue
    await insertSections(tx, Number(row.id), sections, new Map())
  }
}

async function seedTemplateBranding(
  tx: Tx,
  brandText: string,
  branding: SiteTemplate['branding'],
): Promise<void> {
  // Fold the two pre-existing-settings SELECTs into ONE query.
  const [existingRows] = (await tx.execute(sql`
    SELECT \`key\`, value FROM settings WHERE \`key\` IN ('site_header','footer')
  `)) as unknown as [Array<{ key: string; value: unknown }>]
  let existingHeader: Record<string, unknown> = {}
  let existingFooter: Record<string, unknown> = {}
  for (const r of existingRows) {
    if (r.key === 'site_header') {
      existingHeader = parseSettingsValue(r.value, 'site_header')
    } else if (r.key === 'footer') {
      existingFooter = parseSettingsValue(r.value, 'footer')
    }
  }

  // Preserve operator-uploaded logo IF the media row is still live.
  // A soft-deleted media row would render as a 404 in the public
  // header. Null it out so the wordmark falls back. Use the LOOSE
  // null-check (`!deleted_at`) rather than `=== null` so a future
  // mysql2 driver upgrade that surfaces NULL DATETIME(3)s as another
  // falsy shape (e.g. empty string) still resolves correctly.
  //
  // Validate the cell shape via Zod before we trust + re-persist it.
  // A hand-edited DB cell that's `{ media_id: "7" }` (string) or just
  // `"some-string"` would otherwise pass through `upsertSettingInTx`
  // verbatim and corrupt the next render. Parse-failure falls back to
  // "no preserved logo" (the wordmark renders) — safer than re-
  // persisting a malformed shape.
  let preservedLogo: { media_id: number; alt?: string } | null = null
  const LogoShape = z.object({
    media_id: z.number().int().positive(),
    alt: z.string().max(MAX_ALT).optional(),
  }).strict()
  const logoParse = LogoShape.safeParse(existingHeader.logo)
  const headerLogo = logoParse.success ? logoParse.data : null
  if (headerLogo) {
    const [mediaRows] = (await tx.execute(sql`
      SELECT deleted_at FROM media WHERE id = ${headerLogo.media_id} LIMIT 1
    `)) as unknown as [Array<{ deleted_at: unknown }>]
    const stillLive = mediaRows[0] !== undefined && !mediaRows[0].deleted_at
    if (stillLive) {
      preservedLogo = headerLogo
    } else if (mediaRows[0] !== undefined) {
      // Logo media exists but is soft-deleted. Drop the orphan
      // media_references row so cron-purge can hard-delete the row
      // when its retention window elapses. Without this, the
      // (settings, 0, site_header.logo) reference would keep the
      // soft-deleted media row pinned forever.
      await tx.execute(sql`
        DELETE FROM media_references
        WHERE media_id = ${headerLogo.media_id}
          AND referent_type = 'settings'
          AND field = 'site_header.logo'
      `)
    }
  }

  await upsertSettingInTx(tx, 'site_header', {
    brandText: brandText || branding.brandText,
    theme: branding.headerTheme,
    logo: preservedLogo,
    navItems: branding.primaryNav,
    primaryCta: branding.primaryCta,
  })

  await upsertSettingInTx(tx, 'footer', {
    tagline: branding.footerTagline,
    // Footer theme is linked to the header theme at SETUP time so the
    // chosen template/theme applies to both surfaces. It remains an
    // independent setting afterward — the operator can change the
    // footer theme on its own under Settings → Footer.
    theme: branding.headerTheme,
    columns: branding.footerColumns,
    logo: existingFooter.logo ?? null,
    newsletterHeading: existingFooter.newsletterHeading ?? 'Stay informed',
    newsletterBody:
      existingFooter.newsletterBody ??
      'Updates and announcements. One click to unsubscribe.',
    newsletterCtaLabel: existingFooter.newsletterCtaLabel ?? 'Subscribe',
    copyright: existingFooter.copyright ?? '',
    legalLinks: existingFooter.legalLinks ?? [
      { text: 'Privacy', href: '/privacy' },
      { text: 'Terms', href: '/terms' },
    ],
  })
}

async function upsertSettingInTx(
  tx: Tx,
  key: string,
  value: unknown,
): Promise<void> {
  const json = JSON.stringify(value)
  await tx.execute(sql`
    INSERT INTO settings (\`key\`, value, version, updated_by)
    VALUES (${key}, ${json}, 1, NULL)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      version = version + 1
  `)
}

/**
 * Validate the template's page tree BEFORE the wipe fires. A bad
 * template should never wipe a live install. The validate-site-templates
 * script catches these at build time; this runtime guard is defense in
 * depth (and also protects future templates added between releases).
 *
 * Returns a 422 Response on the FIRST validation failure; null on OK.
 */
function validateTemplateShape(template: SiteTemplate): Response | null {
  if (template.pages.length === 0) {
    return errJson(422, 'template_has_no_pages')
  }
  const homePages = template.pages.filter((p) => p.isHome)
  if (homePages.length === 0) {
    return errJson(422, 'template_has_no_home_page')
  }
  if (homePages.length > 1) {
    return errJson(422, 'template_has_multiple_home_pages')
  }
  const slugSeen = new Set<string>()
  for (const p of template.pages) {
    if (slugSeen.has(p.slug)) {
      return errJson(422, 'template_page_slug_duplicate')
    }
    slugSeen.add(p.slug)
    // Slugs cannot collide with the preserved system pages. The wipe
    // PRESERVES these rows (it no longer deletes-then-reinserts them),
    // so a template that also declared one of these slugs would either
    // lose its content to the preserved row or hit a slug-unique
    // collision on insert. 'blog' is preserved (F2) so the Blog index is
    // template-agnostic: templates never ship their own blog page; the
    // 0034 row + boot backfill own it.
    if (
      p.slug === 'privacy' ||
      p.slug === 'terms' ||
      p.slug === 'thank-you-enquiry' ||
      p.slug === 'thank-you-tour' ||
      p.slug === 'thank-you-brochure' ||
      p.slug === 'blog'
    ) {
      return errJson(422, 'template_page_slug_collides_with_preserved')
    }
  }
  return null
}

export const POST = withError(async (req: Request) => {
  const ip = ipFromRequest(req)
  const tokenFail = requireInstallToken(req)
  if (tokenFail) return tokenFail
  const refused = await refuseIfInstalled()
  if (refused) return refused

  // Per-process serialization. Two operator tabs both clicking
  // Continue (or React strict-mode double-firing) would otherwise
  // interleave wipes + inserts. The DB transaction's row locks would
  // serialize correctly but the loser would wait through the entire
  // first call — cheaper to reject upfront.
  //
  // busyToken BEFORE rate limit: an over-eager double-click would
  // otherwise burn the 5/300s install-limit bucket on self-conflicts
  // (UI gets 429 from us, then we also count the attempt against the
  // IP for the next 5min — a denial-of-self). Reject concurrent
  // fan-out first; only count rate against requests that actually
  // got admitted.
  if (busyToken !== null) {
    return new Response(
      JSON.stringify({ error: 'busy' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
          'retry-after': '5',
        },
      },
    )
  }
  const myToken = Symbol('install-template')
  busyToken = myToken
  const watchdog = setTimeout(() => {
    if (busyToken === myToken) busyToken = null
  }, 60_000)
  watchdog.unref()

  try {
    checkRate(installLimit, ip)
    const body = Body.parse(await readJsonBody(req))
    const templateRaw = getTemplate(body.templateSlug)
    if (!templateRaw) {
      return errJson(400, 'unknown_template')
    }
    // CRITICAL: deep-clone the registry singleton before any walk.
    // injectMediaRefs() below mutates widget.data + deletes the
    // _imageKeys / _imageAlts transport fields IN PLACE. Without the
    // clone, the in-memory SITE_TEMPLATES singleton would be poisoned
    // for every subsequent install in the same Node process — a
    // second pick of the same (or a different) template would see
    // already-stripped widgets, skip the manifest pre-flight, and
    // insert content_blocks rows pointing at stale media_ids.
    const template: SiteTemplate = structuredClone(templateRaw)

    // Validate template SHAPE before any destructive operation runs.
    const shapeError = validateTemplateShape(template)
    if (shapeError) return shapeError

    // Pre-flight: read the bundled-media manifest and confirm every
    // imageKey the template references is covered. Runs BEFORE the
    // wipe TX — a template that references an unbundled key never
    // gets a chance to delete a live install's pages.
    const mediaPreflight = await loadTemplateMediaManifest(template)
    if (mediaPreflight.kind === 'error') return mediaPreflight.response

    // Track every variant file written to UPLOADS_ROOT/variants during
    // provisionTemplateMedia so we can unlink them on TX rollback.
    // copyFile + DB INSERT are NOT jointly transactional — without
    // this list, a failed TX would leak 4 files per used key as orphans.
    // Cleared on TX success so the success path doesn't unlink the
    // files we just committed media rows for.
    const writtenMediaPaths: string[] = []

    // Mirror, opposite semantics: variant files belonging to the
    // PREVIOUS template that we hard-delete from the media table.
    // Populated inside the TX by reapPreviousTemplateMedia; unlinked
    // ONLY after the TX commits successfully. On TX rollback the
    // DELETE FROM media rolls back too — leave the files alone so the
    // operator's Media Library stays consistent with disk.
    let orphanedPathsToUnlink: string[] = []

    try {
      const result = await db.transaction(async (tx) => {
        // TOCTOU guard: re-read install_state INSIDE the transaction
        // with FOR UPDATE so a concurrent /api/install/complete cannot
        // flip `completedAt` mid-wipe. The settings PK is `key`; the
        // FOR UPDATE row-lock blocks any concurrent INSERT/UPDATE on
        // this row until our transaction commits.
        const [stateRows] = (await tx.execute(sql`
          SELECT value FROM settings WHERE \`key\` = 'install_state' FOR UPDATE
        `)) as unknown as [Array<{ value: unknown }>]
        const stateVal = parseSettingsValue(stateRows[0]?.value, 'install_state')
        if (typeof stateVal.completedAt === 'string' && stateVal.completedAt) {
          throw new AlreadyInstalledError()
        }

        // Pull operator-set siteName for branding seed.
        const [siteGeneralRows] = (await tx.execute(sql`
          SELECT value FROM settings WHERE \`key\` = 'site_general'
        `)) as unknown as [Array<{ value: unknown }>]
        const siteGeneral = parseSettingsValue(siteGeneralRows[0]?.value, 'site_general')
        const operatorSiteName =
          typeof siteGeneral.siteName === 'string' && siteGeneral.siteName.trim()
            ? (siteGeneral.siteName as string).trim()
            : ''

        // 0. Reap any previous template's bundled-media rows so they
        //    don't orphan in the Media Library after a re-pick. Hard-
        //    deletes via the media.id cascade (drops media_references
        //    too). Variant file unlinks are deferred until AFTER the
        //    TX commits — if anything below throws, the DELETE rolls
        //    back and the files stay live.
        orphanedPathsToUnlink = await reapPreviousTemplateMedia(tx)

        // 1. Wipe non-legal pages + their content blocks.
        await wipeNonLegalPagesAndBlocks(tx)

        // 2. Provision bundled-template stock imagery (no-op for
        //    text-only templates). For each key the template uses,
        //    copy the bundled variant files into UPLOADS_ROOT/variants/
        //    with fresh UUIDs, INSERT a media row, and build a map
        //    that insertSections uses to inject MediaRefs into widget
        //    data.
        const keyToMedia: Map<string, ResolvedMedia> =
          mediaPreflight.kind === 'ok'
            ? await provisionTemplateMedia(
                tx,
                template.slug,
                mediaPreflight.manifest,
                mediaPreflight.usedKeys,
                writtenMediaPaths,
              )
            : new Map()

        // 3. Insert template pages.
        for (const page of template.pages) {
          const pageId = await insertPage(tx, page)
          await insertSections(tx, pageId, page.sections, keyToMedia)
        }

        // 4. Seed branding from the template.
        await seedTemplateBranding(tx, operatorSiteName, template.branding)

        // 5. Fill the preserved legal pages (privacy, terms) with
        //    generic content if they're empty. The migration creates
        //    the legal page ROWS but ships no content blocks; the
        //    contributor `db:seed` path populates them, but a customer
        //    CLI install never runs that seed — so without this every
        //    install shipped two blank legal pages a footer link could
        //    expose. Seed only when empty so we never clobber an
        //    operator's edited legal copy on a template re-pick.
        await seedEmptyLegalPages(tx)

        return {
          pagesSeeded: template.pages.length,
          mediaSeeded: keyToMedia.size,
        }
      })
      // TX committed — the variant files we copied are now backed by
      // real media rows. Clear the rollback tracker so the finally
      // block doesn't unlink them.
      writtenMediaPaths.length = 0
      // Bust the Next.js router cache. Without this, RSC prefetches +
      // soft-nav lookups for the seeded pages can land on stale 404s
      // / stale splash output until a hard reload. 'layout' scope
      // invalidates the full route tree (home + every dynamically-
      // resolved /<slug>) which is exactly what a template wipe-and-
      // reseed needs.
      revalidatePath('/', 'layout')
      // upsertSettingInTx() above wrote site_header + footer directly
      // through the TX, bypassing the upsertSetting() helper that owns
      // the tag-bust contract. Without this, the first paint of the
      // public site after template pick renders with registry-default
      // placeholders ("Your Site" + bare wordmark) until the 60 s
      // getSetting() TTL expires.
      safeRevalidate([tag.settings]).catch(() => undefined)
      // Post-commit: unlink the previous template's orphaned variant
      // files. The media rows are already gone; this just frees disk.
      // Best-effort — log on failure (operator's Media Library is
      // already correct since the DB is the source of truth).
      if (orphanedPathsToUnlink.length > 0) {
        await Promise.all(
          orphanedPathsToUnlink.map((p) =>
            unlink(p).catch((cleanupErr: unknown) => {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  msg: 'install_template_orphan_reap_unlink_failed',
                  path: p,
                  err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                }),
              )
            }),
          ),
        )
      }
      return okJson({ ok: true, templateSlug: template.slug, ...result })
    } catch (err) {
      // TX failed (or any post-TX throw): unlink every variant file
      // we copied. mediaRows the TX rolled back are gone; without
      // this cleanup the files would orphan in UPLOADS_ROOT/variants/
      // and only the nightly purge would notice. The whole cleanup
      // block is itself wrapped in try/catch so a synchronous throw
      // (e.g. unlink throwing from a path-resolution edge case) can't
      // escape into the outer catch and MASK the original TX error
      // — the operator needs to see why the install failed, not why
      // the cleanup failed.
      if (writtenMediaPaths.length > 0) {
        try {
          await Promise.all(
            writtenMediaPaths.map((p) =>
              unlink(p).catch((cleanupErr: unknown) => {
                // Best-effort — log so the orphan is observable but
                // don't mask the original TX error.
                console.warn(
                  JSON.stringify({
                    level: 'warn',
                    msg: 'install_template_orphan_variant_unlink_failed',
                    path: p,
                    err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                  }),
                )
              }),
            ),
          )
        } catch (cleanupOuter) {
          console.error(
            JSON.stringify({
              level: 'error',
              msg: 'install_template_cleanup_threw',
              err: cleanupOuter instanceof Error ? cleanupOuter.message : String(cleanupOuter),
            }),
          )
        }
      }
      if (err instanceof TemplateMediaUnresolvedError) {
        // Pre-flight should have caught this; if we're here, the
        // manifest and the template have drifted at runtime. Loud
        // structured log + targeted 500 with the missing key so the
        // publisher can fix in the next release.
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'install_template_media_unresolved',
            templateSlug: body.templateSlug,
            key: err.key,
            blockType: err.blockType,
            field: err.field,
          }),
        )
        return errJson(500, 'template_media_unresolved', { key: err.key })
      }
      if (err instanceof AlreadyInstalledError) {
        return new Response(
          JSON.stringify({ error: 'already_installed' }),
          {
            status: 410,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          },
        )
      }
      if (err instanceof Error && err.message === 'preserved_legal_pages_missing') {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'install_template_preserved_pages_missing',
            templateSlug: body.templateSlug,
          }),
        )
        return errJson(500, 'preserved_legal_pages_missing')
      }
      // ZodError from SectionMetaSchema / ColumnMetaSchema / parseAndSanitize
      // bubbles to withError, which already converts it to a structured
      // 400 with a requestId. Don't swallow — let it propagate so the
      // operator sees a consistent error envelope across endpoints.
      throw err
    }
  } finally {
    clearTimeout(watchdog)
    if (busyToken === myToken) busyToken = null
  }
})

/**
 * DELETE /api/install/template — clear template seed (admin/debug
 * surface). Intentionally NOT exposed — the wizard never calls this,
 * and /api/install/complete locks the entire /api/install/* family.
 * Listed here only so a future operator/maintainer doesn't reinvent it.
 */
