import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { listBackups } from '@/lib/backups/store'
import { BackupsClient, type BackupRow } from './BackupsClient'

// Admin-only Settings → Backups surface. Server component reads the local
// backup list (filesystem) + hands it to the interactive client.

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
  return <BackupsClient initialBackups={initial} />
}
