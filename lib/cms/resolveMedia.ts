import 'server-only'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

// Resolve a media row's variant URLs from its `media_id`. Used by
// server components that pull a media reference out of the settings
// registry (header logo, footer logo, social-share fallback, etc.)
// and need to emit an <img src>.
//
// Two layers of cache:
//   1. unstable_cache (cross-request, 60s TTL, `media` tag) — same
//      logo id served by SiteHeader + SiteFooter across many public
//      renders collapses to a single SELECT per minute. The `media`
//      tag is busted by the media PATCH/DELETE routes so an admin
//      who renames or replaces an asset sees the change immediately.
//   2. React `cache()` (per-request) — when the same id is referenced
//      by both SiteHeader and SiteFooter within one render, the
//      lookup is deduped to a single call.
//
// Falls back to `null` for:
//   - missing rows (deleted out from under the referent)
//   - rows still being processed (variants column null)
//   - rows whose variants JSON fails to parse or isn't a plain object
//
// All failure paths log a structured error so a corrupted variants
// column gets flagged in production logs.

interface Row {
  id: number
  alt_text: string
  variants: unknown
}

export interface ResolvedMedia {
  id: number
  alt: string
  thumb: string | null
  md: string | null
  lg: string | null
  og: string | null
}

interface ImageVariants {
  thumb?: string
  md?: string
  lg?: string
  og?: string
}

async function readMediaRow(id: number): Promise<ResolvedMedia | null> {
  // Filter `deleted_at IS NULL` in SQL — every other deleted_at
  // consumer in this codebase does the same. Avoids the trap where a
  // future `dateStrings: true` mysql2 option flips zero-dates from
  // null to a truthy string.
  let rows: Row[]
  try {
    const [r] = (await db.execute(
      sql`SELECT id, alt_text, variants
          FROM media
          WHERE id = ${id}
            AND deleted_at IS NULL
          LIMIT 1`,
    )) as unknown as [Row[]]
    rows = r
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'resolve_media_query_failed',
        media_id: id,
        err_name: err instanceof Error ? err.name : 'unknown',
      }),
    )
    return null
  }

  const row = rows[0]
  if (!row) return null

  let variants: ImageVariants | null = null
  let raw: unknown = row.variants
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'resolve_media_variants_parse_failed',
          media_id: id,
          err_message:
            err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }),
      )
      raw = null
    }
  }
  // The variants column is `{ thumb, md, lg, og }` for images and
  // `{ pdf: '/api/brochure/by-uuid/…' }` for PDFs. Anything that
  // isn't a plain object (number, string, array, null) means a
  // row that hasn't finished post-upload processing OR data we
  // don't know how to read — log + degrade.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    variants = raw as ImageVariants
  } else if (raw !== null) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'resolve_media_variants_invalid_shape',
        media_id: id,
      }),
    )
  }

  return {
    id: row.id,
    alt: row.alt_text ?? '',
    thumb: variants?.thumb ?? null,
    md: variants?.md ?? null,
    lg: variants?.lg ?? null,
    og: variants?.og ?? null,
  }
}

// Cross-request cache keyed by media id. The `media` tag is busted
// on media UPDATE/DELETE so admins see edits immediately.
const cachedReadMediaRow = unstable_cache(
  (id: number) => readMediaRow(id),
  ['resolveMedia', 'v1'],
  { tags: ['media'], revalidate: 60 },
)

// Per-request dedupe via React's `cache()`. SiteHeader + SiteFooter
// asking for the same logo id collapse into one call.
export const resolveMedia = cache(
  async (id: number | null | undefined): Promise<ResolvedMedia | null> => {
    if (id == null) return null
    return cachedReadMediaRow(id)
  },
)
