import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'

// Advisory per-page edit lock (migration 0045). One operator holds the
// inline editor for a page at a time; everyone else entering edit mode is
// offered a takeover, WordPress/Elementor style. The lock is two columns on
// `pages` (edit_lock_user_id + edit_lock_heartbeat_at) claimed with a single
// conditional UPDATE — free, stale, or already-mine all acquire atomically,
// so two racing acquires can't both win.
//
// Advisory means UI-level: the block-write APIs never check the lock, so
// API-token and agent editing keeps working headlessly, and a crashed
// browser can never brick a page — the heartbeat just goes stale and the
// next editor claims the lock without a prompt.

// A lock whose heartbeat is older than this is stale and silently claimable.
// The client renews every EDIT_LOCK_HEARTBEAT_MS (5s), so a live editor is
// six missed beats away from losing the lock — enough slack for a laggy
// connection, short enough that a closed laptop frees the page in half a
// minute.
export const EDIT_LOCK_TTL_SECONDS = 30
export const EDIT_LOCK_HEARTBEAT_MS = 5_000

export interface EditLockHolder {
  userId: number
  name: string
}

export type EditLockResult =
  | { locked: true }
  | { locked: false; holder: EditLockHolder | null }

// db.execute's UPDATE result shape varies by driver version — either the
// ResultSetHeader directly or a [header, fields] tuple (same defensive read
// as saveBlock's version-bump check).
function affectedRows(raw: unknown): number {
  if (Array.isArray(raw)) {
    const head = raw[0]
    if (head && typeof head === 'object' && 'affectedRows' in head) {
      return (head as { affectedRows: number }).affectedRows
    }
    return 0
  }
  if (raw && typeof raw === 'object' && 'affectedRows' in raw) {
    return (raw as { affectedRows: number }).affectedRows
  }
  return 0
}

async function readHolder(pageId: number): Promise<EditLockHolder | null> {
  const [rows] = (await db.execute(sql`
    SELECT p.edit_lock_user_id AS userId,
           COALESCE(NULLIF(u.name, ''), u.email) AS name
    FROM pages p
    LEFT JOIN users u ON u.id = p.edit_lock_user_id
    WHERE p.id = ${pageId} AND p.deleted_at IS NULL
      AND p.edit_lock_user_id IS NOT NULL
      AND p.edit_lock_heartbeat_at >= NOW(3) - INTERVAL ${sql.raw(String(EDIT_LOCK_TTL_SECONDS))} SECOND
  `)) as unknown as [Array<{ userId: number; name: string | null }>]
  const r = rows[0]
  if (!r) return null
  return { userId: r.userId, name: r.name ?? 'Another editor' }
}

// Acquire the lock (or renew it — acquire and heartbeat are the same
// conditional write). Wins when the lock is free, stale, or already ours.
export async function acquireEditLock(
  pageId: number,
  userId: number,
): Promise<EditLockResult> {
  const res = await db.execute(sql`
    UPDATE pages
    SET edit_lock_user_id = ${userId}, edit_lock_heartbeat_at = NOW(3)
    WHERE id = ${pageId} AND deleted_at IS NULL
      AND (
        edit_lock_user_id IS NULL
        OR edit_lock_user_id = ${userId}
        OR edit_lock_heartbeat_at < NOW(3) - INTERVAL ${sql.raw(String(EDIT_LOCK_TTL_SECONDS))} SECOND
      )
  `)
  if (affectedRows(res) > 0) return { locked: true }
  // affectedRows counts CHANGED rows — two heartbeats landing in the same
  // millisecond leave the second write a no-op (identical values, 0 changed).
  // A "conflict" whose holder is the caller is that no-op, not a real block.
  const holder = await readHolder(pageId)
  if (holder && holder.userId === userId) return { locked: true }
  return { locked: false, holder }
}

// Forcibly reassign the lock to the caller. The previous holder's next
// heartbeat comes back { locked: false } and their editor surfaces the
// "taken over" notice. Audited — a takeover is a deliberate, attributable
// act between operators.
export async function takeoverEditLock(
  pageId: number,
  userId: number,
  reqMeta: { ip: string | null; userAgent: string | null; requestId: string | null },
): Promise<EditLockResult> {
  const previous = await readHolder(pageId)
  const res = await db.execute(sql`
    UPDATE pages
    SET edit_lock_user_id = ${userId}, edit_lock_heartbeat_at = NOW(3)
    WHERE id = ${pageId} AND deleted_at IS NULL
  `)
  if (affectedRows(res) === 0) return { locked: false, holder: null }
  if (previous && previous.userId !== userId) {
    await db.insert(auditLog).values({
      userId,
      tokenId: null,
      action: 'update',
      resourceType: 'page',
      resourceId: String(pageId),
      diff: {
        kind: 'edit_lock_takeover',
        from_user_id: previous.userId,
      } as unknown as object,
      ip: reqMeta.ip,
      userAgent: reqMeta.userAgent,
      requestId: reqMeta.requestId,
    })
  }
  return { locked: true }
}

// Release the lock, but only if the caller still holds it — a release
// racing a takeover must never clear the new holder's lock.
export async function releaseEditLock(
  pageId: number,
  userId: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE pages
    SET edit_lock_user_id = NULL, edit_lock_heartbeat_at = NULL
    WHERE id = ${pageId} AND edit_lock_user_id = ${userId}
  `)
}
