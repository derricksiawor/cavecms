// Typed re-export of the zero-dep destination engine for app-side use (remote
// listing + restore prep). The `.mjs` stays the single source of truth.
export type { CloudEntry, Destination } from '../../../scripts/backup/cloud/destination.mjs'
export {
  createDestination,
  clearAccessTokenCache,
} from '../../../scripts/backup/cloud/destination.mjs'
