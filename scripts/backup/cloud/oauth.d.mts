// Ambient type declarations for the zero-dep oauth.mjs (allowJs is off, so the
// .mjs itself is not type-checked; this is the single typed contract consumed
// by lib/backups/cloud/oauthClient.ts and the unit tests).

export type CloudProvider = 'gdrive' | 'onedrive'

export interface ProviderConfig {
  deviceCodeUrl: string
  tokenUrl: string
  revokeUrl: string | null
  userInfoUrl: string
  scope: string
  deviceGrant: string
}

export const PROVIDERS: Record<CloudProvider, ProviderConfig>

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  intervalSec: number
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'success'; accessToken: string; refreshToken: string | null; expiresInSec: number }

export interface RefreshResult {
  accessToken: string
  refreshToken: string
  expiresInSec: number
}

export function requestDeviceCode(a: { provider: CloudProvider; clientId: string }): Promise<DeviceCode>
export function pollDeviceToken(a: {
  provider: CloudProvider
  clientId: string
  deviceCode: string
}): Promise<PollResult>
export function refreshAccessToken(a: {
  provider: CloudProvider
  clientId: string
  refreshToken: string
}): Promise<RefreshResult>
export function fetchAccountEmail(a: {
  provider: CloudProvider
  accessToken: string
}): Promise<string | null>
export function revokeToken(a: { provider: CloudProvider; token: string }): Promise<void>
