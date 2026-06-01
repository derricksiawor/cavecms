import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import {
  writeBackupStatus,
  getBackupStatusPath,
  isSharedOpInProgress,
} from '@/lib/backups/statusFile'
import { BACKUP_TOTAL_STEPS } from '@/lib/backups/constants'
import { spawnBackupEngine } from '@/lib/backups/spawnEngine'
import {
  prepareBackupCloudEnv,
  discardCloudCreds,
  PassphraseRequiredError,
  CloudDestinationUnavailableError,
} from '@/lib/backups/cloud/credsFile'
import type { SettingsValue } from '@/lib/cms/settings-registry'

type Backups = SettingsValue<'backups'>

// Pure due-check, exported for unit testing. Uses the server's local clock with
// hourly granularity (a daily/weekly backup fires on the first tick at/after
// scheduleHour). `lastAtMs` is the last scheduled-backup kickoff time.
export function isScheduledBackupDue(
  cfg: Pick<Backups, 'schedule' | 'scheduleHour' | 'scheduleWeekday'>,
  lastAtMs: number,
  now: Date,
): boolean {
  if (cfg.schedule === 'off') return false
  if (cfg.schedule === 'weekly' && now.getDay() !== cfg.scheduleWeekday) return false
  const scheduled = new Date(now)
  scheduled.setHours(cfg.scheduleHour, 0, 0, 0)
  if (now.getTime() < scheduled.getTime()) return false
  return lastAtMs < scheduled.getTime()
}

// Kick off a backup to the configured destination with the configured
// include-secrets setting. Throws PassphraseRequiredError if includeEnv is on
// for a cloud destination without a passphrase.
async function triggerScheduledBackup(cfg: Backups): Promise<void> {
  const cloudEnv = await prepareBackupCloudEnv(cfg.includeEnv)
  writeBackupStatus({
    state: 'running',
    step: 0,
    totalSteps: cloudEnv ? BACKUP_TOTAL_STEPS + 1 : BACKUP_TOTAL_STEPS,
    stepLabel: 'Getting ready',
    error: undefined,
    log: undefined,
  })
  const env: Record<string, string> = { CAVECMS_BACKUP_STATUS_PATH: getBackupStatusPath() }
  if (cfg.includeEnv) env.CAVECMS_BACKUP_INCLUDE_ENV = '1'
  if (cloudEnv) Object.assign(env, cloudEnv)
  try {
    spawnBackupEngine({ script: 'cavecms-backup.sh', env })
  } catch (err) {
    // The engine never started → its trap can't wipe the plaintext creds file.
    if (cloudEnv) discardCloudCreds()
    throw err
  }
}

// One scheduler tick: run a backup if the schedule says it's due AND no other
// op holds the shared lock. The claim (advancing lastScheduledBackupAt) narrows
// the double-fire window between the in-process tick and the systemd trigger;
// the AUTHORITATIVE dedup is the bash O_EXCL op lock in cavecms-backup.sh — a
// losing concurrent spawn exits cleanly without mutating or clobbering status.
// Never throws — spawn-time failures are recorded into backups_state.
export async function runBackupTickIfDue(): Promise<void> {
  const cfg = await getSetting('backups')
  if (cfg.schedule === 'off') return
  const state = await getSetting('backups_state')
  const lastAtMs = state.lastScheduledBackupAt ? Date.parse(state.lastScheduledBackupAt) : 0
  const now = new Date()
  if (!isScheduledBackupDue(cfg, Number.isFinite(lastAtMs) ? lastAtMs : 0, now)) return

  if (isSharedOpInProgress()) {
    await updateSettingValue(
      'backups_state',
      (cur) => ({ ...cur, lastScheduledResult: 'skipped' }),
      null,
    )
    return
  }

  // Claim this occurrence FIRST (advance lastScheduledBackupAt so a sibling
  // trigger can't double-fire) and flag the run in-flight so the audit-terminal
  // endpoint records the REAL completion outcome.
  await updateSettingValue(
    'backups_state',
    (cur) => ({
      ...cur,
      lastScheduledBackupAt: now.toISOString(),
      scheduledInFlight: true,
      scheduledInFlightAt: now.toISOString(),
    }),
    null,
  )

  try {
    await triggerScheduledBackup(cfg)
    // Success here means "spawned" — the terminal result is recorded by
    // recordScheduledBackupOutcome() from the audit-terminal callback.
  } catch (err) {
    // A spawn-time failure means no backup ran and no audit-terminal will fire,
    // so record the failure + clear the in-flight flag here.
    const msg =
      err instanceof PassphraseRequiredError
        ? 'A passphrase is required to back up secrets to the cloud.'
        : err instanceof CloudDestinationUnavailableError
          ? 'Your cloud destination is disconnected — reconnect it to resume backups.'
          : err instanceof Error
            ? err.message.slice(0, 300)
            : String(err).slice(0, 300)
    await updateSettingValue(
      'backups_state',
      (cur) => ({
        ...cur,
        lastScheduledResult: 'failed',
        lastScheduledError: msg,
        scheduledInFlight: false,
      }),
      null,
    )
  }
}
