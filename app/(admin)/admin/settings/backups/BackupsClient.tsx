'use client'
import { useCallback, useRef, useState } from 'react'
import { Archive, DatabaseBackup, Upload, Download, Trash2, RotateCcw, ShieldCheck, Clock } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { BackupProgressModal } from '@/components/admin/BackupProgressModal'
import { RestoreProgressModal } from '@/components/admin/RestoreProgressModal'

export interface BackupRow {
  file: string
  sizeBytes: number
  createdAt: string
  encrypted: boolean
  version: string | null
  includeEnv: boolean | null
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function humanWhen(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return 'Recently'
  }
}

export function BackupsClient({ initialBackups }: { initialBackups: BackupRow[] }) {
  const toast = useToast()
  const [backups, setBackups] = useState<BackupRow[]>(initialBackups)
  const [includeEnv, setIncludeEnv] = useState(false)
  const [backupModalOpen, setBackupModalOpen] = useState(false)
  const [restoreModalOpen, setRestoreModalOpen] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState<BackupRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BackupRow | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/backups/list', { credentials: 'include', cache: 'no-store' })
      if (r.ok) {
        const j = (await r.json()) as { backups: BackupRow[] }
        setBackups(j.backups)
      }
    } catch {
      /* best-effort */
    }
  }, [])

  const startBackup = useCallback(async () => {
    try {
      const r = await csrfFetch('/api/admin/backups/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeEnv }),
      })
      if (r.status === 409) {
        toast.error('A backup or restore is already running.')
        return
      }
      if (!r.ok) {
        toast.error("Couldn't start the backup — try again.")
        return
      }
      setBackupModalOpen(true)
    } catch {
      toast.error("Couldn't start the backup — try again.")
    }
  }, [includeEnv, toast])

  const startRestore = useCallback(
    async (row: BackupRow) => {
      setConfirmRestore(null)
      try {
        const r = await csrfFetch('/api/admin/backups/restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: row.file }),
        })
        if (r.status === 409) {
          toast.error('A backup or restore is already running.')
          return
        }
        if (!r.ok) {
          toast.error("Couldn't start the restore — try again.")
          return
        }
        setRestoreModalOpen(true)
      } catch {
        toast.error("Couldn't start the restore — try again.")
      }
    },
    [toast],
  )

  const doDelete = useCallback(
    async (row: BackupRow) => {
      setConfirmDelete(null)
      try {
        const r = await csrfFetch('/api/admin/backups/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: row.file }),
        })
        if (!r.ok) {
          toast.error("Couldn't delete that backup.")
          return
        }
        toast.success('Backup deleted.')
        void refreshList()
      } catch {
        toast.error("Couldn't delete that backup.")
      }
    },
    [toast, refreshList],
  )

  const onUploadFile = useCallback(
    async (file: File) => {
      setBusy(true)
      try {
        const fd = new FormData()
        fd.append('archive', file)
        const r = await csrfFetch('/api/admin/backups/upload-restore', { method: 'POST', body: fd })
        if (r.status === 409) {
          toast.error('A backup or restore is already running.')
          return
        }
        if (r.status === 400) {
          toast.error("That file isn't a valid CaveCMS backup.")
          return
        }
        if (!r.ok) {
          toast.error("Couldn't start the restore from that file.")
          return
        }
        setRestoreModalOpen(true)
      } catch {
        toast.error("Couldn't upload that file.")
      } finally {
        setBusy(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    },
    [toast],
  )

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-8">
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-600">
          Settings · Backups
        </p>
        <h1 className="mt-2 font-serif text-3xl font-bold tracking-tight text-near-black">
          Backups
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-warm-stone">
          Back up your content and media to a downloadable archive, and restore it any time. Backups
          are read-only — your site stays live while one is made.
        </p>
      </header>

      {/* Create + upload actions */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-warm-stone/20 bg-cream-50 p-6">
          <div className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-copper-50 text-copper-600">
            <DatabaseBackup className="h-6 w-6" />
          </div>
          <h2 className="mt-3 text-lg font-semibold text-near-black">Make a backup</h2>
          <p className="mt-1 text-sm text-warm-stone">
            Saves all your content and media to a dated archive.
          </p>
          <label className="mt-3 flex items-center gap-2 text-sm text-warm-stone">
            <input
              type="checkbox"
              checked={includeEnv}
              onChange={(e) => setIncludeEnv(e.target.checked)}
              className="h-4 w-4 rounded border-warm-stone/40 text-copper-600"
            />
            Include secrets (for full disaster recovery)
          </label>
          <div className="mt-4">
            <Button type="button" onClick={startBackup}>
              <Archive className="h-4 w-4" />
              Back up now
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border border-warm-stone/20 bg-cream-50 p-6">
          <div className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-copper-50 text-copper-600">
            <Upload className="h-6 w-6" />
          </div>
          <h2 className="mt-3 text-lg font-semibold text-near-black">Restore from a file</h2>
          <p className="mt-1 text-sm text-warm-stone">
            Upload a backup archive to restore this site from it.
          </p>
          <div className="mt-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onUploadFile(f)
              }}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              {busy ? 'Uploading…' : 'Upload & restore'}
            </Button>
          </div>
        </div>
      </section>

      {/* Backup list */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Your backups
        </h2>
        {backups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-warm-stone/30 bg-cream-50/40 px-6 py-12 text-center">
            <Archive className="mx-auto h-8 w-8 text-warm-stone/50" />
            <p className="mt-3 text-sm text-warm-stone">No backups yet. Make your first one above.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {backups.map((b) => (
              <li
                key={b.file}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warm-stone/20 bg-cream-50 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 shrink-0 text-copper-600" />
                    <p className="font-medium text-near-black">{humanWhen(b.createdAt)}</p>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-warm-stone">
                    <span>{humanSize(b.sizeBytes)}</span>
                    {b.version && <span className="rounded-full bg-warm-stone/10 px-2 py-0.5">v{b.version}</span>}
                    {b.encrypted && (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <ShieldCheck className="h-3.5 w-3.5" /> Encrypted
                      </span>
                    )}
                    {b.includeEnv && (
                      <span className="inline-flex items-center gap-1 text-amber-700">
                        <ShieldCheck className="h-3.5 w-3.5" /> Includes secrets
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`/api/admin/backups/download?file=${encodeURIComponent(b.file)}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-warm-stone/30 px-3 py-1.5 text-xs font-medium text-near-black transition-colors hover:bg-warm-stone/10"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </a>
                  <button
                    type="button"
                    onClick={() => setConfirmRestore(b)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-copper-400 px-3 py-1.5 text-xs font-medium text-copper-700 transition-colors hover:bg-copper-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(b)}
                    aria-label="Delete backup"
                    className="inline-flex items-center justify-center rounded-full border border-warm-stone/30 p-1.5 text-warm-stone transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmModal
        open={confirmRestore !== null}
        destructive
        title="Restore this backup?"
        description="This replaces your current content and media with the backup’s. A safety snapshot is taken first, and the restore rolls back automatically if anything goes wrong."
        confirmLabel="Restore"
        onConfirm={() => confirmRestore && void startRestore(confirmRestore)}
        onCancel={() => setConfirmRestore(null)}
      />
      <ConfirmModal
        open={confirmDelete !== null}
        destructive
        title="Delete this backup?"
        description="The backup file is moved to a trash folder on your server. This doesn’t affect your live site."
        confirmLabel="Delete"
        onConfirm={() => confirmDelete && void doDelete(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />

      <BackupProgressModal
        open={backupModalOpen}
        onClose={() => {
          setBackupModalOpen(false)
          void refreshList()
        }}
        onCompleted={() => void refreshList()}
      />
      <RestoreProgressModal
        open={restoreModalOpen}
        onClose={() => setRestoreModalOpen(false)}
      />
    </div>
  )
}
