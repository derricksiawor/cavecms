// Step models + polling/staleness constants for the backup + restore
// progress UIs. Deliberately SEPARATE from lib/updates/constants.ts — the
// update flow's 6-step shape is hardcoded across three coupled places and
// must not be reused here.

/** Backup: preflight → db-dump → uploads → assemble → finalize/prune. */
export const BACKUP_TOTAL_STEPS = 5
/** Restore: validate → safety-snapshot → db → uploads → migrate → restart → verify. */
export const RESTORE_TOTAL_STEPS = 7

export const BACKUP_STALE_AFTER_MS = 15 * 60 * 1000
export const BACKUP_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000

export const BACKUP_POLL_FAST_MS = 1000
export const BACKUP_POLL_SLOW_MS = 2000
export const BACKUP_STATUS_FETCH_TIMEOUT_MS = 8000
export const BACKUP_RECONNECT_MAX_RETRIES = 90

export const BACKUP_STEP_LABELS = [
  'Getting ready',
  'Saving your content',
  'Saving your media',
  'Packaging the archive',
  'Finishing up',
] as const

export const RESTORE_STEP_LABELS = [
  'Checking the archive',
  'Safeguarding current data',
  'Restoring your content',
  'Restoring your media',
  'Bringing things up to date',
  'Restarting your site',
  'Verifying',
] as const
