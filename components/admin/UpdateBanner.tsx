'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Sparkles, ShieldAlert, X, Download } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { csrfFetch } from '@/lib/client/csrf'
import { humaniseRelease, type HumanRelease } from '@/lib/updates/humaniseRelease'
import { UpdatesProgressModal } from './UpdatesProgressModal'

// Sticky "update available" banner that lives below the admin Topbar
// across every admin page. Stays out of the way (cream + copper border,
// no flashing) but always one click away from kicking off an update.
//
// Copy rules: NO SHAs in the banner. We say "A new version is available"
// or "Security update available" and let the operator click "Details" to
// see the full release notes on /admin/settings/updates.
//
// Behaviour:
//   - On mount: POST /api/admin/updates/check once. We do this in the
//     banner (not via a long-running polling timer) because the admin
//     UI is short-lived per pageview anyway.
//   - Hidden when no update is available OR when the operator dismissed
//     it (per-release sessionStorage key — dismissing today's release
//     does not hide tomorrow's once it arrives).
//   - Hidden in local dev (current.sha === 'dev') so the dev never
//     sees a stale "deployed prod is behind upstream" banner.

const DISMISS_KEY_PREFIX = 'cavecms.updates.banner.dismissed.'

interface CheckResponse {
  current: { sha: string; ts: string | null }
  available: {
    sha: string
    ts: string
    changelog: string
    isSecurity: boolean
    // Tarball coords + signature the apply route REQUIRES (strict schema,
    // signed updates since 0.1.45). The banner must forward all three or
    // every "Update now" 400s — same gap that broke UpdatesClient.
    downloadUrl: string
    sha256: string
    signature: string | null
  } | null
}

interface StatusResponse {
  state: string
}

export function UpdateBanner({
  currentSha: initialCurrentSha = 'dev',
}: {
  /** Running CaveCMS revision, pre-resolved server-side. When
   *  `'dev'`, we skip the /status + /check calls — local dev never
   *  shows an update banner. */
  currentSha?: string
}) {
  const [release, setRelease] = useState<HumanRelease | null>(null)
  const [releaseKey, setReleaseKey] = useState<string>('')
  // The raw upstream SHA is held privately for the apply call ONLY.
  // Operator-facing UI never renders it; this is a transport detail.
  const [availableShaPrivate, setAvailableShaPrivate] = useState<string | null>(null)
  const [availableDownloadUrl, setAvailableDownloadUrl] = useState<string | null>(null)
  const [availableSha256, setAvailableSha256] = useState<string | null>(null)
  const [availableSignature, setAvailableSignature] = useState<string | null>(null)
  const [currentSha, setCurrentSha] = useState<string>(initialCurrentSha)
  const [dismissed, setDismissed] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [inProgress, setInProgress] = useState(false)

  useEffect(() => {
    if (initialCurrentSha === 'dev') return
    let cancelled = false
    async function bootstrap() {
      try {
        const s = await fetch('/api/admin/updates/status', {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000),
        })
        if (!cancelled && s.ok) {
          const sj = (await s.json()) as StatusResponse
          if (
            sj.state === 'preflight' ||
            sj.state === 'updating' ||
            sj.state === 'restarting'
          ) {
            setInProgress(true)
            return
          }
        }
      } catch {
        /* ignore */
      }

      try {
        const r = await csrfFetch('/api/admin/updates/check', { method: 'POST' })
        if (!cancelled && r.ok) {
          const j = (await r.json()) as CheckResponse
          setCurrentSha(j.current.sha)
          if (j.available) {
            setRelease(humaniseRelease(j.available))
            // Per-release dismissal key — uses the timestamp (opaque
            // to operators) so dismissing today's release doesn't
            // hide tomorrow's.
            setReleaseKey(j.available.ts)
            setAvailableShaPrivate(j.available.sha)
            setAvailableDownloadUrl(j.available.downloadUrl)
            setAvailableSha256(j.available.sha256)
            setAvailableSignature(j.available.signature)
          } else {
            setRelease(null)
            setAvailableShaPrivate(null)
            setAvailableDownloadUrl(null)
            setAvailableSha256(null)
            setAvailableSignature(null)
          }
        }
      } catch {
        /* network blip — banner just won't show. */
      }
    }
    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [initialCurrentSha])

  useEffect(() => {
    if (!releaseKey) return
    try {
      const v = sessionStorage.getItem(`${DISMISS_KEY_PREFIX}${releaseKey}`)
      setDismissed(v === '1')
    } catch {
      setDismissed(false)
    }
  }, [releaseKey])

  const handleDismiss = useCallback(() => {
    if (!releaseKey) return
    try {
      sessionStorage.setItem(`${DISMISS_KEY_PREFIX}${releaseKey}`, '1')
    } catch {
      /* private mode */
    }
    setDismissed(true)
  }, [releaseKey])

  const handleUpdate = useCallback(async () => {
    if (
      starting ||
      !availableShaPrivate ||
      !availableDownloadUrl ||
      !availableSha256 ||
      !availableSignature
    )
      return
    setStarting(true)
    try {
      const r = await csrfFetch('/api/admin/updates/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targetSha: availableShaPrivate,
          downloadUrl: availableDownloadUrl,
          sha256: availableSha256,
          signature: availableSignature,
        }),
      })
      if (r.status === 409 || r.ok) {
        setModalOpen(true)
      }
    } finally {
      setStarting(false)
    }
  }, [starting, availableShaPrivate, availableDownloadUrl, availableSha256, availableSignature])

  if (inProgress) {
    return (
      <>
        <motion.div
          className="sticky top-0 z-30 border-b border-copper-300/50 bg-copper-50/85 px-6 py-2.5 backdrop-blur-md sm:px-10 lg:px-12"
          initial={{ y: -32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-xs font-medium text-near-black">
              <motion.span
                animate={{ rotate: [0, -6, 6, -6, 0] }}
                transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 2 }}
                className="inline-flex"
              >
                <Download className="h-3.5 w-3.5 text-copper-700" />
              </motion.span>
              An update is being installed.
            </p>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700 transition-colors hover:text-copper-800"
            >
              View progress
            </button>
          </div>
        </motion.div>
        <UpdatesProgressModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
        />
      </>
    )
  }

  if (currentSha === 'dev' || !release || dismissed) return null

  const security = release.isSecurity

  return (
    <>
      <AnimatePresence>
        <motion.div
          key="banner"
          className={`sticky top-0 z-30 border-b backdrop-blur-md sm:px-10 lg:px-12 ${
            security
              ? 'border-red-300/60 bg-red-50/80'
              : 'border-copper-300/50 bg-copper-50/85'
          } px-6 py-2.5`}
          role="status"
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
        >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-xs font-medium text-near-black">
            {security ? (
              <ShieldAlert className="h-3.5 w-3.5 text-red-700" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-copper-700" />
            )}
            <span>
              {security
                ? 'A security update is ready to install.'
                : 'A new version of CaveCMS is ready to install.'}
            </span>
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleUpdate()}
              disabled={starting}
              className="rounded-full bg-near-black px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-cream-50 hover:bg-copper-700 disabled:opacity-50"
            >
              {starting ? 'Starting…' : 'Update now'}
            </button>
            <Link
              href="/admin/settings/updates"
              className="text-[11px] font-medium text-copper-700 hover:text-copper-800"
            >
              See what&rsquo;s new
            </Link>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="rounded-full p-1 text-warm-stone transition-all hover:bg-warm-stone/10 hover:text-near-black active:scale-90"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        </motion.div>
      </AnimatePresence>
      <UpdatesProgressModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </>
  )
}
