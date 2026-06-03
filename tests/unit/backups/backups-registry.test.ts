import { describe, it, expect } from 'vitest'
import { registry } from '@/lib/cms/settings-registry'
import { encryptSecret } from '@/lib/security/secretCipher'

const backups = registry.backups.schema
const backupsState = registry.backups_state.schema

describe('settings-registry: backups', () => {
  it('accepts the registered default (local, no schedule, nothing connected)', () => {
    const parsed = backups.parse(registry.backups.default)
    expect(parsed.destination).toBe('local')
    expect(parsed.keepLocalCopy).toBe(true)
    expect(parsed.remoteRetention).toBe(7)
    expect(parsed.schedule).toBe('off')
    expect(parsed.gdrive.connected).toBe(false)
    expect(parsed.onedrive.connected).toBe(false)
    expect(parsed.encryption.passphraseEnabled).toBe(false)
  })

  it('accepts a connected gdrive block with an encrypted refresh token', () => {
    const refreshToken = encryptSecret('1//fake-refresh-token')
    const parsed = backups.parse({
      ...registry.backups.default,
      destination: 'gdrive',
      gdrive: {
        connected: true,
        accountEmail: 'owner@example.com',
        folderId: 'folder123',
        refreshToken,
        clientFingerprint: 'abc123',
      },
    })
    expect(parsed.gdrive.connected).toBe(true)
    expect(parsed.gdrive.refreshToken).toMatchObject({ v: 1, alg: 'aes-256-gcm' })
  })

  it('rejects an out-of-range remoteRetention', () => {
    const result = backups.safeParse({ ...registry.backups.default, remoteRetention: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown destination', () => {
    const result = backups.safeParse({ ...registry.backups.default, destination: 's3' })
    expect(result.success).toBe(false)
  })
})

describe('settings-registry: backups_state', () => {
  it('accepts the empty default', () => {
    expect(backupsState.parse(registry.backups_state.default)).toEqual({})
  })

  it('accepts a pending gdrive connect block', () => {
    const deviceCode = encryptSecret('device-code-xyz')
    const parsed = backupsState.parse({
      gdrivePending: {
        deviceCode,
        userCode: 'WDJB-MJHT',
        verificationUrl: 'https://www.google.com/device',
        expiresAt: '2026-06-01T00:10:00Z',
        intervalSec: 5,
      },
    })
    expect(parsed.gdrivePending?.userCode).toBe('WDJB-MJHT')
  })
})
