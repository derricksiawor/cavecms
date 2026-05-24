import 'server-only'
import { sql } from 'drizzle-orm'
import { type Tx } from '@/db/client'
import { HttpError } from '@/lib/auth/requireRole'

/**
 * Asserts every media_id in `ids` points at a media row that is NOT
 * soft-deleted. Closes the race between DELETE /api/cms/media/[id]
 * (which only locks current refs at the moment of delete) and a
 * concurrent saveBlock / POST / restore that adds a NEW reference to
 * the soon-to-be-deleted media row.
 *
 * Uses FOR SHARE so concurrent reads of the media row stay possible
 * but a parallel DELETE (which takes FOR UPDATE on the media row) is
 * blocked until this save commits — either the media stays alive and
 * our ref lands, or DELETE wins first and our SELECT here sees
 * deleted_at IS NOT NULL and we 409.
 *
 * Throws HttpError(404, 'media_missing') when any id is unknown or
 * soft-deleted. The caller's TX rolls back; the new media_references
 * INSERTs that would have referenced the dead row don't land.
 */
export async function assertMediaAvailable(
  tx: Tx,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return
  // MariaDB syntax: LOCK IN SHARE MODE. MySQL 8+ accepts FOR SHARE; the
  // older verb is the portable form and works on both.
  const [rows] = (await tx.execute(sql`
    SELECT id FROM media
    WHERE id IN (${sql.join(ids, sql.raw(','))})
      AND deleted_at IS NULL
    LOCK IN SHARE MODE
  `)) as unknown as [Array<{ id: number }>]
  if (rows.length !== ids.length) {
    throw new HttpError(404, 'media_missing')
  }
}
