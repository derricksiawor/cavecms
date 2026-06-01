'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, DatabaseBackup, Upload, Download, Trash2, RotateCcw, ShieldCheck, Clock, Cloud } from 'lucide-react'
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

export interface DestinationsSummary {
  active: 'local' | 'gdrive' | 'onedrive'
  gdrive: { connected: boolean; accountEmail: string | null; configured: boolean }
  onedrive: { connected: boolean; accountEmail: string | null; configured: boolean }
  options: {
    remoteRetention: number
    keepLocalCopy: boolean
    passphraseEnabled: boolean
    schedule: 'off' | 'daily' | 'weekly'
    scheduleHour: number
    scheduleWeekday: number
  }
}

type CloudProvider = 'gdrive' | 'onedrive'
const PROVIDER_LABEL: Record<CloudProvider, string> = {
  gdrive: 'Google Drive',
  onedrive: 'OneDrive',
}
const PROVIDER_ICON: Record<CloudProvider, string> = {
  gdrive: '/icons/google-drive.svg',
  onedrive: '/icons/onedrive.svg',
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

export function BackupsClient({
  initialBackups,
  destinations,
}: {
  initialBackups: BackupRow[]
  destinations: DestinationsSummary
}) {
  const toast = useToast()
  const [backups, setBackups] = useState<BackupRow[]>(initialBackups)
  const [includeEnv, setIncludeEnv] = useState(false)
  const [backupModalOpen, setBackupModalOpen] = useState(false)
  const [restoreModalOpen, setRestoreModalOpen] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState<BackupRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BackupRow | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // ── Cloud destinations (device-flow connect/disconnect) ──
  const [dest, setDest] = useState<DestinationsSummary>(destinations)
  const [connecting, setConnecting] = useState<CloudProvider | null>(null)
  const [deviceFlow, setDeviceFlow] = useState<{
    provider: CloudProvider
    userCode: string
    verificationUrl: string
    expiresAt: string
  } | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const pollOnce = useCallback(
    async (provider: CloudProvider, intervalMs: number) => {
      try {
        const r = await csrfFetch('/api/admin/backups/destinations/connect/poll', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider }),
        })
        const j = (await r.json()) as {
          status: 'pending' | 'slow_down' | 'success' | 'denied' | 'expired'
          accountEmail?: string | null
          intervalSec?: number
        }
        if (j.status === 'success') {
          stopPolling()
          setDeviceFlow(null)
          setConnecting(null)
          setDest((d) => ({
            ...d,
            [provider]: { ...d[provider], connected: true, accountEmail: j.accountEmail ?? null },
          }))
          toast.success(`${PROVIDER_LABEL[provider]} connected.`)
          return
        }
        if (j.status === 'denied' || j.status === 'expired') {
          stopPolling()
          setDeviceFlow(null)
          setConnecting(null)
          toast.error(
            j.status === 'denied'
              ? `${PROVIDER_LABEL[provider]} access was declined.`
              : `The code expired — try connecting again.`,
          )
          return
        }
        // pending / slow_down → keep polling (back off on slow_down).
        const next = j.status === 'slow_down' ? intervalMs + 5000 : intervalMs
        pollTimer.current = setTimeout(() => void pollOnce(provider, next), next)
      } catch {
        // Network blip — keep trying at the same cadence.
        pollTimer.current = setTimeout(() => void pollOnce(provider, intervalMs), intervalMs)
      }
    },
    [stopPolling, toast],
  )

  const connect = useCallback(
    async (provider: CloudProvider) => {
      setConnecting(provider)
      try {
        const r = await csrfFetch('/api/admin/backups/destinations/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider }),
        })
        if (r.status === 503) {
          toast.error(`${PROVIDER_LABEL[provider]} isn't available on this install yet.`)
          setConnecting(null)
          return
        }
        if (!r.ok) {
          toast.error(`Couldn't reach ${PROVIDER_LABEL[provider]} — try again.`)
          setConnecting(null)
          return
        }
        const j = (await r.json()) as {
          userCode: string
          verificationUrl: string
          expiresAt: string
          intervalSec: number
        }
        setDeviceFlow({
          provider,
          userCode: j.userCode,
          verificationUrl: j.verificationUrl,
          expiresAt: j.expiresAt,
        })
        pollTimer.current = setTimeout(
          () => void pollOnce(provider, j.intervalSec * 1000),
          j.intervalSec * 1000,
        )
      } catch {
        toast.error(`Couldn't reach ${PROVIDER_LABEL[provider]} — try again.`)
        setConnecting(null)
      }
    },
    [pollOnce, toast],
  )

  const cancelConnect = useCallback(() => {
    stopPolling()
    setDeviceFlow(null)
    setConnecting(null)
  }, [stopPolling])

  const disconnect = useCallback(
    async (provider: CloudProvider) => {
      try {
        const r = await csrfFetch('/api/admin/backups/destinations/disconnect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider }),
        })
        if (!r.ok) {
          toast.error(`Couldn't disconnect ${PROVIDER_LABEL[provider]} — try again.`)
          return
        }
        setDest((d) => ({
          ...d,
          active: d.active === provider ? 'local' : d.active,
          [provider]: { ...d[provider], connected: false, accountEmail: null },
        }))
        toast.success(`${PROVIDER_LABEL[provider]} disconnected.`)
      } catch {
        toast.error(`Couldn't disconnect ${PROVIDER_LABEL[provider]} — try again.`)
      }
    },
    [toast],
  )

  useEffect(() => () => stopPolling(), [stopPolling])

  // ── Destination options (active destination, retention, encryption) ──
  const [activeDest, setActiveDest] = useState(destinations.active)
  const [retention, setRetention] = useState(destinations.options.remoteRetention)
  const [keepLocal, setKeepLocal] = useState(destinations.options.keepLocalCopy)
  const [passphraseEnabled, setPassphraseEnabled] = useState(destinations.options.passphraseEnabled)
  const [passphrase, setPassphrase] = useState('')
  const [schedule, setSchedule] = useState(destinations.options.schedule)
  const [scheduleHour, setScheduleHour] = useState(destinations.options.scheduleHour)
  const [scheduleWeekday, setScheduleWeekday] = useState(destinations.options.scheduleWeekday)
  const [savingOpts, setSavingOpts] = useState(false)

  const anyConnected = dest.gdrive.connected || dest.onedrive.connected

  const genPassphrase = useCallback(() => {
    const bytes = new Uint8Array(18)
    crypto.getRandomValues(bytes)
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 24)
    setPassphrase(b64)
    setPassphraseEnabled(true)
  }, [])

  const saveOptions = useCallback(async () => {
    setSavingOpts(true)
    try {
      const r = await csrfFetch('/api/admin/backups/destinations/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          destination: activeDest,
          remoteRetention: retention,
          keepLocalCopy: keepLocal,
          passphraseEnabled,
          passphrase: passphrase || undefined,
          schedule,
          scheduleHour,
          scheduleWeekday,
        }),
      })
      if (r.status === 400) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        if (j.error === 'passphrase_required') {
          toast.error('Set a passphrase before turning on encryption.')
        } else if (j.error === 'destination_not_connected') {
          toast.error('Connect that destination first.')
        } else {
          toast.error("Couldn't save those settings.")
        }
        return
      }
      if (!r.ok) {
        toast.error("Couldn't save those settings.")
        return
      }
      setPassphrase('')
      setDest((d) => ({ ...d, active: activeDest }))
      toast.success('Backup settings saved.')
    } catch {
      toast.error("Couldn't save those settings.")
    } finally {
      setSavingOpts(false)
    }
  }, [activeDest, retention, keepLocal, passphraseEnabled, passphrase, schedule, scheduleHour, scheduleWeekday, toast])

  // ── Restore from cloud ──
  interface RemoteRow {
    remoteId: string
    name: string
    sizeBytes: number
    createdAt: string | null
    version: string
    encrypted: boolean
    includeEnv: boolean
    compatible: boolean
    compatNote: string | null
  }
  const [remoteProvider, setRemoteProvider] = useState<CloudProvider | null>(null)
  const [remoteRows, setRemoteRows] = useState<RemoteRow[]>([])
  const [loadingRemote, setLoadingRemote] = useState(false)
  const [confirmCloudRestore, setConfirmCloudRestore] = useState<{ provider: CloudProvider; row: RemoteRow } | null>(null)

  const loadRemote = useCallback(
    async (provider: CloudProvider) => {
      setLoadingRemote(true)
      setRemoteProvider(provider)
      try {
        const r = await fetch(`/api/admin/backups/destinations/remote-list?provider=${provider}`, {
          credentials: 'include',
          cache: 'no-store',
        })
        if (!r.ok) {
          toast.error(`Couldn't load backups from ${PROVIDER_LABEL[provider]}.`)
          setRemoteRows([])
          return
        }
        const j = (await r.json()) as { backups: RemoteRow[] }
        setRemoteRows(j.backups)
      } catch {
        toast.error(`Couldn't load backups from ${PROVIDER_LABEL[provider]}.`)
        setRemoteRows([])
      } finally {
        setLoadingRemote(false)
      }
    },
    [toast],
  )

  const startCloudRestore = useCallback(
    async (provider: CloudProvider, row: RemoteRow) => {
      setConfirmCloudRestore(null)
      try {
        const r = await csrfFetch('/api/admin/backups/restore-from-cloud', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, remoteId: row.remoteId }),
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

      {/* Cloud destinations */}
      <section className="mb-8 rounded-2xl border border-warm-stone/20 bg-cream-50 p-6">
        <div className="flex items-center gap-3">
          <div className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-copper-50 text-copper-600">
            <Cloud className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-near-black">Where backups are stored</h2>
            <p className="text-sm text-warm-stone">
              Backups are always written to this server. Connect your own Google Drive or OneDrive to
              keep an off-site copy that survives a server failure.
            </p>
          </div>
        </div>

        <ul className="mt-5 space-y-3">
          <li className="flex items-center justify-between rounded-xl border border-warm-stone/20 bg-white/40 px-4 py-3">
            <span className="font-medium text-near-black">This server (always on)</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-stone/70">
              Local
            </span>
          </li>

          {(['gdrive', 'onedrive'] as CloudProvider[]).map((provider) => {
            const c = dest[provider]
            return (
              <li
                key={provider}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warm-stone/20 bg-white/40 px-4 py-3"
              >
                <span className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={PROVIDER_ICON[provider]} alt="" className="h-6 w-6" />
                  <span className="font-medium text-near-black">{PROVIDER_LABEL[provider]}</span>
                  {c.connected && c.accountEmail ? (
                    <span className="text-sm text-warm-stone">· {c.accountEmail}</span>
                  ) : null}
                </span>
                {c.connected ? (
                  <Button type="button" variant="ghost" onClick={() => void disconnect(provider)}>
                    Disconnect
                  </Button>
                ) : !c.configured ? (
                  <span className="text-xs text-warm-stone/70">Not available on this install</span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={connecting !== null}
                    onClick={() => void connect(provider)}
                  >
                    {connecting === provider ? 'Connecting…' : 'Connect'}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>

        {deviceFlow ? (
          <div className="mt-5 rounded-xl border border-copper-400 bg-copper-50/60 p-5">
            <p className="text-sm text-near-black">
              To connect {PROVIDER_LABEL[deviceFlow.provider]}, open this link and enter the code:
            </p>
            <a
              href={deviceFlow.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block font-medium text-copper-700 underline"
            >
              {deviceFlow.verificationUrl}
            </a>
            <div className="mt-3 select-all rounded-lg bg-white px-4 py-3 text-center font-mono text-2xl tracking-[0.3em] text-near-black">
              {deviceFlow.userCode}
            </div>
            <p className="mt-3 text-sm text-warm-stone">Waiting for you to approve…</p>
            <Button type="button" variant="ghost" className="mt-2" onClick={cancelConnect}>
              Cancel
            </Button>
          </div>
        ) : null}

        {anyConnected ? (
          <div className="mt-6 border-t border-warm-stone/20 pt-5">
            <h3 className="text-sm font-semibold text-near-black">Backup settings</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-near-black">Send backups to</span>
                <select
                  value={activeDest}
                  onChange={(e) => setActiveDest(e.target.value as DestinationsSummary['active'])}
                  className="mt-1 w-full rounded-lg border border-warm-stone/30 bg-white px-3 py-2 text-sm"
                >
                  <option value="local">This server only</option>
                  {dest.gdrive.connected ? <option value="gdrive">Google Drive</option> : null}
                  {dest.onedrive.connected ? <option value="onedrive">OneDrive</option> : null}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-near-black">Keep this many in the cloud</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={retention}
                  onChange={(e) => setRetention(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                  className="mt-1 w-full rounded-lg border border-warm-stone/30 bg-white px-3 py-2 text-sm"
                />
              </label>
            </div>

            <label className="mt-4 flex items-center gap-2 text-sm text-near-black">
              <input
                type="checkbox"
                checked={keepLocal}
                onChange={(e) => setKeepLocal(e.target.checked)}
                className="h-4 w-4 rounded border-warm-stone/40 text-copper-600"
              />
              Also keep a copy on this server
            </label>

            <label className="mt-3 flex items-center gap-2 text-sm text-near-black">
              <input
                type="checkbox"
                checked={passphraseEnabled}
                onChange={(e) => setPassphraseEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-warm-stone/40 text-copper-600"
              />
              Encrypt cloud backups with a passphrase
            </label>
            {passphraseEnabled ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={
                    destinations.options.passphraseEnabled
                      ? 'Leave blank to keep your current passphrase'
                      : 'Choose a passphrase you’ll remember'
                  }
                  className="min-w-[16rem] flex-1 rounded-lg border border-warm-stone/30 bg-white px-3 py-2 font-mono text-sm"
                />
                <Button type="button" variant="ghost" onClick={genPassphrase}>
                  Generate
                </Button>
              </div>
            ) : null}
            <p className="mt-2 text-xs text-warm-stone">
              Keep your passphrase safe — it’s the only way to restore an encrypted cloud backup if this
              server is ever lost.
            </p>

            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="text-sm font-medium text-near-black">Automatic backups</span>
                <select
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value as 'off' | 'daily' | 'weekly')}
                  className="mt-1 w-full rounded-lg border border-warm-stone/30 bg-white px-3 py-2 text-sm"
                >
                  <option value="off">Off</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              {schedule !== 'off' ? (
                <label className="block">
                  <span className="text-sm font-medium text-near-black">At hour</span>
                  <select
                    value={scheduleHour}
                    onChange={(e) => setScheduleHour(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-warm-stone/30 bg-white px-3 py-2 text-sm"
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {schedule === 'weekly' ? (
                <label className="block">
                  <span className="text-sm font-medium text-near-black">On</span>
                  <select
                    value={scheduleWeekday}
                    onChange={(e) => setScheduleWeekday(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-warm-stone/30 bg-white px-3 py-2 text-sm"
                  >
                    {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                      (d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              ) : null}
            </div>
            {schedule !== 'off' ? (
              <p className="mt-2 text-xs text-warm-stone">
                Times use this server’s clock, to the nearest hour.
              </p>
            ) : null}

            <div className="mt-4">
              <Button type="button" disabled={savingOpts} onClick={() => void saveOptions()}>
                {savingOpts ? 'Saving…' : 'Save backup settings'}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Restore from cloud */}
      {anyConnected ? (
        <section className="mb-8 rounded-2xl border border-warm-stone/20 bg-cream-50 p-6">
          <h2 className="text-lg font-semibold text-near-black">Restore from the cloud</h2>
          <p className="mt-1 text-sm text-warm-stone">
            Pull a backup back from your connected account — useful if this server is ever lost.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(['gdrive', 'onedrive'] as CloudProvider[])
              .filter((p) => dest[p].connected)
              .map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant="ghost"
                  disabled={loadingRemote}
                  onClick={() => void loadRemote(p)}
                >
                  {loadingRemote && remoteProvider === p
                    ? 'Loading…'
                    : `Show ${PROVIDER_LABEL[p]} backups`}
                </Button>
              ))}
          </div>

          {remoteProvider && !loadingRemote ? (
            remoteRows.length === 0 ? (
              <p className="mt-4 text-sm text-warm-stone">
                No backups found in {PROVIDER_LABEL[remoteProvider]} yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {remoteRows.map((row) => (
                  <li
                    key={row.remoteId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warm-stone/20 bg-white/40 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-near-black">{humanWhen(row.createdAt ?? '')}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-warm-stone">
                        <span>{humanSize(row.sizeBytes)}</span>
                        <span className="rounded-full bg-warm-stone/10 px-2 py-0.5">v{row.version}</span>
                        {row.encrypted ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <ShieldCheck className="h-3.5 w-3.5" /> Encrypted
                          </span>
                        ) : null}
                        {row.includeEnv ? (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <ShieldCheck className="h-3.5 w-3.5" /> Includes secrets
                          </span>
                        ) : null}
                        {!row.compatible && row.compatNote ? (
                          <span className="text-red-600">{row.compatNote}</span>
                        ) : null}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!row.compatible}
                      onClick={() => setConfirmCloudRestore({ provider: remoteProvider, row })}
                      className="inline-flex items-center gap-1.5 rounded-full border border-copper-400 px-3 py-1.5 text-xs font-medium text-copper-700 transition-colors hover:bg-copper-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      ) : null}

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
        open={confirmCloudRestore !== null}
        destructive
        title="Restore from the cloud?"
        description="This downloads the backup and replaces your current content and media with it. A safety snapshot is taken first, and the restore rolls back automatically if anything goes wrong."
        confirmLabel="Restore"
        onConfirm={() =>
          confirmCloudRestore &&
          void startCloudRestore(confirmCloudRestore.provider, confirmCloudRestore.row)
        }
        onCancel={() => setConfirmCloudRestore(null)}
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
