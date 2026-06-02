// Per-provider public OAuth client_id. The production value is the
// CaveCMS-published device-flow client (registered + published per design
// §15). A contributor running `pnpm dev` may override via env to test against
// a throwaway client without touching the baked constant. Customers never
// set these — they ship baked into the product.
//
// A non-confidential client_id is fine to embed: device-flow security rests
// on per-user consent + the encrypted per-install refresh token.

export type CloudProvider = 'gdrive' | 'onedrive'

// Filled with the real published client_ids once the OAuth apps are
// registered (design §15). Until then, dev uses the env override below.
const BAKED_CLIENT_IDS: Record<CloudProvider, string> = {
  gdrive: '',
  onedrive: '',
}

const ENV_OVERRIDE: Record<CloudProvider, string> = {
  gdrive: 'CAVECMS_GOOGLE_CLIENT_ID',
  onedrive: 'CAVECMS_MS_CLIENT_ID',
}

// Google "TVs and Limited Input devices" clients issue a non-confidential
// pseudo-secret that the device-flow token exchange REQUIRES. Microsoft is a
// true public client (no secret). Baked empty until the production app is
// registered; the contributor dev box supplies it via the env override.
const BAKED_CLIENT_SECRETS: Partial<Record<CloudProvider, string>> = {
  gdrive: '',
}
const SECRET_ENV_OVERRIDE: Partial<Record<CloudProvider, string>> = {
  gdrive: 'CAVECMS_GOOGLE_CLIENT_SECRET',
}

export function getClientId(provider: CloudProvider): string {
  const fromEnv = process.env[ENV_OVERRIDE[provider]]
  const id = (fromEnv && fromEnv.trim()) || BAKED_CLIENT_IDS[provider]
  if (!id) {
    throw new Error(`cloud_client_unconfigured:${provider}`)
  }
  return id
}

// The client secret for providers that need one (Google). Returns undefined for
// providers that are true public clients (Microsoft).
export function getClientSecret(provider: CloudProvider): string | undefined {
  const envName = SECRET_ENV_OVERRIDE[provider]
  const fromEnv = envName ? process.env[envName] : undefined
  const secret = (fromEnv && fromEnv.trim()) || BAKED_CLIENT_SECRETS[provider]
  return secret && secret.length > 0 ? secret : undefined
}

export function isProviderConfigured(provider: CloudProvider): boolean {
  const fromEnv = process.env[ENV_OVERRIDE[provider]]
  return Boolean((fromEnv && fromEnv.trim()) || BAKED_CLIENT_IDS[provider])
}

// A short stable fingerprint of the active client_id, stored alongside the
// refresh token so a future client rotation can detect a mismatch and prompt
// reconnect. Non-secret (client_id is public).
export function clientFingerprint(provider: CloudProvider): string {
  // Cheap, dependency-free: not for security, just change-detection.
  const id = getClientId(provider)
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16)
}
