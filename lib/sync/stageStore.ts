import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, type Tx } from '@/db/client'
import type { StagedPayload } from './applyBundle'

// Accepts either the pool (`db`) or an open transaction so the stage row can
// commit atomically with the media rows it references.
type Executor = typeof db | Tx

// One staged push, awaiting cutover. Persisted in sync_stage (migration 0027).
export interface StageRecord {
  id: string
  payload: StagedPayload
  contentHash: string
  // The bundle's pull-time drift baseline (null = no baseline → cutover needs force).
  baselineContentHash: string | null
}

const TTL_MS = 60 * 60 * 1000 // 1h

// Max serialized payload size — guards against a near-200MB bundle whose
// resolved content payload would blow MySQL's max_allowed_packet on INSERT.
// 48MB stays under the common 64MB default with headroom for the row framing.
const MAX_PAYLOAD_BYTES = 48 * 1024 * 1024

export class PayloadTooLargeError extends Error {
  constructor(public bytes: number) {
    super(`staged payload ${bytes} bytes exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`)
    this.name = 'PayloadTooLargeError'
  }
}

// Persist a validated, media-resolved payload; returns the stageId. Pass the
// open transaction as `exec` so the stage row commits atomically with the media
// rows provisioned in the same unit of work.
export async function putStage(
  payload: StagedPayload,
  contentHash: string,
  baselineContentHash: string | null,
  userId: number,
  exec: Executor = db,
): Promise<string> {
  const json = JSON.stringify(payload)
  // Byte length, not UTF-16 code-unit length — multibyte content (CJK, emoji)
  // is ~3x bytes/char and could otherwise blow max_allowed_packet mid-INSERT.
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > MAX_PAYLOAD_BYTES) throw new PayloadTooLargeError(bytes)
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + TTL_MS)
  await exec.execute(sql`
    INSERT INTO sync_stage (id, payload, content_hash, baseline_content_hash, created_by, expires_at, created_at)
    VALUES (${id}, ${json}, ${contentHash}, ${baselineContentHash}, ${userId}, ${expiresAt}, NOW(3))
  `)
  return id
}

// Load a non-expired stage. Returns null if missing or expired.
export async function getStage(id: string): Promise<StageRecord | null> {
  const [rows] = (await db.execute(sql`
    SELECT id, payload, content_hash, baseline_content_hash FROM sync_stage
    WHERE id = ${id} AND expires_at > NOW(3)
  `)) as unknown as [
    Array<{ id: string; payload: unknown; content_hash: string; baseline_content_hash: string | null }>,
  ]
  const row = rows[0]
  if (!row) return null
  const payload =
    typeof row.payload === 'string'
      ? (JSON.parse(row.payload) as StagedPayload)
      : (row.payload as StagedPayload)
  return {
    id: row.id,
    payload,
    contentHash: row.content_hash,
    baselineContentHash: row.baseline_content_hash,
  }
}

export async function deleteStage(id: string): Promise<void> {
  await db.execute(sql`DELETE FROM sync_stage WHERE id = ${id}`)
}

// Sweep expired staging rows. Returns the count removed. (Media inserted by an
// abandoned stage is additive + orphaned — GC'd by the existing media purge,
// not here.)
export async function sweepExpiredStages(): Promise<number> {
  const [res] = (await db.execute(sql`
    DELETE FROM sync_stage WHERE expires_at <= NOW(3)
  `)) as unknown as [{ affectedRows: number }]
  return res.affectedRows ?? 0
}
