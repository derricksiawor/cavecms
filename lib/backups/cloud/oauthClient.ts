// Typed re-export of the zero-dep device-flow module. App routes import
// `@/lib/backups/cloud/oauthClient`; the `.mjs` stays the zero-dep source of
// truth (re-used by the spawned engine in Phase 2). Types come from the
// adjacent `oauth.d.mts` ambient declaration — the single relative path
// (`../../../` = lib/backups/cloud → repo root) is the only one to verify.
export type {
  CloudProvider,
  DeviceCode,
  PollResult,
  RefreshResult,
} from '../../../scripts/backup/cloud/oauth.mjs'

export {
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
  fetchAccountEmail,
  revokeToken,
} from '../../../scripts/backup/cloud/oauth.mjs'
