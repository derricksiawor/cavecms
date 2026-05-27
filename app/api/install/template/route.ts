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
import type { PageSpec, SectionSpec, SiteTemplate } from '@/lib/cms/siteTemplates'
import { parseAndSanitize } from '@/lib/cms/parse'
import { SectionMetaSchema, ColumnMetaSchema } from '@/lib/cms/blockMeta'

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
        // Run the widget data through the canonical CMS sanitize+parse
        // gate so any field-level schema violation in a template file
        // surfaces here (transaction rolls back the whole reseed)
        // instead of at next page-render.
        const cleaned = parseAndSanitize(w.blockType, w.data) as Record<string, unknown>
        const widgetMetaJson = w.meta ? JSON.stringify(w.meta) : null
        await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
          VALUES
            (${pageId}, ${columnId}, 'widget', NULL, ${w.blockType}, ${widPos},
             ${JSON.stringify(cleaned)}, ${widgetMetaJson}, 0)
        `)
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

        // 2. Insert template pages.
        for (const page of template.pages) {
          const pageId = await insertPage(tx, page)
          await insertSections(tx, pageId, page.sections)
        }

        // 3. Seed branding from the template.
        await seedTemplateBranding(tx, operatorSiteName, template.branding)

        return { pagesSeeded: template.pages.length }
      })
      return okJson({ ok: true, templateSlug: template.slug, ...result })
    } catch (err) {
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
