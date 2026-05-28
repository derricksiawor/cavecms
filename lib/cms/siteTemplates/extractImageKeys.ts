import type { SiteTemplate, WidgetSpec } from './types'

// Walks a SiteTemplate tree and yields every image-key reference its
// widgets carry. Used by three callers:
//
//   1. validate-site-templates.ts at prebuild — fails the build if any
//      key referenced by a template isn't covered by that template's
//      media-sources.json.
//   2. scripts/release/build-template-media.mjs — knows which keys are
//      live so it can fail loudly on a manifest/template drift.
//   3. app/api/install/template/route.ts — pre-validates a template's
//      bundled manifest BEFORE the wipe + reseed transaction runs.
//
// The walker returns location coordinates (page/section/column/widget
// indices) alongside the key so a validation error can name the exact
// spot in the template tree. The install route doesn't use the indices
// itself (it walks the same tree and mutates widgets in place during
// insert), but having a single ground-truth extractor prevents
// validation drift between "build-time check" and "runtime check".

export interface ImageKeyRef {
  /** Page slug (e.g. 'home', 'rooms') */
  page: string
  /** Section position within the page, 0-indexed */
  sectionIdx: number
  /** Column position within the section, 0-indexed */
  columnIdx: number
  /** Widget position within the column, 0-indexed */
  widgetIdx: number
  /** blockType of the widget carrying the reference */
  blockType: string
  /** Schema field name receiving the resolved MediaRef (e.g. 'image', 'leftImage') */
  field: string
  /** Bundled-media key the field resolves to */
  key: string
  /** Human-readable alt text for the resolved MediaRef */
  alt: string
}

/**
 * Returns every (page, position, field, key, alt) tuple in the template.
 * Empty array for templates that don't use any image-bearing widgets.
 */
export function extractImageKeys(template: SiteTemplate): ImageKeyRef[] {
  const out: ImageKeyRef[] = []
  for (const page of template.pages) {
    page.sections.forEach((section, sectionIdx) => {
      section.columns.forEach((column, columnIdx) => {
        column.widgets.forEach((widget, widgetIdx) => {
          const refs = widgetKeyRefs(widget)
          for (const ref of refs) {
            out.push({
              page: page.slug,
              sectionIdx,
              columnIdx,
              widgetIdx,
              blockType: widget.blockType,
              ...ref,
            })
          }
        })
      })
    })
  }
  return out
}

/**
 * Returns the set of unique image keys a template references. Used by
 * the install-route pre-flight check (we only need the set of keys to
 * compare against the manifest, not the per-location index).
 */
export function collectImageKeys(template: SiteTemplate): Set<string> {
  const keys = new Set<string>()
  for (const ref of extractImageKeys(template)) {
    keys.add(ref.key)
  }
  return keys
}

interface FieldRef {
  field: string
  key: string
  alt: string
}

function widgetKeyRefs(widget: WidgetSpec): FieldRef[] {
  if (!widget._imageKeys) return []
  const keys = widget._imageKeys
  const alts = widget._imageAlts ?? {}
  const out: FieldRef[] = []
  for (const [field, key] of Object.entries(keys)) {
    out.push({ field, key, alt: alts[field] ?? '' })
  }
  return out
}
