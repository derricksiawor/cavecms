import 'server-only'
import { cache } from 'react'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { HydratedProjectRow } from './hydrate'

// Request-scoped cached read of the projects row. React's `cache()`
// dedupes calls within a single render request so that Next.js's
// `generateMetadata` AND the page body's `hydrateProject` invocation
// don't both issue their own SELECT against the same row — two
// queries collapse to one per request.
//
// Returns the full HydratedProjectRow shape so consumers can pick
// whichever columns they need (metadata wants seo_*, page body
// wants the lot). Returns null when the project is missing or
// soft-deleted — published-gate filtering is the caller's
// responsibility (preview-token paths read unpublished rows).
//
// IMPORTANT: this is the SOURCE OF TRUTH for the project's existence
// + soft-delete state. Any new public route that needs the row
// should call this instead of issuing its own SELECT.

export const getProjectRow = cache(
  async (slug: string): Promise<HydratedProjectRow | null> => {
    const [rows] = (await db.execute(sql`
      SELECT id, slug, name, tagline, status, location,
             hero_image_id, brochure_pdf_id, og_image_id,
             preview_epoch, published, published_at,
             seo_title, seo_description, version
      FROM projects
      WHERE slug = ${slug} AND deleted_at IS NULL
    `)) as unknown as [HydratedProjectRow[]]
    return rows[0] ?? null
  },
)
