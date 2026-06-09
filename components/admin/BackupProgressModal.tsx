'use client'
import { PhaseProgressModal, type PhaseCopy } from './PhaseProgressModal'
import { BACKUP_STEP_LABELS } from '@/lib/backups/constants'

const SUCCESS = new Set(['completed'])
const FAIL = new Set(['failed'])

const COPY: PhaseCopy = {
  ariaLabel: 'Backup progress',
  inProgressEyebrow: (step, total) => `Making a backup · step ${step} of ${total}`,
  inProgressTitle: 'Backing up your site',
  inProgressSubtitle:
    'Saving your content and media. Your site stays live the whole time — this is read-only.',
  successEyebrow: 'Backup complete',
  successTitle: 'Backup saved',
  successSubtitle: 'Your content and media are safely backed up. You can download or restore it any time.',
  // Backup never needs a restart — these are unused but required by the type.
  restartRequiredEyebrow: 'Backup complete',
  restartRequiredTitle: 'Backup saved',
  restartRequiredSubtitle: 'Your backup is ready.',
  failedTitle: 'Backup failed',
  failedSubtitle: 'Something went wrong while making the backup. Your site is unaffected — please try again.',
  rolledBackTitle: 'Backup failed',
  rolledBackSubtitle: 'Something went wrong. Your site is unaffected.',
  successButtonLabel: 'Done',
  successButtonAction: 'close',
}

export function BackupProgressModal({
  open,
  onClose,
  onCompleted,
}: {
  open: boolean
  onClose: () => void
  onCompleted?: () => void
}) {
  return (
    <PhaseProgressModal
      open={open}
      onClose={onClose}
      onCompleted={onCompleted}
      kind="backup"
      stepLabels={BACKUP_STEP_LABELS}
      copy={COPY}
      successStates={SUCCESS}
      failStates={FAIL}
      // The backups page opens this modal the instant "Back up now" is
      // clicked (immediate feedback), BEFORE the create route confirms —
      // so the first poll(s) may still see the previous run's terminal
      // status. awaitFresh keeps the "getting ready" state until the new
      // run's seeded status replaces it.
      awaitFresh
    />
  )
}
