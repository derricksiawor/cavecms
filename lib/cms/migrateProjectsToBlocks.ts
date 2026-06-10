import 'server-only'
import { sql } from 'drizzle-orm'
import { ZodError } from 'zod'
import { db, type Tx } from '@/db/client'
import { parseAndSanitize } from './parse'
import { collectMediaPaths } from './mediaRefs'
import { assertMediaAvailable } from './mediaCheck'
import { buildProjectSections, type ProjectSectionInput } from './projectTreeBuilder'
import { SectionMetaSchema, ColumnMetaSchema } from './blockMeta'

// Engine for the projects→CMS-blocks migration. Converts a project's
// `project_sections` rows into a `pages` row + a content_blocks
// section→column→widget tree at the project's slug — the shape the
// project route (app/projects/[slug]/page.tsx) renders through
// EditableMain so the page becomes front-end inline-editable. Mirrors
// the POST /api/cms/blocks insert path exactly (parseAndSanitize →
// content_blocks insert → collectMediaPaths → assertMediaAvailable →
// media_references) so a migrated tree is indistinguishable from a
// hand-authored page.
//
// Per-project, one transaction. Validate-before-write: every band is
// parsed BEFORE any INSERT, and the media availability check runs
// before the inserts too, so a project either lands whole or not at
// all (the TX rolls back on any failure — no half-tree). Idempotent:
// a project that already has a `pages` row at its slug is SKIPPED
// (re-running is safe). Does NOT touch project_sections — those rows
// survive as the JSON-LD / FactsStrip pricing source + a recovery
// fallback until the legacy render branch retires.
//
// Used by both the publisher/test CLI (scripts/backfill-projects-to-blocks.ts,
// publish: 'draft' → dark-launch then flip) and the customer-install
// auto-migration step run during an update (publish: 'inherit' → a
// project that was live stays live the moment its tree validates; a
// project whose tree fails validation is left for the legacy branch and
// reported FAIL).

export interface ProjectMigrationOutcome {
  projectId: number
  slug: string
  status: 'migrated' | 'skipped' | 'failed'
  /** Machine reason for skip/fail (e.g. 'pages_row_exists',
   *  'parse_failed', 'stale_media'). */
  reason?: string
  /** The block type + field that failed validation, when known —
   *  surfaced in the report so an operator can remediate the exact
   *  section and re-run. */
  detail?: string
  pageId?: number
  bands?: number
  /** brochure.pdf was set in the section JSON but the project row's
   *  brochure_pdf_id is null — the migrated brochure form gates on the
   *  column, so the section PDF would be lost. Flagged (not fatal) so
   *  the operator can copy it across under Projects → Brochure. */
  brochurePdfDivergence?: boolean
}

export interface ProjectsMigrationReport {
  total: number
  migrated: number
  skipped: number
  failed: number
  outcomes: ProjectMigrationOutcome[]
}

export interface MigrateProjectsOpts {
  /** 'inherit' (default): the new page's `published` mirrors the
   *  project's, so a published project goes live on the CMS branch the
   *  instant its tree validates. 'draft': always insert published=0 so
   *  a human verifies each migrated page before flipping it live (the
   *  dev/publisher dark-launch path). */
  publish?: 'inherit' | 'draft'
  /** Optional cap — migrate at most N projects (test convenience). */
  limit?: number
  /** Optional structured logger; defaults to console.log of a JSON line
   *  per project so the customer-install updater can stream progress. */
  onOutcome?: (o: ProjectMigrationOutcome) => void
}

class ProjectMigrationError extends Error {
  constructor(
    public readonly reason: string,
    public readonly detail?: string,
  ) {
    super(reason)
    this.name = 'ProjectMigrationError'
  }
}

interface ProjectRow {
  id: number
  slug: string
  name: string
  status: string
  location: string | null
  published: number
  brochure_pdf_id: number | null
}

function parseSectionDataCell(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw ?? {}
}

function zodDetail(blockType: string, err: unknown): string {
  if (err instanceof ZodError) {
    const issue = err.issues[0]
    const path = issue?.path?.join('.') ?? ''
    return path ? `${blockType}.${path}` : blockType
  }
  return blockType
}

async function insertBlock(
  tx: Tx,
  pageId: number,
  parentId: number | null,
  kind: 'section' | 'column' | 'widget',
  blockType: string,
  position: number,
  dataJson: string,
  metaJson: string | null,
): Promise<number> {
  const [res] = (await tx.execute(sql`
    INSERT INTO content_blocks
      (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
    VALUES (
      ${pageId}, ${parentId}, ${kind}, ${blockType}, ${position},
      ${dataJson}, ${metaJson}, 0, NULL
    )
  `)) as unknown as [{ insertId: number }]
  return Number(res.insertId)
}

/**
 * Build + insert a project's CMS block tree (pages row +
 * section→column→widget triples + media_references) inside the GIVEN
 * transaction. Validate-before-write: every band is parsed and all
 * referenced media asserted alive BEFORE any INSERT, so the caller's TX
 * either lands the whole tree or rolls back — never a half-tree.
 *
 * Shared by the backfill (one project per TX, after its idempotency
 * guard) and POST /api/cms/projects (a brand-new project, in the same
 * TX as the project insert). Throws ProjectMigrationError on a parse /
 * media failure; the caller decides how to surface it. Does NOT guard
 * against an existing pages row at the slug — the backfill SKIPs that
 * case before calling, and new-project creation is fronted by the
 * projects.slug + pages.slug UNIQUE constraints.
 */
export async function insertProjectPageTree(
  tx: Tx,
  project: {
    id: number
    slug: string
    name: string
    status: string
    location: string | null
    published: number
    brochure_pdf_id: number | null
  },
  sections: ProjectSectionInput[],
  publish: 'inherit' | 'draft',
): Promise<{ pageId: number; bands: number; brochurePdfDivergence: boolean }> {
  // Brochure-PDF divergence detector: brochure.pdf set in the section
  // JSON but projects.brochure_pdf_id null → the migrated brochure form
  // (which gates on the column) would drop it. Non-fatal; reported.
  const brochureSection = sections.find((s) => s.sectionKey === 'brochure')
  const brochurePdf =
    brochureSection &&
    typeof brochureSection.data === 'object' &&
    brochureSection.data !== null
      ? (brochureSection.data as Record<string, unknown>).pdf
      : null
  const brochurePdfDivergence = !!brochurePdf && project.brochure_pdf_id === null

  // Build the section list (each section = host meta + primitive
  // widgets), then VALIDATE everything before any INSERT (validate-
  // before-write — any 422 aborts the whole project cleanly):
  //   - each host-section meta through SectionMetaSchema
  //   - each widget through parseAndSanitize
  const built = buildProjectSections(
    {
      id: project.id,
      slug: project.slug,
      name: project.name,
      status: project.status,
      location: project.location,
      brochurePdfId: project.brochure_pdf_id,
    },
    sections,
  )
  const validated = built.map((sec) => {
    let meta
    try {
      meta = SectionMetaSchema.parse(sec.meta)
    } catch (err) {
      throw new ProjectMigrationError('section_meta_invalid', zodDetail('section', err))
    }
    const columns = sec.columns.map((col) => {
      let colMetaJson = '{}'
      if (col.meta) {
        try {
          colMetaJson = JSON.stringify(ColumnMetaSchema.parse(col.meta))
        } catch (err) {
          throw new ProjectMigrationError('column_meta_invalid', zodDetail('column', err))
        }
      }
      const widgets = col.widgets.map((w) => {
        try {
          return { blockType: w.blockType, data: parseAndSanitize(w.blockType, w.data) }
        } catch (err) {
          throw new ProjectMigrationError('parse_failed', zodDetail(w.blockType, err))
        }
      })
      return { metaJson: colMetaJson, widgets }
    })
    const bg = meta.backgroundImage
    return { metaJson: JSON.stringify(meta), bgMediaId: bg ? bg.media_id : null, columns }
  })

  // Collect EVERY referenced media id (widget data + section-background
  // images — the hero photo now lives in section meta, not widget data,
  // so collectMediaPaths wouldn't see it) and assert all are alive
  // BEFORE inserting, so a stale media_id fails with nothing written.
  const mediaIds = new Set<number>()
  for (const sec of validated) {
    if (sec.bgMediaId !== null) mediaIds.add(sec.bgMediaId)
    for (const col of sec.columns) {
      for (const w of col.widgets) {
        collectMediaPaths(w.data).forEach((ref) => mediaIds.add(ref.mediaId))
      }
    }
  }
  try {
    await assertMediaAvailable(tx, [...mediaIds])
  } catch {
    throw new ProjectMigrationError('stale_media')
  }

  // INSERT the pages row. Project pages use the PROJECT row for SEO +
  // JSON-LD (generateMetadata reads getProjectRow), so the page row
  // carries no seo_*/hero/og — it's purely the block-tree container.
  const publishedFlag = publish === 'draft' ? 0 : project.published
  const [pageRes] = (await tx.execute(sql`
    INSERT INTO pages
      (slug, title, is_home, system, published, published_at)
    VALUES (
      ${project.slug}, ${project.name}, 0, 0, ${publishedFlag},
      ${publishedFlag ? sql`NOW(3)` : sql`NULL`}
    )
  `)) as unknown as [{ insertId: number }]
  const pageId = Number(pageRes.insertId)

  // INSERT each section (with its host meta) → its column(s) → each
  // column's ordered primitive widgets, all 1000-spaced. Sections are
  // single-column except the location band (two columns: rail + map).
  // media_references mirror POST /api/cms/blocks: per widget for
  // widget-data media, PLUS a section-level ref for a section
  // background image (hero photo).
  let sectionPos = 1000
  let widgetCount = 0
  for (const sec of validated) {
    const sectionId = await insertBlock(
      tx, pageId, null, 'section', 'section', sectionPos, '{}', sec.metaJson,
    )
    if (sec.bgMediaId !== null) {
      await tx.execute(sql`
        INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
        VALUES (${sec.bgMediaId}, 'content_block', ${sectionId}, 'backgroundImage.media_id')
      `)
    }
    let columnPos = 1000
    for (const col of sec.columns) {
      const columnId = await insertBlock(
        tx, pageId, sectionId, 'column', 'column', columnPos, '{}', col.metaJson,
      )
      let widgetPos = 1000
      for (const w of col.widgets) {
        const widgetId = await insertBlock(
          tx, pageId, columnId, 'widget', w.blockType, widgetPos, JSON.stringify(w.data), null,
        )
        for (const ref of collectMediaPaths(w.data)) {
          await tx.execute(sql`
            INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${ref.mediaId}, 'content_block', ${widgetId}, ${ref.field})
          `)
        }
        widgetPos += 1000
        widgetCount += 1
      }
      columnPos += 1000
    }
    sectionPos += 1000
  }

  return { pageId, bands: widgetCount, brochurePdfDivergence }
}

async function migrateOne(
  project: ProjectRow,
  publish: 'inherit' | 'draft',
): Promise<ProjectMigrationOutcome> {
  const base = { projectId: project.id, slug: project.slug }
  try {
    const out = await db.transaction(async (tx) => {
      // 1. Idempotency + slug-collision guard. NO deleted_at / published
      //    filter — ANY existing row at this slug (live, trashed, or a
      //    half-migrated draft) means we must not insert again (slug is
      //    UNIQUE on pages) and must not clobber another page.
      const [existing] = (await tx.execute(sql`
        SELECT id FROM pages WHERE slug = ${project.slug} LIMIT 1
      `)) as unknown as [Array<{ id: number }>]
      if (existing.length > 0) {
        return { kind: 'skip' as const, reason: 'pages_row_exists' }
      }

      // 2. Read sections in position order (encodes hero-first +
      //    operator reorders).
      const [secRows] = (await tx.execute(sql`
        SELECT section_key, position, data
        FROM project_sections
        WHERE project_id = ${project.id}
        ORDER BY position
      `)) as unknown as [
        Array<{ section_key: string; position: number; data: unknown }>,
      ]
      const sections = secRows.map((r) => ({
        sectionKey: r.section_key,
        data: parseSectionDataCell(r.data),
      }))

      const r = await insertProjectPageTree(tx, project, sections, publish)
      return { kind: 'migrated' as const, ...r }
    })

    if (out.kind === 'skip') {
      return { ...base, status: 'skipped', reason: out.reason }
    }
    return {
      ...base,
      status: 'migrated',
      pageId: out.pageId,
      bands: out.bands,
      ...(out.brochurePdfDivergence ? { brochurePdfDivergence: true } : {}),
    }
  } catch (err) {
    if (err instanceof ProjectMigrationError) {
      return { ...base, status: 'failed', reason: err.reason, detail: err.detail }
    }
    // Unexpected (DB error, etc.) — report this project failed but let
    // the batch continue so one bad row never aborts the whole run.
    return {
      ...base,
      status: 'failed',
      reason: 'unexpected_error',
      detail: err instanceof Error ? err.name : 'unknown',
    }
  }
}

export async function migrateProjectsToBlocks(
  opts: MigrateProjectsOpts = {},
): Promise<ProjectsMigrationReport> {
  const publish = opts.publish ?? 'inherit'
  const [projectRows] = (await db.execute(sql`
    SELECT id, slug, name, status, location, published, brochure_pdf_id
    FROM projects
    WHERE deleted_at IS NULL
    ORDER BY id
  `)) as unknown as [ProjectRow[]]

  const projects =
    typeof opts.limit === 'number' ? projectRows.slice(0, opts.limit) : projectRows

  const outcomes: ProjectMigrationOutcome[] = []
  for (const p of projects) {
    const outcome = await migrateOne(p, publish)
    outcomes.push(outcome)
    if (opts.onOutcome) opts.onOutcome(outcome)
  }

  return {
    total: outcomes.length,
    migrated: outcomes.filter((o) => o.status === 'migrated').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
  }
}
