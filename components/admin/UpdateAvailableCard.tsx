'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Download, ShieldAlert, Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { csrfFetch } from '@/lib/client/csrf'
import { humaniseRelease, type HumanRelease } from '@/lib/updates/humaniseRelease'
import { ReleaseNotesMarkdown } from '@/components/admin/ReleaseNotesMarkdown'

// Fades the clipped tail of the notes preview by masking the content itself to
// transparent — a mask blends into the translucent card + the dashboard's warm
// page-gradient behind it. The old solid-colour gradient overlay (from-cream-50)
// painted a mismatched grey band because the card is bg-cream-50/80 over that
// gradient, not solid cream. Same technique as WhatsNewCard.
const NOTES_FADE_MASK =
  'linear-gradient(to bottom, #000 0%, #000 calc(100% - 48px), transparent 100%)'

// Dashboard hero card — renders when an update is available. Lives at
// the top of /admin so an operator who never visits Settings → Updates
// still sees the prompt the first time they log in.
//
// Copy rules (this file is the most-visible Updates surface):
//   - NO git SHAs anywhere.
//   - NO raw commit-message prefixes (`feat:` / `(#1234)` etc.).
//   - Talk in "Released today" / "Released 3 days ago" terms.
//   - The release title is the cleaned first line of the changelog.
//   - The body is shown as plain prose, truncated to 4 lines.

interface CheckResponse {
  current: { sha: string; ts: string | null }
  available: {
    sha: string
    ts: string
    changelog: string
    isSecurity: boolean
  } | null
}

export function UpdateAvailableCard({
  currentSha,
}: {
  /** Running CaveCMS revision, pre-resolved server-side. When `'dev'`,
   *  we skip the /check call entirely — no point burning a GitHub
   *  rate-budget slot per dashboard load on a local-development
   *  install that can't actually apply updates. */
  currentSha: string
}) {
  const [release, setRelease] = useState<HumanRelease | null>(null)
  const [hide, setHide] = useState(false)
  const [notesOverflow, setNotesOverflow] = useState(false)

  useEffect(() => {
    if (currentSha === 'dev') {
      setHide(true)
      return
    }
    let cancelled = false
    async function check() {
      try {
        const r = await csrfFetch('/api/admin/updates/check', { method: 'POST' })
        if (cancelled || !r.ok) return
        const j = (await r.json()) as CheckResponse
        if (!j.available) {
          setHide(true)
          return
        }
        setRelease(humaniseRelease(j.available))
      } catch {
        /* swallow — card just won't render. */
      }
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [currentSha])

  if (hide || !release) return null

  const security = release.isSecurity

  // Only fade the preview tail when the notes actually overflow the cap — a
  // short release renders in full with no misleading "there's more" fade.
  // Callback ref (not useEffect): measured here so the hook rules aren't
  // violated by running after the early `return null` above.
  function measureNotes(el: HTMLDivElement | null) {
    if (el) setNotesOverflow(el.scrollHeight > el.clientHeight + 4)
  }

  return (
    <motion.article
      className={`relative mb-10 overflow-hidden rounded-2xl border p-6 backdrop-blur-sm sm:p-8 ${
        security
          ? 'border-red-300/60 bg-red-50/40'
          : 'border-copper-300/60 bg-cream-50/80'
      }`}
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      // Soft entrance — card "lifts" into place, drawing the eye
      // without feeling abrupt. Spring shape feels organic.
      transition={{ type: 'spring', stiffness: 240, damping: 26, mass: 0.7 }}
    >
      <motion.div
        aria-hidden="true"
        className={`pointer-events-none absolute -top-16 -right-12 h-48 w-48 rounded-full blur-3xl ${
          security ? 'bg-red-300/30' : 'bg-copper-300/30'
        }`}
        animate={{
          scale: [1, 1.08, 1],
          opacity: [0.7, 1, 0.7],
        }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
      <header className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p
            className={`flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] ${
              security ? 'text-red-700' : 'text-copper-700'
            }`}
          >
            {security ? (
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
          <h2 className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black sm:text-3xl">
            {release.title}
          </h2>
          <p className="mt-2 text-xs text-warm-stone">
            {release.versionLabel} · {release.releasedAbsolute}
          </p>
        </div>
        <Link
          href="/admin/settings/updates"
          className="inline-flex items-center gap-2 rounded-full bg-near-black px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-cream-50 transition-all hover:bg-copper-700 hover:-translate-y-px"
        >
          <Download className="h-4 w-4" />
          Review and update
        </Link>
      </header>
      {release.body.trim() && (
        // Fade the clipped tail via a mask on the content itself (blends into
        // the translucent card + page gradient) — the full notes live on the
        // updates page. See NOTES_FADE_MASK above.
        <div
          ref={measureNotes}
          className="mt-5 max-h-32 overflow-hidden"
          style={
            notesOverflow
              ? { maskImage: NOTES_FADE_MASK, WebkitMaskImage: NOTES_FADE_MASK }
              : undefined
          }
        >
          <ReleaseNotesMarkdown>{release.body}</ReleaseNotesMarkdown>
        </div>
      )}
    </motion.article>
  )
}
