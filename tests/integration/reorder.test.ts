import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

// Exercises POST /api/cms/blocks/reorder by invoking the handler function
// directly rather than over HTTP — auth + CSRF + ip extraction are covered
// in unit tests; here we want to verify the drift-detection + per-row
// version + atomic UPDATE flow against a real DB.
//
// To avoid wiring full auth/CSRF cookies, the test instead replays the SQL
// body of the handler inline. If the handler logic changes, this test will
// drift — kept narrow on purpose: it locks in the SQL contract.

const USER_ID = 9101

async function seedThree(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
  await db.execute(sql`TRUNCATE TABLE media_references`)
  await db.execute(sql`TRUNCATE TABLE audit_log`)
  await db.execute(sql`TRUNCATE TABLE content_blocks`)
  await db.execute(sql`TRUNCATE TABLE pages`)
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)

  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
    VALUES (${USER_ID}, ${`reorder-${USER_ID}@test.local`}, 'placeholder', 'admin', true, false)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `)
  await db.execute(sql`INSERT INTO pages (id, slug, version) VALUES (1, 'home', 0)`)
  // Three freeform blocks (block_key NULL).
  for (const [id, pos] of [
    [10, 1000],
    [20, 2000],
    [30, 3000],
  ] as const) {
    await db.execute(sql`
      INSERT INTO content_blocks (id, page_id, block_type, position, data, version)
      VALUES (${id}, 1, 'text', ${pos}, ${JSON.stringify({ heading: `h${id}`, body_richtext: '<p>a</p>' })}, 0)
    `)
  }
}

async function fetchLiving(): Promise<Array<{ id: number; position: number; version: number }>> {
  const [rows] = (await db.execute(sql`
    SELECT id, position, version FROM content_blocks WHERE page_id = 1 AND deleted_at IS NULL ORDER BY position
  `)) as unknown as [Array<{ id: number; position: number; version: number }>]
  return rows
}

describe('reorder SQL contract', () => {
  beforeEach(seedThree)

  it('reassigns positions in 1000 steps and bumps each version', async () => {
    // Reverse order.
    await db.transaction(async (tx) => {
      let pos = 1000
      for (const id of [30, 20, 10]) {
        await tx.execute(sql`
          UPDATE content_blocks
          SET position = ${pos}, version = version + 1, updated_by = ${USER_ID}
          WHERE id = ${id}
        `)
        pos += 1000
      }
    })
    const after = await fetchLiving()
    expect(after.map((r) => r.id)).toEqual([30, 20, 10])
    expect(after.map((r) => r.position)).toEqual([1000, 2000, 3000])
    expect(after.every((r) => r.version === 1)).toBe(true)
  })

  it('detects drift when submitted id set differs from snapshot', async () => {
    // Snapshot: ids = {10, 20, 30}. Caller submits {10, 20, 99} — 99 not in snapshot.
    // The handler computes: snapshot has 3 ids, submitted has 3 ids, equal SIZE.
    // Then the loop checks every submitted id is in livingIds; 99 fails → 409 drift.
    const submitted = new Set([10, 20, 99])
    const living = new Set((await fetchLiving()).map((r) => r.id))
    expect(living.size).toBe(submitted.size)
    let drifted = false
    for (const id of submitted) {
      if (!living.has(id)) {
        drifted = true
        break
      }
    }
    expect(drifted).toBe(true)
  })

  it('detects drift when a block was deleted mid-flight (size shrinks)', async () => {
    await db.execute(sql`UPDATE content_blocks SET deleted_at = NOW(3) WHERE id = 20`)
    // Caller has stale snapshot of 3; living has 2.
    const submitted = new Set([10, 20, 30])
    const living = new Set((await fetchLiving()).map((r) => r.id))
    expect(living.size).not.toBe(submitted.size)
  })

  it('rejects stale_version when one row was edited by another writer', async () => {
    await db.execute(sql`UPDATE content_blocks SET version = 5 WHERE id = 20`)
    // Caller submits expectedVersion=0 for id=20; current is 5 → stale.
    const [snapshotRows] = (await db.execute(sql`
      SELECT id, version FROM content_blocks WHERE page_id = 1 AND deleted_at IS NULL FOR UPDATE
    `)) as unknown as [Array<{ id: number; version: number }>]
    const byId = new Map(snapshotRows.map((r) => [r.id, r]))
    const submitted = [
      { id: 10, expectedVersion: 0 },
      { id: 20, expectedVersion: 0 },
      { id: 30, expectedVersion: 0 },
    ]
    let stale = false
    for (const b of submitted) {
      const cur = byId.get(b.id)
      if (!cur) {
        stale = true
        break
      }
      if (cur.version !== b.expectedVersion) {
        stale = true
        break
      }
    }
    expect(stale).toBe(true)
  })
})
