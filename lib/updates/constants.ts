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

// ─── Post-completion watchdog (gap D close) ─────────────────────────
// After a successful update, scripts/cavecms-watchdog.sh is spawned
// detached to poll /healthz. On WATCHDOG_FAIL_THRESHOLD consecutive
// fails it rolls back from the pre-update snapshot. Numbers below are
// mirrored in scripts/cavecms-watchdog.sh defaults — keep them in sync.

/** Poll cadence inside the watchdog. 30 s balances "catches a crash
 *  fast enough that visitors don't get a long broken window" against
 *  "doesn't churn the DB / log files / health endpoint". */
export const WATCHDOG_INTERVAL_MS = 30_000

/** Total guard window after a successful update. 1 h covers the most
 *  common "delayed crash" failure modes (memory-leak first-OOM, route
 *  compiled-on-first-hit fails, dep that only loads under traffic). */
export const WATCHDOG_DURATION_MS = 60 * 60 * 1000

/** Consecutive healthz failures required before triggering rollback.
 *  3 × 30 s = 90 s sustained unhealthy is the threshold — short
 *  enough that a real crash gets caught quickly, long enough that
 *  one transient blip can't rollback a healthy install. */
export const WATCHDOG_FAIL_THRESHOLD = 3

// ─── Background pre-staged downloads ────────────────────────────────
// The prestage step (lib/updates/prestageRelease.ts) downloads + verifies
// a release artifact in the background after a check finds a new version,
// so a later "Update now" skips the slow download. Its own status file +
// lock keep it from ever colliding with the apply orchestrator.

/** 30 minutes — a prestage whose status `updatedAt` exceeds this (with no
 *  live PID holding the lock) is treated as a crashed download; the next
 *  scheduler tick re-stages. Deliberately LONGER than UPDATE_STALE_AFTER_MS
 *  (15 min) because a legitimately slow link can take far longer to pull a
 *  release than an apply takes to run. */
export const PRESTAGE_STALE_AFTER_MS = 30 * 60 * 1000

/** Keep at most this many verified artifacts in the release cache. 2 covers
 *  "current target + the one it's about to supersede" without letting a
 *  long-lived install accumulate release tarballs (matters most on
 *  disk-quota'd cPanel hosts). */
export const PRESTAGE_CACHE_KEEP = 2

/** Per-operation wget timeout (seconds) for the prestage download. Matches
 *  the orchestrator's inline tarball download. wget retries (--tries=3)
 *  within this per-attempt budget. */
export const PRESTAGE_WGET_TIMEOUT_SEC = 300

/** Total ceiling (ms) on the prestage wget invocation — the execFile
 *  timeout. Generous (30 min) so a very slow connection can finish a
 *  background download that would never fit inside a foreground apply. */
export const PRESTAGE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/** Minimum free bytes required in the cache filesystem before a prestage
 *  download starts. Mirrors the orchestrator's preflight disk floor
 *  (500 MB) since we can't know the artifact size before downloading. */
export const PRESTAGE_MIN_FREE_BYTES = 500 * 1024 * 1024
