#!/usr/bin/env -S node --import tsx

/**
 * Validates every widget across every site template by running its
 * data through the canonical CMS parse+sanitize gate. Catches
 * schema-violation bugs in template authoring BEFORE the install API
 * tries to seed them and 500s the wizard.
 *
 * Run: pnpm tsx scripts/validate-site-templates.ts
 *
 * Exits 0 on success, 1 on any validation failure (with a clear
 * trace pointing at the bad widget).
 *
 * Also asserts:
 *   - every template has exactly ONE isHome page
 *   - every template's pages have unique slugs
 *   - every template slug is unique across the registry
 *
 * This script does NOT touch the DB. Pure validation.
 */

// CAVECMS_BUILD_OK=1 is the legitimate-prod-build opt-in (same pattern as
// verify-route-collisions.ts + postbuild-check-slug-collisions.ts): the
// in-app updater's customer-box build AND the server-side release build
// both run `pnpm build` under NODE_ENV=production live. Without this
// escape the prebuild gate hard-fails every production build, which would
// break git-fetch-mode in-app updates too. Refuse only when it's NOT a
// sanctioned build (a stray invocation on a live server boot).
if (
  process.env.NODE_ENV === 'production' &&
  process.env['CAVECMS_BUILD_OK'] !== '1'
) {
  console.error(
    '[validate-site-templates] refusing to run with NODE_ENV=production.',
  )
  console.error(
    '[validate-site-templates]   In-app updater / release build path: set CAVECMS_BUILD_OK=1.',
  )
  process.exit(1)
}

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SITE_TEMPLATES } from '../lib/cms/siteTemplates/index'
import { TEMPLATE_CLIENT_META } from '../lib/cms/siteTemplates/clientMeta'
import {
  collectImageKeys,
  extractImageKeys,
} from '../lib/cms/siteTemplates/extractImageKeys'
import { parseAndSanitize } from '../lib/cms/parse'
import {
  SectionMetaSchema,
  ColumnMetaSchema,
} from '../lib/cms/blockMeta'
import type { WidgetSpec } from '../lib/cms/siteTemplates/types'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(__filename), '..')
const TEMPLATES_DIR = join(REPO_ROOT, 'lib', 'cms', 'siteTemplates')

/**
 * Templates that use image helpers emit widget.data WITHOUT the
 * required MediaRef fields — those get injected at install time
 * from the bundled-media manifest. To run parseAndSanitize at
 * validation time (before any install has happened) we inject a
 * placeholder MediaRef matching the schema's MediaRef shape
 * (positive media_id + non-empty alt). Mutates a CLONED widget so
 * the registry shape stays pristine for the actual install path.
 */
function widgetWithStubbedImages(widget: WidgetSpec): WidgetSpec {
  if (!widget._imageKeys) return widget
  // Shallow clone data — replacement is at top-level fields only.
  const stubbedData: Record<string, unknown> = { ...widget.data }
  const alts = widget._imageAlts ?? {}
  for (const field of Object.keys(widget._imageKeys)) {
    stubbedData[field] = {
      media_id: 1,
      alt: alts[field] && alts[field].length > 0 ? alts[field] : 'placeholder',
    }
  }
  return { ...widget, data: stubbedData }
}

let errors = 0

function fail(msg: string) {
  errors += 1
  console.error(`  ✗ ${msg}`)
}

// 0. Registry has at least one template (z.enum([]) is a runtime bomb).
if (SITE_TEMPLATES.length === 0) {
  fail('SITE_TEMPLATES is empty — at least one template must be registered.')
}

// 1. Slug uniqueness across the registry.
{
  const seen = new Map<string, number>()
  for (const t of SITE_TEMPLATES) {
    seen.set(t.slug, (seen.get(t.slug) ?? 0) + 1)
  }
  for (const [slug, count] of seen) {
    if (count > 1) fail(`template slug "${slug}" appears ${count} times`)
  }
}

// 1b. clientMeta tile list (used by the wizard picker) must mirror
//     the server registry exactly. A contributor adding a new
//     template to SITE_TEMPLATES without updating TEMPLATE_CLIENT_META
//     ships a wizard that doesn't show the tile — the server accepts
//     the slug but the operator can't reach it through the picker.
{
  const serverSlugs = new Set(SITE_TEMPLATES.map((t) => t.slug))
  const clientSlugs = new Set(TEMPLATE_CLIENT_META.map((t) => t.slug))
  for (const s of serverSlugs) {
    if (!clientSlugs.has(s)) {
      fail(`server registry has slug "${s}" but TEMPLATE_CLIENT_META does not — wizard tile missing.`)
    }
  }
  for (const s of clientSlugs) {
    if (!serverSlugs.has(s)) {
      fail(`TEMPLATE_CLIENT_META has slug "${s}" but server registry does not — wizard would 400 on selection.`)
    }
  }
}

// 2. Per-template validations.
for (const t of SITE_TEMPLATES) {
  console.log(`▸ ${t.slug}  (${t.pages.length} pages)`)

  // 2a. Exactly one home page per template (unless default-welcome
  //     with no pages, which would be a different bug — checked below).
  const homePages = t.pages.filter((p) => p.isHome)
  if (homePages.length === 0 && t.pages.length > 0) {
    fail(`${t.slug}: no page marked isHome`)
  }
  if (homePages.length > 1) {
    fail(
      `${t.slug}: ${homePages.length} pages marked isHome — only one allowed`,
    )
  }

  // 2b. Page slugs unique within the template.
  const slugSeen = new Map<string, number>()
  for (const p of t.pages) {
    slugSeen.set(p.slug, (slugSeen.get(p.slug) ?? 0) + 1)
  }
  for (const [slug, count] of slugSeen) {
    if (count > 1) {
      fail(`${t.slug}: page slug "${slug}" appears ${count} times`)
    }
  }

  // 2c. Page slugs do NOT collide with preserved system pages. These rows
  // survive the template wipe (route preservedPageIds), so a template that
  // also declared one would lose its content to the preserved row or hit a
  // slug-unique collision. 'blog' is preserved (F2) — its index is
  // template-agnostic (0039 row + boot backfill own it), so no template
  // ships a blog page.
  const PRESERVED = new Set([
    'privacy',
    'terms',
    'thank-you-enquiry',
    'thank-you-tour',
    'thank-you-brochure',
    'blog',
  ])
  for (const p of t.pages) {
    if (PRESERVED.has(p.slug)) {
      fail(
        `${t.slug}: page slug "${p.slug}" collides with a preserved system page — it is preserved across the template wipe, so a template must not ship it.`,
      )
    }
  }

  // 2d. Walk every widget and run it through parseAndSanitize.
  let widgetCount = 0
  for (const page of t.pages) {
    for (let sIdx = 0; sIdx < page.sections.length; sIdx++) {
      const section = page.sections[sIdx]
      if (!section || section.kind !== 'section') {
        fail(`${t.slug}/${page.slug}/section[${sIdx}]: kind !== 'section'`)
        continue
      }
      // Validate section meta shape (same gate the install endpoint runs).
      try {
        SectionMetaSchema.parse(section.meta)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        fail(`${t.slug}/${page.slug}/section[${sIdx}] meta: ${msg}`)
      }
      for (let cIdx = 0; cIdx < section.columns.length; cIdx++) {
        const column = section.columns[cIdx]
        if (!column || column.kind !== 'column') {
          fail(
            `${t.slug}/${page.slug}/section[${sIdx}]/column[${cIdx}]: kind !== 'column'`,
          )
          continue
        }
        // Validate column meta shape too.
        try {
          ColumnMetaSchema.parse(column.meta ?? {})
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          fail(`${t.slug}/${page.slug}/section[${sIdx}]/column[${cIdx}] meta: ${msg}`)
        }
        for (let wIdx = 0; wIdx < column.widgets.length; wIdx++) {
          const widget = column.widgets[wIdx]
          if (!widget || widget.kind !== 'widget') {
            fail(
              `${t.slug}/${page.slug}/section[${sIdx}]/column[${cIdx}]/widget[${wIdx}]: kind !== 'widget'`,
            )
            continue
          }
          widgetCount += 1
          try {
            // Widgets carrying _imageKeys have unresolved image
            // slots at validation time — inject placeholder
            // MediaRefs matching the schema so parseAndSanitize
            // exercises every other field. The install-route
            // injects real refs from the bundled manifest.
            const stubbed = widgetWithStubbedImages(widget)
            parseAndSanitize(stubbed.blockType, stubbed.data)
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : String(err)
            fail(
              `${t.slug}/${page.slug}/section[${sIdx}]/column[${cIdx}]/widget[${wIdx}] (${widget.blockType}): ${msg}`,
            )
          }
        }
      }
    }
  }

  // 2d.5 Image-key coverage: every imageKey the template references
  //      must exist in <slug>/media-sources.json. Templates that
  //      don't use any image helpers skip this entirely.
  const usedKeys = collectImageKeys(t)
  if (usedKeys.size > 0) {
    const sourcesPath = join(TEMPLATES_DIR, t.slug, 'media-sources.json')
    if (!existsSync(sourcesPath)) {
      fail(
        `${t.slug}: references ${usedKeys.size} imageKey(s) but no media-sources.json exists at lib/cms/siteTemplates/${t.slug}/media-sources.json`,
      )
    } else {
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(sourcesPath, 'utf8'))
      } catch (err) {
        fail(`${t.slug}: media-sources.json is not valid JSON — ${err instanceof Error ? err.message : String(err)}`)
        raw = []
      }
      if (!Array.isArray(raw)) {
        fail(`${t.slug}: media-sources.json must be a JSON array of {key, sourceUrl, alt, photographer, license}`)
        raw = []
      }
      const declaredKeys = new Set<string>()
      for (const entry of raw as Array<Record<string, unknown>>) {
        if (entry && typeof entry === 'object' && typeof entry.key === 'string') {
          declaredKeys.add(entry.key)
        }
      }
      // Missing: template references a key the sources file doesn't declare.
      const missing: string[] = []
      for (const key of usedKeys) {
        if (!declaredKeys.has(key)) missing.push(key)
      }
      if (missing.length > 0) {
        // Surface where each missing key is actually used so the
        // contributor can find + fix immediately.
        const refs = extractImageKeys(t).filter((r) => missing.includes(r.key))
        for (const r of refs.slice(0, 10)) {
          fail(
            `${t.slug}: imageKey "${r.key}" used at /${r.page} section[${r.sectionIdx}] col[${r.columnIdx}] widget[${r.widgetIdx}] (${r.blockType}.${r.field}) but missing from media-sources.json`,
          )
        }
        if (refs.length > 10) {
          fail(`${t.slug}: …and ${refs.length - 10} more imageKey references missing from media-sources.json`)
        }
      }
      // Orphaned: sources file declares a key the template doesn't use.
      // Warn (don't fail) — author may be staging an image for a
      // future template change.
      for (const k of declaredKeys) {
        if (!usedKeys.has(k)) {
          console.warn(
            `  ⚠ ${t.slug}: media-sources.json declares "${k}" but no widget references it (orphan — fine for staging, otherwise unused).`,
          )
        }
      }
    }
  }

  // 2e. Branding shape sanity.
  if (t.branding.primaryNav.length > 6) {
    fail(
      `${t.slug}: primaryNav has ${t.branding.primaryNav.length} items — site_header schema caps at 6.`,
    )
  }
  if (t.branding.footerColumns.length > 6) {
    fail(
      `${t.slug}: footerColumns has ${t.branding.footerColumns.length} — footer schema caps at 6.`,
    )
  }
  for (const col of t.branding.footerColumns) {
    if (col.links.length > 20) {
      fail(
        `${t.slug}: footer column "${col.label}" has ${col.links.length} links — schema caps at 20.`,
      )
    }
  }

  console.log(`  ✓ ${widgetCount} widgets validated`)
}

if (errors === 0) {
  console.log(`\n✓ all ${SITE_TEMPLATES.length} templates valid`)
  process.exit(0)
} else {
  console.error(`\n✗ ${errors} validation error(s) — fix before deploying`)
  process.exit(1)
}
