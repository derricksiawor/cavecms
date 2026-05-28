import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, access, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
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
import { parseAndSanitize } from '@/lib/cms/parse'
import { SectionMetaSchema, ColumnMetaSchema } from '@/lib/cms/blockMeta'
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

const Body = z
  .object({
    templateSlug: z
      .enum(TEMPLATE_SLUGS as [string, ...string[]])
      .default(DEFAULT_TEMPLATE_SLUG),
  })
  .strict()

const installLimit = makeInstallLimit('template')
const POS_STEP = 1000

// In-process semaphore. Two operator tabs both clicking Continue on
// the Template step would otherwise interleave a wipe with another
// tab's reseed. The DB transaction below holds row-locks against
// concurrent /complete, but ANOTHER /template call from the same
// install would also block on those locks — slower than necessary
// when we can cheaply reject the second caller. Same shape as
// `app/api/cms/media/route.ts` (`busyToken`).
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
 * Returns the IDs of pages we MUST preserve across a template wipe.
 * Filtered on `deleted_at IS NULL` so a soft-deleted legal page
 * (operator deleted /privacy via /admin/pages) doesn't survive as a
 * tombstone — it gets hard-wiped and re-created by the next migration
 * pass. Throws if the expected legal-page set is missing entirely
 * (i.e. migrations didn't run): we refuse to proceed rather than
 * blanket-wipe.
 */
async function preservedPageIds(tx: Tx): Promise<number[]> {
  const [rows] = (await tx.execute(sql`
    SELECT id FROM pages
    WHERE slug IN ('privacy','terms','thank-you-enquiry','thank-you-tour','thank-you-brochure')
      AND deleted_at IS NULL
  `)) as unknown as [Array<{ id: number }>]
  return rows.map((r) => Number(r.id))
}

async function wipeNonLegalPagesAndBlocks(tx: Tx): Promise<void> {
  const keepIds = await preservedPageIds(tx)
  if (keepIds.length === 0) {
    // No legal pages survived → migrations didn't run, or someone
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
    WHERE slug IN ('privacy','terms','thank-you-enquiry','thank-you-tour','thank-you-brochure')
      AND is_home = 1
  `)

  // FK content_blocks.page_id → pages.id has ON DELETE CASCADE, so
  // deleting pages would cascade-delete content_blocks. We DELETE
  // content_blocks first anyway as belt-and-braces — also leaves
  // the FK invariant satisfied for the page DELETE that follows.
  const idList = sql.join(
    keepIds.map((id) => sql`${id}`),
    sql`, `,
  )
  await tx.execute(sql`
    DELETE FROM content_blocks WHERE page_id NOT IN (${idList})
  `)
  await tx.execute(sql`
    DELETE FROM pages WHERE id NOT IN (${idList})
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

const TemplateMediaEntry = z.object({
  key: z.string().min(1),
  alt: z.string().min(1),
  mime: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteSize: z.number().int().nonnegative(),
  variants: z.object({
    thumb: z.string().min(1),
    md: z.string().min(1),
    lg: z.string().min(1),
    og: z.string().min(1),
  }),
  sourceUrl: z.string().min(1),
  photographer: z.string(),
  license: z.string().min(1),
})

const TemplateMediaManifest = z.object({
  templateSlug: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.record(z.string(), TemplateMediaEntry),
})

type TemplateMediaEntryT = z.infer<typeof TemplateMediaEntry>
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
    const copyPlan: Array<{ src: string; dst: string }> = [
      { src: path.join(srcDir, entry.variants.thumb), dst: path.join(PATHS.variants, `${uuid}-thumb.webp`) },
      { src: path.join(srcDir, entry.variants.md),    dst: path.join(PATHS.variants, `${uuid}-md.webp`) },
      { src: path.join(srcDir, entry.variants.lg),    dst: path.join(PATHS.variants, `${uuid}-lg.webp`) },
      { src: path.join(srcDir, entry.variants.og),    dst: path.join(PATHS.variants, `${uuid}-og.jpg`) },
    ]
    for (const { src, dst } of copyPlan) {
      await copyFile(src, dst)
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

    const originalName = `template/${templateSlug}/${key}`
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
 * Returns the per-field media_id list so the caller can write
 * media_references rows after the widget INSERT.
 *
 * MUTATES the widget. Template specs in this code path are produced
 * once per request from the (frozen) site-templates registry; we
 * don't share references across requests, so in-place mutation is
 * safe.
 */
function injectMediaRefs(
  widget: WidgetSpec,
  keyToMedia: Map<string, ResolvedMedia>,
): Array<{ field: string; mediaId: number }> {
  if (!widget._imageKeys) return []
  const refs: Array<{ field: string; mediaId: number }> = []
  const alts = widget._imageAlts ?? {}
  for (const [field, key] of Object.entries(widget._imageKeys)) {
    const resolved = keyToMedia.get(key)
    if (!resolved) {
      // Pre-flight + provisionTemplateMedia already guard this; throw
      // loudly if we get here so a future regression is impossible
      // to ignore.
      throw new Error(`template_media_unresolved_in_inject:${key}`)
    }
    widget.data[field] = {
      media_id: resolved.mediaId,
      // Prefer the template-author-provided alt (more contextual than
      // the manifest alt — same image used in two places may want
      // different alt copy).
      alt: alts[field] ?? resolved.alt,
    }
    refs.push({ field, mediaId: resolved.mediaId })
  }
  // Strip the transport fields so the rest of insertSections never
  // sees them and they don't accidentally end up in JSON.stringify of
  // widget.meta.
  delete widget._imageKeys
  delete widget._imageAlts
  return refs
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
        // we use as transport. Mutating widget in place is safe —
        // it's a per-request value cloned from the template registry.
        const mediaRefs = injectMediaRefs(w, keyToMedia)

        // Run the widget data through the canonical CMS sanitize+parse
        // gate so any field-level schema violation in a template file
        // surfaces here (transaction rolls back the whole reseed)
        // instead of at next page-render.
        const cleaned = parseAndSanitize(w.blockType, w.data) as Record<string, unknown>
        const widgetMetaJson = w.meta ? JSON.stringify(w.meta) : null
        const [widRes] = (await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
          VALUES
            (${pageId}, ${columnId}, 'widget', NULL, ${w.blockType}, ${widPos},
             ${JSON.stringify(cleaned)}, ${widgetMetaJson}, 0)
        `)) as unknown as [InsertResult]
        const widgetId = Number(widRes.insertId)

        // Reverse-index this widget's bundled media so DELETE
        // /api/cms/media/[id] refuses to drop a row while a template
        // page still references it. Without this, an operator who
        // "deletes" a hero photo from the Media Library would orphan
        // the page's image to a 404. Composite PK guarantees
        // (media_id, content_block, widget_id, field) is unique, so
        // a re-run of the seed (idempotent) self-heals.
        for (const ref of mediaRefs) {
          await tx.execute(sql`
            INSERT INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${ref.mediaId}, 'content_block', ${widgetId}, ${ref.field})
            ON DUPLICATE KEY UPDATE media_id = media_id
          `)
        }

        widPos += POS_STEP
      }
      colPos += POS_STEP
    }
    secPos += POS_STEP
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
  let preservedLogo: Record<string, unknown> | null = null
  const headerLogo = existingHeader.logo as { media_id?: number; alt?: string } | null | undefined
  if (headerLogo && typeof headerLogo.media_id === 'number') {
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
    // Slugs cannot collide with the preserved system pages — the
    // wipe would delete them just before reinsert and we'd lose
    // the legal-page content.
    if (
      p.slug === 'privacy' ||
      p.slug === 'terms' ||
      p.slug === 'thank-you-enquiry' ||
      p.slug === 'thank-you-tour' ||
      p.slug === 'thank-you-brochure'
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
    const template = getTemplate(body.templateSlug)
    if (!template) {
      return errJson(400, 'unknown_template')
    }

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

        return {
          pagesSeeded: template.pages.length,
          mediaSeeded: keyToMedia.size,
        }
      })
      // TX committed — the variant files we copied are now backed by
      // real media rows. Clear the rollback tracker so the finally
      // block doesn't unlink them.
      writtenMediaPaths.length = 0
      return okJson({ ok: true, templateSlug: template.slug, ...result })
    } catch (err) {
      // TX failed (or any post-TX throw): unlink every variant file
      // we copied. mediaRows the TX rolled back are gone; without
      // this cleanup the files would orphan in UPLOADS_ROOT/variants/
      // and only the nightly purge would notice.
      if (writtenMediaPaths.length > 0) {
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
