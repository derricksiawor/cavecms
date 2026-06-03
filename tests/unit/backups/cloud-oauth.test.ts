import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
  fetchAccountEmail,
  PROVIDERS,
} from '../../../scripts/backup/cloud/oauth.mjs'

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('oauth.mjs: providers', () => {
  it('exposes gdrive + onedrive provider config', () => {
    expect(PROVIDERS.gdrive.deviceCodeUrl).toContain('oauth2.googleapis.com')
    expect(PROVIDERS.onedrive.deviceCodeUrl).toContain('login.microsoftonline.com')
    expect(PROVIDERS.gdrive.scope).toContain('drive.file')
    expect(PROVIDERS.onedrive.scope).toContain('Files.ReadWrite.AppFolder')
    expect(PROVIDERS.onedrive.scope).toContain('offline_access')
  })
})

describe('oauth.mjs: requestDeviceCode', () => {
  it('returns the normalized device-code payload for gdrive', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, {
        device_code: 'dev123',
        user_code: 'WDJB-MJHT',
        verification_url: 'https://www.google.com/device',
        expires_in: 1800,
        interval: 5,
      }),
    )
    const r = await requestDeviceCode({ provider: 'gdrive', clientId: 'cid' })
    expect(r).toEqual({
      deviceCode: 'dev123',
      userCode: 'WDJB-MJHT',
      verificationUrl: 'https://www.google.com/device',
      expiresIn: 1800,
      intervalSec: 5,
    })
  })

  it('reads verification_uri (Microsoft spelling) for onedrive', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, {
        device_code: 'dev456',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        interval: 5,
      }),
    )
    const r = await requestDeviceCode({ provider: 'onedrive', clientId: 'cid' })
    expect(r.verificationUrl).toBe('https://microsoft.com/devicelogin')
    expect(r.deviceCode).toBe('dev456')
  })
})

describe('oauth.mjs: pollDeviceToken', () => {
  it('maps authorization_pending to {status: pending}', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(400, { error: 'authorization_pending' }))
    const r = await pollDeviceToken({ provider: 'gdrive', clientId: 'cid', deviceCode: 'd' })
    expect(r.status).toBe('pending')
  })

  it('maps slow_down to {status: slow_down}', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(400, { error: 'slow_down' }))
    const r = await pollDeviceToken({ provider: 'gdrive', clientId: 'cid', deviceCode: 'd' })
    expect(r.status).toBe('slow_down')
  })

  it('maps a token grant to {status: success, refreshToken, accessToken}', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3599,
      }),
    )
    const r = await pollDeviceToken({ provider: 'gdrive', clientId: 'cid', deviceCode: 'd' })
    expect(r).toMatchObject({ status: 'success', accessToken: 'at', refreshToken: 'rt' })
  })

  it('maps access_denied to {status: denied}', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(400, { error: 'access_denied' }))
    const r = await pollDeviceToken({ provider: 'gdrive', clientId: 'cid', deviceCode: 'd' })
    expect(r.status).toBe('denied')
  })

  it('maps expired_token to {status: expired}', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(400, { error: 'expired_token' }))
    const r = await pollDeviceToken({ provider: 'gdrive', clientId: 'cid', deviceCode: 'd' })
    expect(r.status).toBe('expired')
  })
})

describe('oauth.mjs: refreshAccessToken', () => {
  it('returns a fresh access token and a rotated refresh token when present', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, { access_token: 'newAt', refresh_token: 'rotatedRt', expires_in: 3599 }),
    )
    const r = await refreshAccessToken({ provider: 'onedrive', clientId: 'cid', refreshToken: 'old' })
    expect(r.accessToken).toBe('newAt')
    expect(r.refreshToken).toBe('rotatedRt')
    expect(r.expiresInSec).toBe(3599)
  })

  it('keeps the old refresh token when the provider omits a new one (Google)', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(200, { access_token: 'newAt', expires_in: 3599 }))
    const r = await refreshAccessToken({ provider: 'gdrive', clientId: 'cid', refreshToken: 'keepme' })
    expect(r.accessToken).toBe('newAt')
    expect(r.refreshToken).toBe('keepme')
  })

  it('throws invalid_grant as a typed error on a revoked token', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(400, { error: 'invalid_grant' }))
    await expect(
      refreshAccessToken({ provider: 'gdrive', clientId: 'cid', refreshToken: 'revoked' }),
    ).rejects.toThrow('invalid_grant')
  })
})

describe('oauth.mjs: fetchAccountEmail', () => {
  it('reads the Google userinfo email', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(200, { email: 'g@example.com' }))
    const e = await fetchAccountEmail({ provider: 'gdrive', accessToken: 'at' })
    expect(e).toBe('g@example.com')
  })

  it('reads the Graph /me userPrincipalName for onedrive', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(200, { mail: null, userPrincipalName: 'o@example.com' }),
    )
    const e = await fetchAccountEmail({ provider: 'onedrive', accessToken: 'at' })
    expect(e).toBe('o@example.com')
  })
})
