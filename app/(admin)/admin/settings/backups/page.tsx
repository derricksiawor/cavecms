import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { listBackups } from '@/lib/backups/store'
import { getSetting } from '@/lib/cms/getSettings'
import { isProviderConfigured } from '@/lib/backups/cloud/clients'
import { BackupsClient, type BackupRow, type DestinationsSummary } from './BackupsClient'

// Admin-only Settings → Backups surface. Server component reads the local
// backup list (filesystem) + the cloud-destination connection summary, then
// hands them to the interactive client.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

export default async function BackupsSettingsPage() {
  await requireRoleOrRedirect(['admin'])
  const initial: BackupRow[] = listBackups().map((e) => ({
    file: e.file,
    sizeBytes: e.sizeBytes,
    createdAt: new Date(e.createdAtMs).toISOString(),
    encrypted: e.encrypted,
    version: e.version,
    includeEnv: e.includeEnv,
  }))
  const cfg = await getSetting('backups')
  const destinations: DestinationsSummary = {
    active: cfg.destination,
    gdrive: {
      connected: cfg.gdrive.connected,
      accountEmail: cfg.gdrive.accountEmail ?? null,
      configured: isProviderConfigured('gdrive'),
    },
    onedrive: {
      connected: cfg.onedrive.connected,
      accountEmail: cfg.onedrive.accountEmail ?? null,
      configured: isProviderConfigured('onedrive'),
    },
    options: {
      remoteRetention: cfg.remoteRetention,
      keepLocalCopy: cfg.keepLocalCopy,
      passphraseEnabled: cfg.encryption.passphraseEnabled,
    },
  }
  return <BackupsClient initialBackups={initial} destinations={destinations} />
}
