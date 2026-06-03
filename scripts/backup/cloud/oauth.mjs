// Zero-dependency OAuth device-authorization-grant wire protocol for the
// CaveCMS cloud backup destinations. Node builtins + global fetch only — no
// SDKs, importable by both the Next.js admin runtime (Phase 1 connect/poll)
// and the spawned zero-dep engine (Phase 2 mid-upload token refresh).
//
// client_id is ALWAYS passed in by the caller — never baked here. Security
// of the device-flow public client rests on per-user consent + the encrypted
// per-install refresh token, not on client confidentiality.

export const PROVIDERS = {
  gdrive: {
    deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    // openid + email so we can read the connected account's address; drive.file
    // is the least-privilege backup scope. All three are non-sensitive.
    scope: 'openid email https://www.googleapis.com/auth/drive.file',
    deviceGrant: 'urn:ietf:params:oauth:grant-type:device_code',
  },
  onedrive: {
    deviceCodeUrl:
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
    tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    revokeUrl: null, // Microsoft has no token-revoke endpoint; clearing local state suffices.
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    // User.Read so the /me lookup can read the connected account's email;
    // offline_access for the refresh token; AppFolder is the least-privilege
    // backup scope.
    scope: 'offline_access Files.ReadWrite.AppFolder User.Read',
    deviceGrant: 'urn:ietf:params:oauth:grant-type:device_code',
  },
}

function providerOrThrow(provider) {
  const p = PROVIDERS[provider]
  if (!p) throw new Error(`unknown_provider:${provider}`)
  return p
}

// 30s per-request timeout on every OAuth call so a hung token endpoint can't
// block an admin route handler (connect/poll) or the upload engine's mid-
// transfer refresh indefinitely.
const OAUTH_TIMEOUT_MS = 30_000

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  })
  let json = {}
  try {
    json = await res.json()
  } catch {
    json = {}
  }
  return { status: res.status, json }
}

export async function requestDeviceCode({ provider, clientId }) {
  const p = providerOrThrow(provider)
  const { status, json } = await postForm(p.deviceCodeUrl, {
    client_id: clientId,
    scope: p.scope,
  })
  if (status < 200 || status >= 300 || !json.device_code) {
    throw new Error(`device_code_failed:${status}:${json.error || 'unknown'}`)
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    // Google uses verification_url; Microsoft uses verification_uri.
    verificationUrl: json.verification_url || json.verification_uri,
    expiresIn: json.expires_in,
    intervalSec: json.interval || 5,
  }
}

export async function pollDeviceToken({ provider, clientId, clientSecret, deviceCode }) {
  const p = providerOrThrow(provider)
  // Google's device-flow token exchange REQUIRES the (non-confidential) client
  // secret; Microsoft is a true public client and must not send one.
  const form = {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: p.deviceGrant,
  }
  if (clientSecret) form.client_secret = clientSecret
  const { status, json } = await postForm(p.tokenUrl, form)
  if (status >= 200 && status < 300 && json.access_token) {
    return {
      status: 'success',
      accessToken: json.access_token,
      refreshToken: json.refresh_token || null,
      expiresInSec: json.expires_in || 3600,
    }
  }
  switch (json.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down' }
    case 'access_denied':
      return { status: 'denied' }
    case 'expired_token':
      return { status: 'expired' }
    default:
      throw new Error(`poll_failed:${status}:${json.error || 'unknown'}`)
  }
}

export async function refreshAccessToken({ provider, clientId, clientSecret, refreshToken }) {
  const p = providerOrThrow(provider)
  const form = {
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    // Microsoft requires the scope on refresh to keep offline_access.
    scope: p.scope,
  }
  // Google requires its (non-confidential) client secret on refresh too.
  if (clientSecret) form.client_secret = clientSecret
  const { status, json } = await postForm(p.tokenUrl, form)
  if (status < 200 || status >= 300 || !json.access_token) {
    throw new Error(`refresh_failed:${status}:${json.error || 'unknown'}`)
  }
  return {
    accessToken: json.access_token,
    // Microsoft rotates the refresh token on every refresh; Google usually
    // omits it (keep the existing one).
    refreshToken: json.refresh_token || refreshToken,
    expiresInSec: json.expires_in || 3600,
  }
}

export async function fetchAccountEmail({ provider, accessToken }) {
  const p = providerOrThrow(provider)
  const res = await fetch(p.userInfoUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  })
  let json = {}
  try {
    json = await res.json()
  } catch {
    json = {}
  }
  if (provider === 'gdrive') return json.email || null
  // Graph: personal accounts often have mail=null; fall back to UPN.
  return json.mail || json.userPrincipalName || null
}

export async function revokeToken({ provider, token }) {
  const p = providerOrThrow(provider)
  if (!p.revokeUrl) return // Microsoft: nothing to revoke server-side.
  try {
    await postForm(p.revokeUrl, { token })
  } catch {
    // Best-effort: local wipe is the real disconnect.
  }
}
