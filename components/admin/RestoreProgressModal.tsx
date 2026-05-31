'use client'
import { PhaseProgressModal, type PhaseCopy } from './PhaseProgressModal'
import { RESTORE_STEP_LABELS } from '@/lib/backups/constants'

const SUCCESS = new Set(['completed', 'restart_required'])
const FAIL = new Set(['failed', 'rolled_back'])

const COPY: PhaseCopy = {
  ariaLabel: 'Restore progress',
  inProgressEyebrow: (step, total) => `Restoring · step ${step} of ${total}`,
  inProgressTitle: 'Restoring your site',
  inProgressSubtitle:
    'Putting your content and media back. Your site is briefly in maintenance mode and will come back automatically.',
  successEyebrow: 'Restore complete',
  successTitle: 'Restore successful',
  successSubtitle: 'Your site has been restored from the backup. Reload this page to see it.',
  restartRequiredEyebrow: 'Restore complete',
  restartRequiredTitle: 'Restart to finish',
  restartRequiredSubtitle:
    'Your content and media are restored. Your site runs as a foreground process, so it can’t restart itself — stop the running CaveCMS process and start it again to finish.',
  failedTitle: 'Restore failed',
  failedSubtitle:
    'Something went wrong during the restore. Your previous content and media were put back automatically.',
  rolledBackTitle: 'Restore reverted — your site is safe',
  rolledBackSubtitle:
    'The restore didn’t complete cleanly, so we put your previous content and media back. Your site is live and unchanged.',
  successButtonLabel: 'Reload to see changes',
  successButtonAction: 'reload',
}

export function RestoreProgressModal({
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
      kind="restore"
      stepLabels={RESTORE_STEP_LABELS}
      copy={COPY}
      successStates={SUCCESS}
      failStates={FAIL}
    />
  )
}
