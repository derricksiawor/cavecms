'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Download,
  CheckCircle2,
  ShieldAlert,
  Sparkles,
  Clock,
  RefreshCw,
} from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { ZodForm } from '@/components/inline-edit/ZodForm'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { SETTINGS_SHAPES, SETTINGS_HELP } from '@/lib/cms/settings-shapes'
import { UpdatesProgressModal } from '@/components/admin/UpdatesProgressModal'
import { UpdateHistoryTable } from '@/components/admin/UpdateHistoryTable'
import { ReleaseNotesMarkdown } from '@/components/admin/ReleaseNotesMarkdown'
import { WhatsNewCard } from '@/components/admin/WhatsNewCard'
import {
  humaniseRelease,
  formatRelativeDays,
  type HumanRelease,
} from '@/lib/updates/humaniseRelease'
import type { CurrentVersion } from '@/lib/updates/getCurrentVersion'
import type { CurrentVersionNotes } from '@/lib/updates/getCurrentVersionNotes'

// Settings → Updates surface.
//
// Copy rules: NO SHAs, NO GitHub commit URLs, NO raw timestamps. We
// talk in "You're currently running CaveCMS, last updated 3 days ago"
// and "A new version is available, released today" — semver versions
// will replace the relative dates once updates.cavecms.com/releases ships its
// manifest.

interface SettingRow {
  key: 'updates'
  value: unknown
  version: number
  updatedAt: string
}

interface AvailableUpdate {
  sha: string
  ts: string
  changelog: string
  isSecurity: boolean
  // Static-manifest fields plumbed through to apply so the orchestrator
  // can run tarball-mode without depending on a git checkout (CLI-installed
  // instances have no .git directory).
  version: string
  downloadUrl: string
  sha256: string
  // Ed25519 base64 signature over the zip bytes — REQUIRED by the apply
  // route (signed-updates, since 0.1.45). The check route returns it; the
  // apply payload below MUST forward it or apply 400s on the strict schema.
  signature: string | null
  minPreviousVersion: string | null
}

interface ApplyPayload {
  targetSha: string
  downloadUrl: string
  sha256: string
  signature: string
  force?: boolean
}

interface CheckResponse {
  current: CurrentVersion
  available: AvailableUpdate | null
  // Coords for re-installing the CURRENTLY running version. Server
  // populates this when running SHA matches the latest manifest entry
  // so Re-run install has known-good coords even without an upgrade
  // available.
  currentRelease: { downloadUrl: string; sha256: string; signature: string | null } | null
  // Background pre-stage state for the relevant target. `staged` non-null
  // means the verified artifact is on disk RIGHT NOW (installs in seconds);
  // `stageState === 'downloading'` means bytes are still arriving in the
  // background.
  staged: { sha: string; sha256: string; version: string; stagedAt: string } | null
  stageState: 'downloading' | 'staged' | 'failed' | 'ineligible' | null
}

// Lowercase relative-date formatter for inline-after-verb usage
// ("Last updated 3 days ago"). Single shared implementation lives in
// humaniseRelease.ts — passing `capitalise: false` gives us the
// lowercase variant used here.
function relativeDays(when: Date): string {
  return formatRelativeDays(when, new Date(), { capitalise: false })
}

export function UpdatesClient({
  initial,
  currentVersion,
  currentVersionNotes,
}: {
  initial: SettingRow
  currentVersion: CurrentVersion
  currentVersionNotes: CurrentVersionNotes | null
}) {
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [release, setRelease] = useState<HumanRelease | null>(null)
  const [availableShaPrivate, setAvailableShaPrivate] = useState<string | null>(null)
  // Stash the tarball coordinates so the apply call can pass them through
  // to the orchestrator (no git-pull on fresh CLI installs).
  const [availableDownloadUrl, setAvailableDownloadUrl] = useState<string | null>(null)
  const [availableSha256, setAvailableSha256] = useState<string | null>(null)
  const [availableSignature, setAvailableSignature] = useState<string | null>(null)
  const [current, setCurrent] = useState<CurrentVersion>(currentVersion)
  const [modalOpen, setModalOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  // Background pre-stage signals — drive the subtle "downloading in the
  // background / downloaded and ready" indicator + the Update-now subline.
  const [stagedReady, setStagedReady] = useState(false)
  const [stageState, setStageState] = useState<
    'downloading' | 'staged' | 'failed' | 'ineligible' | null
  >(null)

  const initialForm = useMemo(
    () =>
      initial.value && typeof initial.value === 'object'
        ? (initial.value as Record<string, unknown>)
        : {},
    [initial.value],
  )
  const [form, setForm] = useState<Record<string, unknown>>(initialForm)
  const [pristine, setPristine] = useState<Record<string, unknown>>(initialForm)
  const [version, setVersion] = useState(initial.version)
  const [savingSettings, setSavingSettings] = useState(false)
  const dirty = useMemo(
    () => !structuralEqual(form, pristine),
    [form, pristine],
  )

  // Auto-check on mount. We do NOT surface toasts here — the check is
  // background machinery, not an operator-initiated action. The
  // available-update card OR the "you're up to date" panel below is
  // the visible signal. Errors stay silent except for network outage,
  // which gets a one-time toast so the operator knows their machine
  // can't reach the release server.
  const handleCheck = useCallback(async () => {
    if (checking) return
    setChecking(true)
    try {
      const r = await csrfFetch('/api/admin/updates/check', { method: 'POST' })
      // Distinguish the failure classes the check route emits (per
      // lib/updates/checkLatestRelease error classification):
      //   - 502 check_repo_not_found:  manifest URL returned 404 (misconfig)
      //   - 502 check_unreachable:     network failure reaching the host
      //   - 502 check_failed:          generic upstream (malformed JSON, etc.)
      if (r.status === 502) {
        let body: { error?: string } | null = null
        try {
          body = (await r.json()) as { error?: string }
        } catch {
          /* body may not be JSON */
        }
        if (body?.error === 'check_repo_not_found') {
          toast.error(
            "Couldn't find the CaveCMS release manifest. Your update channel may be misconfigured — contact support.",
          )
        } else if (body?.error === 'check_unreachable') {
          toast.error("Couldn't reach the CaveCMS release server — check your server's internet access.")
        } else {
          toast.error("The release server returned bad data. Try again later.")
        }
        return
      }
      if (!r.ok) return
      const j = (await r.json()) as CheckResponse
      setCurrent(j.current)
      setCheckedAt(new Date().toISOString())
      // Background pre-stage signals (target-gated server-side).
      setStagedReady(j.staged !== null)
      setStageState(j.stageState)
      if (!j.available) {
        setRelease(null)
        setAvailableShaPrivate(null)
        // When up-to-date, the server hands us coords for the running
        // version so Re-run install can apply them without a second
        // round-trip. Without this, Re-run after a clean update would
        // toast "Couldn't fetch the release manifest".
        setAvailableDownloadUrl(j.currentRelease?.downloadUrl ?? null)
        setAvailableSha256(j.currentRelease?.sha256 ?? null)
        setAvailableSignature(j.currentRelease?.signature ?? null)
      } else {
        setRelease(humaniseRelease(j.available))
        // SHA + tarball coords stay in private state slots — used only
        // as the apply payload, never rendered.
        setAvailableShaPrivate(j.available.sha)
        setAvailableDownloadUrl(j.available.downloadUrl)
        setAvailableSha256(j.available.sha256)
        setAvailableSignature(j.available.signature)
      }
    } finally {
      setChecking(false)
    }
  }, [checking, toast])

  useEffect(() => {
    void handleCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleApply = useCallback(async () => {
    if (!availableShaPrivate || !availableDownloadUrl || !availableSha256 || !availableSignature || applying) return
    setApplying(true)
    try {
      const payload: ApplyPayload = {
        targetSha: availableShaPrivate,
        downloadUrl: availableDownloadUrl,
        sha256: availableSha256,
        signature: availableSignature,
      }
      const r = await csrfFetch('/api/admin/updates/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (r.status === 409) {
        let body: { error?: string } | null = null
        try {
          body = (await r.json()) as { error?: string }
        } catch {
          /* body may not be JSON */
        }
        if (body?.error === 'ineligible_jump') {
          toast.error(
            'This update is too big a jump to install in one step. Update to an in-between version first, or re-install with the CLI.',
          )
          return
        }
        toast.error('An update is already in progress.')
        setModalOpen(true)
        return
      }
      if (!r.ok) {
        toast.error("Couldn't start the update — try again.")
        return
      }
      setModalOpen(true)
    } catch {
      // Previously there was NO catch here: a thrown fetch/CSRF/network
      // error left the click a SILENT no-op (operator clicks, nothing
      // happens, clicks again…). Always give feedback.
      toast.error("Couldn't start the update — try again.")
    } finally {
      setApplying(false)
    }
  }, [availableShaPrivate, availableDownloadUrl, availableSha256, availableSignature, applying, toast])

  // Re-run install on the SAME SHA — recovery affordance for a stuck
  // migration / corrupted .next/ cache. The server-side guard refuses
  // same-SHA targets unless force === true, so the UI MUST opt in
  // here explicitly. Same modal flow as a normal update.
  const handleForceApply = useCallback(async () => {
    if (!current.sha || current.sha === 'dev' || applying) return
    setApplying(true)
    try {
      // Re-run install needs the tarball coords too — without them, the
      // orchestrator would fall through to git-fetch mode and fail on
      // CLI-installed (no .git) instances. If we don't have them cached
      // (operator hit Re-run before a check), fetch them lazily.
      let downloadUrl = availableDownloadUrl
      let sha256 = availableSha256
      let signature = availableSignature
      if (!downloadUrl || !sha256 || !signature) {
        const c = await csrfFetch('/api/admin/updates/check', { method: 'POST' })
        if (c.ok) {
          const j = (await c.json()) as CheckResponse
          // Prefer currentRelease (matches running SHA — exactly what
          // Re-run wants), fall back to available for the rare path
          // where the operator hits Re-run while an upgrade is also
          // showing.
          const coords = j.currentRelease ?? j.available
          if (coords) {
            downloadUrl = coords.downloadUrl
            sha256 = coords.sha256
            signature = coords.signature
            setAvailableDownloadUrl(downloadUrl)
            setAvailableSha256(sha256)
            setAvailableSignature(signature)
          }
        }
      }
      if (!downloadUrl || !sha256 || !signature) {
        toast.error("Couldn't fetch the release manifest — try Check Now first.")
        return
      }
      const payload: ApplyPayload = {
        targetSha: current.sha,
        downloadUrl,
        sha256,
        signature,
        force: true,
      }
      const r = await csrfFetch('/api/admin/updates/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (r.status === 409) {
        toast.error('An update is already in progress.')
        setModalOpen(true)
        return
      }
      if (!r.ok) {
        toast.error("Couldn't start the re-run — try again.")
        return
      }
      setModalOpen(true)
    } catch {
      toast.error("Couldn't start the re-run — try again.")
    } finally {
      setApplying(false)
    }
  }, [current.sha, applying, toast, availableDownloadUrl, availableSha256, availableSignature])

  const handleSaveSettings = useCallback(async () => {
    if (savingSettings || !dirty) return
    setSavingSettings(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'updates', value: form, version }),
      })
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      setVersion((v) => v + 1)
      setPristine(form)
      toast.success('Update settings saved.')
    } finally {
      setSavingSettings(false)
    }
  }, [savingSettings, dirty, form, version, toast])

  const help = SETTINGS_HELP.updates
  const shapes = SETTINGS_SHAPES.updates ?? []

  const isDev = current.sha === 'dev'

  // Friendly description of what's currently running.
  const currentReleasedPhrase = current.ts
    ? `Last updated ${relativeDays(new Date(current.ts))}`
    : 'Running locally'

  // The actionable "Update available" card. Extracted so it can render
  // FIRST — above the running-version + "what's new in your current
  // version" cards. When an update is waiting, that's the single most
  // important thing on the page; it must not sit buried below the
  // current-version essay.
  const availableUpdateCard = release ? (
    <article
      className={`relative overflow-hidden rounded-2xl border p-6 shadow-[0_24px_60px_-30px_rgba(184,115,51,0.45)] backdrop-blur-sm sm:p-8 ${
        release.isSecurity
          ? 'border-red-300/60 bg-red-50/40'
          : 'border-copper-300/60 bg-cream-50/80'
      }`}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -top-16 -right-12 h-48 w-48 rounded-full blur-3xl ${
          release.isSecurity ? 'bg-red-300/30' : 'bg-copper-300/30'
        }`}
      />
      <header className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p
            className={`flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] ${
              release.isSecurity ? 'text-red-700' : 'text-copper-700'
            }`}
          >
            {release.isSecurity ? (
              <>
                <ShieldAlert className="h-3.5 w-3.5" />
                Security update available
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Update available
              </>
            )}
          </p>
          <h2 className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black">
            {release.title}
          </h2>
          <p className="mt-2 text-xs text-warm-stone">
            {release.versionLabel} · {release.releasedAbsolute}
          </p>
          {/* Pre-staged → installing skips the download entirely. */}
          {stagedReady && (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              Downloaded and ready — installs in seconds
            </p>
          )}
        </div>
        <Button
          type="button"
          onClick={() => void handleApply()}
          disabled={applying || isDev}
          title={
            isDev ? 'In-app updates are disabled while running locally.' : undefined
          }
        >
          <Download className="h-4 w-4" />
          {applying ? 'Starting…' : 'Update now'}
        </Button>
      </header>
      {release.body && (
        <div className="relative mt-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            What&rsquo;s new
          </p>
          <div className="mt-2">
            <ReleaseNotesMarkdown>{release.body}</ReleaseNotesMarkdown>
          </div>
        </div>
      )}
    </article>
  ) : null

  // The "you're up to date" + recovery (Re-run install) card. Only shown
  // once a check has completed and found no newer release. Stays in its
  // natural position below the running-version card.
  const upToDateCard =
    !release && !checking && checkedAt ? (
      <article className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-6 backdrop-blur-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">
                You&rsquo;re up to date
              </h2>
              <p className="mt-1 text-sm text-warm-stone">
                CaveCMS checks for new releases each time you open this page.
              </p>
            </div>
          </div>
          {/* Re-run install — recovery affordance for a stuck migration,
              corrupted .next/ cache, or a previously-interrupted update.
              Same modal flow as a normal update; the orchestrator script
              honours --force by wiping .next/ before rebuild and re-running
              any idempotent migrations. */}
          <div className="flex flex-col items-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleForceApply()}
              disabled={applying || isDev}
              title={
                isDev
                  ? 'Re-run install is disabled while running locally.'
                  : 'Re-run install on the current version. Use this if your last update left the site in a broken state.'
              }
            >
              <RefreshCw className="h-4 w-4" />
              {applying ? 'Starting…' : 'Re-run install'}
            </Button>
            <p className="text-[10px] uppercase tracking-[0.2em] text-warm-stone/70">
              Recovery
            </p>
          </div>
        </div>
      </article>
    ) : null

  return (
    <section className="mt-10 space-y-6">
      {/* Status card — ALWAYS first, above the running-version block. When an
          update is waiting this is the actionable "Update available" card;
          otherwise it's the "You're up to date" / recovery card. Exactly one
          renders (mutually exclusive on `release`); the other is null. */}
      {availableUpdateCard}
      {upToDateCard}

      {/* Current version card */}
      <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        <header className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Your CaveCMS
          </p>
          <h2 className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black">
            {isDev ? 'Running locally' : "You're running CaveCMS"}
          </h2>
          <p className="mt-2 flex items-center gap-2 text-sm text-warm-stone">
            <Clock className="h-3.5 w-3.5" />
            {currentReleasedPhrase}
          </p>
          {checking ? (
            <p className="mt-1 text-xs text-warm-stone">
              Checking for updates…
            </p>
          ) : checkedAt ? (
            <p className="mt-1 text-xs text-warm-stone">
              We check for updates automatically. Last checked{' '}
              {relativeDays(new Date(checkedAt))}.
            </p>
          ) : null}
          {/* Background pre-stage indicator — the only always-visible
              footprint of the auto-download feature. Subtle, non-alarming:
              copper while downloading, emerald when ready. */}
          {stagedReady ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Update downloaded — ready to install
            </p>
          ) : stageState === 'downloading' ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-copper-600">
              <Download className="h-3.5 w-3.5 animate-cavecms-pulse-copper" />
              Downloading the update in the background…
            </p>
          ) : null}
        </header>
      </article>

      {/* What's new in the running version — release notes bundled with the
          build (getCurrentVersionNotes). Absent when no matching notes file. */}
      {currentVersionNotes && (
        <WhatsNewCard
          version={currentVersionNotes.version}
          body={currentVersionNotes.body}
        />
      )}

      {/* Preferences */}
      <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Preferences
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
            How CaveCMS updates
          </h2>
          {help && (
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-warm-stone">
              {help}
            </p>
          )}
        </header>
        <div className="mt-6">
          <ZodForm shapes={shapes} value={form} onChange={setForm} />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSaveSettings()}
            disabled={savingSettings || !dirty}
          >
            {savingSettings ? 'Saving…' : 'Save'}
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setForm(pristine)}
              disabled={savingSettings}
            >
              Undo changes
            </Button>
          )}
          {dirty && (
            <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-copper-700">
              <span className="inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper" />
              Unsaved changes
            </span>
          )}
        </div>
      </article>

      {/* History — append-only log of every update event. Reads from
          /api/admin/audit-log?resource_type=updates&limit=20. */}
      <UpdateHistoryTable />

      <UpdatesProgressModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </section>
  )
}
