import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

const TEST_USER_ID = 9701

vi.mock('@/lib/auth/requireRole', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/requireRole')>(
    '@/lib/auth/requireRole',
  )
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      userId: TEST_USER_ID,
      role: 'admin',
      email: 'apply-test@local',
      jti: 'jti-apply',
      oat: 0,
      iat: 0,
      pwp: false,
    })),
  }
})

vi.mock('@/lib/auth/requireCsrf', () => ({
  requireCsrf: vi.fn(async () => undefined),
}))

vi.mock('@/lib/auth/cmsRateLimit', () => ({
  checkMutationRate: vi.fn(() => undefined),
  checkReadRate: vi.fn(() => undefined),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}))

// Mock child_process.spawn so the route doesn't actually fork the
// orchestrator. We capture the call args to assert the apply route is
// wiring force/env/script-path correctly.
const spawnMock = vi.fn(() => ({
  pid: 99999,
  unref: vi.fn(),
  on: vi.fn(),
  stdout: null,
  stderr: null,
  stdin: null,
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  )
  return { ...actual, spawn: spawnMock }
})

import { __setStatusPathForTests, readStatus } from '@/lib/updates/statusFile'

let tmpDir: string
let statusPath: string
const ORIG_COMMIT = process.env.CAVECMS_COMMIT
const ORIG_LOG_DIR = process.env.CAVECMS_LOG_DIR

async function seedAdmin() {
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
    VALUES (${TEST_USER_ID}, ${`apply-test-${TEST_USER_ID}@local`}, 'placeholder', 'admin', true, false)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `)
}

async function clearUpdateAuditRows() {
  await db.execute(sql`DELETE FROM audit_log WHERE resource_type = 'updates'`)
}

async function latestUpdateAuditRow(): Promise<{
  action: string
  resource_id: string
  diff: unknown
} | null> {
  const [rows] = (await db.execute(sql`
    SELECT action, resource_id, diff
    FROM audit_log
    WHERE resource_type = 'updates'
    ORDER BY id DESC
    LIMIT 1
  `)) as unknown as [
    Array<{ action: string; resource_id: string; diff: unknown }>,
  ]
  return rows[0] ?? null
}

describe('POST /api/admin/updates/apply (integration)', () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cavecms-apply-'))
    statusPath = join(tmpDir, 'update-status.json')
    __setStatusPathForTests(statusPath)
    process.env.CAVECMS_COMMIT = 'abcdef1'
    process.env.CAVECMS_LOG_DIR = tmpDir
    spawnMock.mockClear()
    await seedAdmin()
    await clearUpdateAuditRows()
  })
  afterEach(async () => {
    __setStatusPathForTests(null)
    process.env.CAVECMS_COMMIT = ORIG_COMMIT
    if (ORIG_LOG_DIR === undefined) delete process.env.CAVECMS_LOG_DIR
    else process.env.CAVECMS_LOG_DIR = ORIG_LOG_DIR
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    await clearUpdateAuditRows()
    vi.clearAllMocks()
  })

  it('returns 202 + seeds status + spawns + records apply audit row', async () => {
    const { POST } = await import('@/app/api/admin/updates/apply/route')
    const req = new Request('http://127.0.0.1:3040/api/admin/updates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetSha: '9999999999999999',
        downloadUrl: 'https://updates.cavecms.com/releases/cavecms-9999.zip',
        sha256: 'a'.repeat(64),
      }),
    })
    const res = await POST(req, {})

    expect(res.status).toBe(202)
    const body = (await res.json()) as {
      accepted: boolean
      fromSha: string
      toSha: string
    }
    expect(body.accepted).toBe(true)
    expect(body.fromSha).toBe('abcdef1')
    expect(body.toSha).toBe('9999999999999999')

    // Status file was seeded with the preflight phase.
    expect(existsSync(statusPath)).toBe(true)
    const status = readStatus()
    expect(status?.state).toBe('preflight')
    expect(status?.toSha).toBe('9999999999999999')

    // Spawn called with the orchestrator script + target SHA. The
    // double-fork orphan pattern routes through `/bin/bash -c '...'`
    // with the script path + target embedded in the command string,
    // so assertions match the shell-quoted command rather than
    // positional argv slots.
    expect(spawnMock).toHaveBeenCalledOnce()
    const firstCall = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ]
    expect(firstCall[0]).toBe('/bin/bash')
    expect(firstCall[1][0]).toBe('-c')
    expect(firstCall[1][1]).toMatch(/scripts\/cavecms-update\.sh/)
    expect(firstCall[1][1]).toContain('9999999999999999')
    expect(firstCall[1][1]).toContain('nohup')
    expect(firstCall[1][1]).toContain('disown')

    // Audit row landed with action=apply + diff.fromSha/toSha.
    const audit = await latestUpdateAuditRow()
    expect(audit?.action).toBe('apply')
    const diff = (
      typeof audit?.diff === 'string'
        ? JSON.parse(audit.diff)
        : (audit?.diff as Record<string, unknown>) ?? {}
    ) as { fromSha?: string; toSha?: string; force?: boolean }
    expect(diff.fromSha).toBe('abcdef1')
    expect(diff.toSha).toBe('9999999999999999')
    expect(diff.force).toBeUndefined()
  })

  it('refuses same-SHA targets without force with 409 already_on_target_version', async () => {
    const { POST } = await import('@/app/api/admin/updates/apply/route')
    const req = new Request('http://127.0.0.1:3040/api/admin/updates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetSha: 'abcdef1',
        downloadUrl: 'https://updates.cavecms.com/releases/cavecms-abcdef1.zip',
        sha256: 'b'.repeat(64),
      }),
    })
    const res = await POST(req, {})
    expect(res.status).toBe(409)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('allows same-SHA WITH force=true + records force_apply audit row', async () => {
    const { POST } = await import('@/app/api/admin/updates/apply/route')
    const req = new Request('http://127.0.0.1:3040/api/admin/updates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetSha: 'abcdef1',
        force: true,
        downloadUrl: 'https://updates.cavecms.com/releases/cavecms-abcdef1.zip',
        sha256: 'c'.repeat(64),
      }),
    })
    const res = await POST(req, {})
    expect(res.status).toBe(202)
    expect(spawnMock).toHaveBeenCalledOnce()

    // Spawn env got CAVECMS_UPDATE_FORCE=1. The orchestrator picks it
    // up via `if [ "${CAVECMS_UPDATE_FORCE:-0}" = "1" ]` at startup
    // (env propagates through the nohup grandchild).
    const forceCall = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env?: Record<string, string> },
    ]
    const env = forceCall[2]?.env ?? {}
    expect(env.CAVECMS_UPDATE_FORCE).toBe('1')

    // Audit row uses force_apply action + diff.force=true.
    const audit = await latestUpdateAuditRow()
    expect(audit?.action).toBe('force_apply')
    const diff = (
      typeof audit?.diff === 'string'
        ? JSON.parse(audit.diff)
        : (audit?.diff as Record<string, unknown>) ?? {}
    ) as { force?: boolean }
    expect(diff.force).toBe(true)
  })

  it('rejects invalid targetSha shape with 400 (Zod)', async () => {
    const { POST } = await import('@/app/api/admin/updates/apply/route')
    const req = new Request('http://127.0.0.1:3040/api/admin/updates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetSha: '!!nope!!',
        downloadUrl: 'https://updates.cavecms.com/releases/cavecms-bad.zip',
        sha256: 'd'.repeat(64),
      }),
    })
    const res = await POST(req, {})
    expect(res.status).toBe(400)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses to spawn when current is dev (cannot_apply_from_dev)', async () => {
    process.env.CAVECMS_COMMIT = ''
    const { POST } = await import('@/app/api/admin/updates/apply/route')
    const req = new Request('http://127.0.0.1:3040/api/admin/updates/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetSha: '9999999999999999',
        downloadUrl: 'https://updates.cavecms.com/releases/cavecms-9999.zip',
        sha256: 'a'.repeat(64),
      }),
    })
    const res = await POST(req, {})
    expect(res.status).toBe(409)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
