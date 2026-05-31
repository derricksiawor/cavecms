import { describe, it, expect, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ensureAllowedStatusPath, getInstallStateDir } from '@/lib/backups/statusPath'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('statusPath allowlist', () => {
  it('allows a file under CAVECMS_STATE_DIR', () => {
    vi.stubEnv('CAVECMS_STATE_DIR', '/var/lib/cavecms-x/.cavecms-state')
    const p = '/var/lib/cavecms-x/.cavecms-state/backup-status.json'
    expect(ensureAllowedStatusPath(p)).toBe(resolve(p))
  })
  it('allows the system /var/lib/cavecms prefix', () => {
    expect(ensureAllowedStatusPath('/var/lib/cavecms/restore-status.json')).toBe(
      '/var/lib/cavecms/restore-status.json',
    )
  })
  it('allows tmp in dev', () => {
    vi.stubEnv('NODE_ENV', 'test')
    const p = resolve(tmpdir(), 'cavecms', 'backup-status.json')
    expect(ensureAllowedStatusPath(p)).toBe(p)
  })
  it('refuses an arbitrary path in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CAVECMS_STATE_DIR', '')
    expect(() => ensureAllowedStatusPath('/etc/cron.d/evil')).toThrow(/not allowed/)
  })
  it('getInstallStateDir prefers CAVECMS_STATE_DIR', () => {
    vi.stubEnv('CAVECMS_STATE_DIR', '/srv/site/.cavecms-state')
    expect(getInstallStateDir()).toBe('/srv/site/.cavecms-state')
  })
})
