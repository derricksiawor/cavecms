import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { computeLockState, recordFailure, recordSuccess } from '@/lib/auth/lockout'

// Pool lifecycle is owned by tests/integration/_teardown.ts globalSetup —
// singleFork:true shares one pool across files, and a per-file pool.end()
// kills sibling tests in alphabetical race order.

describe('lockout (windowed)', () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE login_attempts`)
    await db.execute(sql`TRUNCATE TABLE failed_logins_by_email`)
    await db.execute(sql`TRUNCATE TABLE failed_logins_by_ip`)
  })

  it('locks after 3 failures in 10 min for email', async () => {
    for (let i = 0; i < 3; i++) {
      await recordFailure({ email: 'a@b.com', ip: '1.1.1.1', userAgent: 'ua', reason: 'bad_credentials' })
    }
    const s = await computeLockState({ email: 'a@b.com', ip: '1.1.1.1' })
    expect(s.locked).toBe(true)
  })

  it('successful login clears the EMAIL lock and resets failure history (cannot be re-locked by 1 more bad attempt)', async () => {
    // Drive to email lock from a different IP so we can isolate email-side semantics.
    for (let i = 0; i < 3; i++) {
      await recordFailure({ email: 'a@b.com', ip: '2.2.2.2', userAgent: 'ua', reason: 'bad_credentials' })
    }
    expect((await computeLockState({ email: 'a@b.com', ip: '2.2.2.2' })).locked).toBe(true)

    // Seed a throwaway user so user_known_ips FK is satisfied.
    await db.execute(sql`
      INSERT INTO users (email, password_hash, role, active, must_rotate_password)
      VALUES ('a@b.com', 'placeholder', 'admin', true, true)
      ON DUPLICATE KEY UPDATE email = email
    `)
    const [rows] = await db.execute(sql`SELECT id FROM users WHERE email = 'a@b.com' LIMIT 1`)
    const userId = Number((rows as unknown as Array<{ id: number }>)[0]?.id ?? 0)

    // Successful login from a fresh IP — email lock should clear; IP '2.2.2.2'
    // is unrelated and irrelevant here because we query by '3.3.3.3' below.
    await recordSuccess({ email: 'a@b.com', ip: '3.3.3.3', userId, userAgent: 'ua' })

    // Email-side lock is gone, AND a single follow-up failure must NOT re-lock
    // the victim — the reset_at marker excludes prior failures from the count.
    await recordFailure({ email: 'a@b.com', ip: '3.3.3.3', userAgent: 'ua', reason: 'bad_credentials' })
    const post = await computeLockState({ email: 'a@b.com', ip: '3.3.3.3' })
    expect(post.locked).toBe(false)

    await db.execute(sql`DELETE FROM users WHERE email = 'a@b.com'`)
  })

  it('reset_at filter holds when failures share IP with the post-success failure (regression: OR-branch bypass)', async () => {
    // 2 failures from the SAME IP that the user normally uses.
    for (let i = 0; i < 2; i++) {
      await recordFailure({ email: 'b@b.com', ip: '5.5.5.5', userAgent: 'ua', reason: 'bad_credentials' })
    }
    await db.execute(sql`
      INSERT INTO users (email, password_hash, role, active, must_rotate_password)
      VALUES ('b@b.com', 'placeholder', 'admin', true, false)
      ON DUPLICATE KEY UPDATE email = email
    `)
    const [rows] = await db.execute(sql`SELECT id FROM users WHERE email = 'b@b.com' LIMIT 1`)
    const userId = Number((rows as unknown as Array<{ id: number }>)[0]?.id ?? 0)
    // Success from the SAME IP — sets reset_at marker.
    await recordSuccess({ email: 'b@b.com', ip: '5.5.5.5', userId, userAgent: 'ua' })
    // One more failure from the SAME IP. With the OR-bypass bug, the prior 2
    // failures would still count via the ip-side WHERE branch, inflating
    // post.eCounts[0] to 3. With the fix, only the 1 post-reset failure
    // counts toward the email aggregate.
    await recordFailure({ email: 'b@b.com', ip: '5.5.5.5', userAgent: 'ua', reason: 'bad_credentials' })
    const post = await computeLockState({ email: 'b@b.com', ip: '5.5.5.5' })
    // Email aggregate must be 1 (the post-reset failure only).
    // (post.locked may be true if the IP-side aggregate hits its tier — that
    // is the intended shared-NAT defense and unrelated to the reset_at fix.)
    expect(post.eCounts[0]).toBe(1)
    expect(post.eCounts[1]).toBe(1)
    expect(post.eCounts[2]).toBe(1)
    await db.execute(sql`DELETE FROM users WHERE email = 'b@b.com'`)
  })

  it('IP lockout SURVIVES a successful login from same IP (shared-NAT defense)', async () => {
    // Drive to IP lock with three different victim emails on the same IP.
    for (const e of ['v1@x.com', 'v2@x.com', 'v3@x.com']) {
      await recordFailure({ email: e, ip: '4.4.4.4', userAgent: 'ua', reason: 'bad_credentials' })
    }
    expect((await computeLockState({ email: 'v1@x.com', ip: '4.4.4.4' })).locked).toBe(true)

    // A legitimate fourth account succeeds from the same shared-NAT IP.
    await db.execute(sql`
      INSERT INTO users (email, password_hash, role, active, must_rotate_password)
      VALUES ('legit@x.com', 'placeholder', 'admin', true, false)
      ON DUPLICATE KEY UPDATE email = email
    `)
    const [rows] = await db.execute(sql`SELECT id FROM users WHERE email = 'legit@x.com' LIMIT 1`)
    const userId = Number((rows as unknown as Array<{ id: number }>)[0]?.id ?? 0)
    await recordSuccess({ email: 'legit@x.com', ip: '4.4.4.4', userId, userAgent: 'ua' })

    // The original 3 victims' IP-side lockout MUST still hold.
    expect((await computeLockState({ email: 'v1@x.com', ip: '4.4.4.4' })).locked).toBe(true)

    await db.execute(sql`DELETE FROM users WHERE email = 'legit@x.com'`)
  })
})
