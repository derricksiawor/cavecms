import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { sweepExpiredProposals } from '@/lib/ai/sweeper'

// Integration test: exercises sweepExpiredProposals() against a real
// MariaDB. The function is the unit-of-work behind the 5-min interval
// registered in instrumentation.ts; verifying it here means the
// interval itself (just a setInterval wrapper) is trivial enough to
// audit by eye in lib/ai/sweeper.ts.

const USER_ID = 9301
const PAGE_ID = 9301

interface ProposalRow {
  token: string
  status: string
}

async function seedUserAndPage(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
    VALUES (${USER_ID}, ${`sweeper-${USER_ID}@test.local`}, 'placeholder', 'admin', true, false)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `)
  await db.execute(sql`
    INSERT INTO pages (id, slug, title, version)
    VALUES (${PAGE_ID}, ${`sweeper-${PAGE_ID}`}, 'Sweeper test', 0)
    ON DUPLICATE KEY UPDATE slug = VALUES(slug)
  `)
}

async function insertProposal(opts: {
  token: string
  status: 'pending' | 'accepted' | 'dismissed' | 'expired'
  // Relative offsets in seconds — negative = in the past.
  createdOffsetSec?: number
  expiresOffsetSec?: number
}): Promise<void> {
  const createdOff = opts.createdOffsetSec ?? 0
  const expiresOff = opts.expiresOffsetSec ?? 1800
  await db.execute(sql`
    INSERT INTO ai_proposals
      (token, user_id, page_id, surface, prompt, changeset, status, model, created_at, expires_at)
    VALUES
      (${opts.token}, ${USER_ID}, ${PAGE_ID}, 'inline', 'test',
       ${JSON.stringify([])}, ${opts.status}, 'gemini-2.5-flash',
       NOW(3) + INTERVAL ${sql.raw(String(createdOff))} SECOND,
       NOW(3) + INTERVAL ${sql.raw(String(expiresOff))} SECOND)
  `)
}

async function fetchAll(): Promise<ProposalRow[]> {
  const [rows] = (await db.execute(sql`
    SELECT token, status FROM ai_proposals
    WHERE user_id = ${USER_ID}
    ORDER BY token
  `)) as unknown as [ProposalRow[]]
  return rows
}

describe('sweepExpiredProposals', () => {
  beforeEach(async () => {
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
    await db.execute(sql`DELETE FROM ai_proposals WHERE user_id = ${USER_ID}`)
    await db.execute(sql`DELETE FROM pages WHERE id = ${PAGE_ID}`)
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`)
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
    await seedUserAndPage()
  })

  it('flips pending rows past expires_at to expired', async () => {
    await insertProposal({
      token: 'stale-pending-1',
      status: 'pending',
      expiresOffsetSec: -3600, // 1h in the past
    })
    await insertProposal({
      token: 'fresh-pending-1',
      status: 'pending',
      expiresOffsetSec: 600, // 10m in the future
    })

    const result = await sweepExpiredProposals()

    expect(result.expired).toBe(1)
    expect(result.hardDeleted).toBe(0)

    const rows = await fetchAll()
    const byToken = Object.fromEntries(rows.map((r) => [r.token, r.status]))
    expect(byToken['stale-pending-1']).toBe('expired')
    expect(byToken['fresh-pending-1']).toBe('pending')
  })

  it('hard-deletes terminal-status rows older than 7 days', async () => {
    // The DELETE drives off expires_at < NOW - 7d so the
    // idx_ai_proposals_expires index serves the scan. Real rows
    // always carry expires_at = created_at + 30min, so the offsets
    // mirror that invariant — old rows get an old expires_at.
    await insertProposal({
      token: 'old-accepted',
      status: 'accepted',
      createdOffsetSec: -8 * 86400,
      expiresOffsetSec: -8 * 86400 + 1800, // 30-min after old created_at
    })
    await insertProposal({
      token: 'old-dismissed',
      status: 'dismissed',
      createdOffsetSec: -10 * 86400,
      expiresOffsetSec: -10 * 86400 + 1800,
    })
    await insertProposal({
      token: 'old-expired',
      status: 'expired',
      createdOffsetSec: -9 * 86400,
      expiresOffsetSec: -9 * 86400 + 1800,
    })
    await insertProposal({
      token: 'recent-accepted',
      status: 'accepted',
      createdOffsetSec: -3 * 86400, // inside the 7-day window
      expiresOffsetSec: -3 * 86400 + 1800,
    })
    await insertProposal({
      token: 'old-pending', // pending, but older — should NOT be deleted (status guard)
      status: 'pending',
      createdOffsetSec: -10 * 86400,
      expiresOffsetSec: 600, // not-yet-expired
    })

    const result = await sweepExpiredProposals()

    // Three terminal-status rows past 7d should be deleted. The
    // old-pending row is NOT in the terminal-status set (its
    // expires_at is fresh, so step 1 doesn't touch it either).
    expect(result.hardDeleted).toBe(3)

    const tokens = new Set((await fetchAll()).map((r) => r.token))
    expect(tokens.has('old-accepted')).toBe(false)
    expect(tokens.has('old-dismissed')).toBe(false)
    expect(tokens.has('old-expired')).toBe(false)
    expect(tokens.has('recent-accepted')).toBe(true)
    expect(tokens.has('old-pending')).toBe(true)
  })

  it('reports zero work when the table is clean', async () => {
    const result = await sweepExpiredProposals()
    expect(result.expired).toBe(0)
    expect(result.hardDeleted).toBe(0)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('handles concurrent expire-and-delete in one tick', async () => {
    // Mix of work for both steps simultaneously.
    await insertProposal({
      token: 'mix-stale-pending',
      status: 'pending',
      expiresOffsetSec: -60,
    })
    await insertProposal({
      token: 'mix-old-accepted',
      status: 'accepted',
      createdOffsetSec: -8 * 86400,
      expiresOffsetSec: -8 * 86400 + 1800,
    })

    const result = await sweepExpiredProposals()
    expect(result.expired).toBe(1)
    expect(result.hardDeleted).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('reports truncated=false on a normal partial-batch tick', async () => {
    // Insert a handful — fewer than BATCH_LIMIT — to confirm the
    // happy path leaves truncated=false. Catches a future change
    // that accidentally flips the flag on every run.
    for (let i = 0; i < 5; i += 1) {
      await insertProposal({
        token: `partial-pending-${i}`,
        status: 'pending',
        expiresOffsetSec: -60,
      })
    }
    const result = await sweepExpiredProposals()
    expect(result.expired).toBe(5)
    expect(result.truncated).toBe(false)
  })
})
