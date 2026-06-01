import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import {
  writeBackupStatus,
  getBackupStatusPath,
  isSharedOpInProgress,
} from '@/lib/backups/statusFile'
import { BACKUP_TOTAL_STEPS } from '@/lib/backups/constants'
import { spawnBackupEngine } from '@/lib/backups/spawnEngine'
import { prepareBackupCloudEnv, PassphraseRequiredError } from '@/lib/backups/cloud/credsFile'
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
  spawnBackupEngine({ script: 'cavecms-backup.sh', env })
}

// One scheduler tick: run a backup if the schedule says it's due AND no other
// op holds the shared lock. Idempotent + re-entrant-safe via lastScheduled
// BackupAt (claimed before spawning so a concurrent in-process tick + systemd
// trigger don't double-fire). Never throws — records failures into
// backups_state for the UI.
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

  // Claim this occurrence FIRST so a sibling trigger can't double-fire.
  await updateSettingValue(
    'backups_state',
    (cur) => ({ ...cur, lastScheduledBackupAt: now.toISOString() }),
    null,
  )

  try {
    await triggerScheduledBackup(cfg)
    await updateSettingValue(
      'backups_state',
      (cur) => {
        const next = { ...cur, lastScheduledResult: 'ok' as const }
        delete next.lastScheduledError
        return next
      },
      null,
    )
  } catch (err) {
    const msg =
      err instanceof PassphraseRequiredError
        ? 'A passphrase is required to back up secrets to the cloud.'
        : err instanceof Error
          ? err.message.slice(0, 300)
          : String(err).slice(0, 300)
    await updateSettingValue(
      'backups_state',
      (cur) => ({ ...cur, lastScheduledResult: 'failed', lastScheduledError: msg }),
      null,
    )
  }
}
