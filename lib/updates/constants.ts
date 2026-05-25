// Shared magic numbers across the Updates surface — server + client.
// Single source of truth so the modal's poll cadence, the script's
// healthz budget, the stale-detection cutoff, and the orchestrator's
// total-step count don't drift across files.

/** 5 minutes — in-memory cache TTL for the GitHub release check. */
export const UPDATE_CHECK_TTL_MS = 5 * 60 * 1000

/** 15 minutes — a status whose `updatedAt` exceeds this is treated as
 *  a crashed orchestrator; the apply route clears it and allows a
 *  retry, and the status API surfaces a synthetic `failed` state. */
export const UPDATE_STALE_AFTER_MS = 15 * 60 * 1000

/** 24 hours — a TERMINAL status (completed/failed/rolled_back) older
 *  than this is hidden from the status route so the modal doesn't
 *  resurrect a week-old completion banner. */
export const UPDATE_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000

/** Total step count baked into the orchestrator script. The modal
 *  and the API route both read this. */
export const UPDATE_TOTAL_STEPS = 6

/** Modal polling cadence — slower while waiting for new step writes,
 *  faster while we're listening for the new app version to come back
 *  online during the restart. */
export const UPDATE_POLL_SLOW_MS = 2_000
export const UPDATE_POLL_FAST_MS = 1_000

/** Modal: how many consecutive status-fetch failures before we
 *  declare the update failed. At FAST cadence (1s), 90 = 90s. */
export const UPDATE_RECONNECT_MAX_RETRIES = 90

/** Status fetch timeout — short enough to bail on a hung restart,
 *  long enough to ride out a slow first-request post-pm2-reload. */
export const UPDATE_STATUS_FETCH_TIMEOUT_MS = 8_000

/** Truncation cap for the release changelog. Prevents a runaway
 *  60KB commit-message body from inflating the JSON payload. */
export const RELEASE_CHANGELOG_MAX_BYTES = 4096

/** Hard timeout on the outbound GitHub fetch. */
export const RELEASE_FETCH_TIMEOUT_MS = 10_000
