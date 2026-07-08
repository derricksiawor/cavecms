'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { csrfFetch, readCsrf } from '@/lib/client/csrf'
import { ConfirmModal } from '@/components/inline-edit/ConfirmModal'
import { useToast } from '@/components/inline-edit/Toast'

// EditLockManager — the client half of the advisory per-page edit lock
// (lib/cms/editLock.ts). Mounted once in the admin bar whenever edit mode
// is on; renders nothing until a lock conflict needs a decision.
//
// Lifecycle per page (discovered from the editor's <main data-page-id>,
// same pattern as DraftBar):
//   • acquire on arrival — { locked:true } and editing proceeds silently
//   • heartbeat every few seconds to keep the lock fresh; the same call
//     doubles as the takeover detector — { locked:false } mid-session
//     means someone took over, so the "taken over" prompt appears
//   • while another operator holds the page, the blocking prompt offers
//     Preview instead / Take over, and keeps polling so the page unlocks
//     by itself the moment they finish
//   • release on exit (soft-nav away, edit mode off, tab close) so the
//     next editor never waits out the stale-lock TTL
//
// Fallback by construction: a crashed browser simply stops heartbeating
// and the lock goes stale server-side — nothing to clean up.

const FALLBACK_HEARTBEAT_MS = 5_000

interface Holder {
  userId: number
  name: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'held' }
  | { kind: 'blocked'; holder: Holder }
  | { kind: 'lost'; holder: Holder }

interface LockResponse {
  locked?: boolean
  holder?: Holder | null
  heartbeatMs?: number
}

export function EditLockManager() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const toast = useToast()
  const [pageId, setPageId] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  // Latest phase for interval/visibility handlers without re-binding.
  const phaseRef = useRef<Phase>(phase)
  phaseRef.current = phase
  const heartbeatMsRef = useRef(FALLBACK_HEARTBEAT_MS)

  // Discover the page id from the editor's <main data-page-id> — the admin
  // bar renders in the root layout, outside the page's React tree (mirrors
  // DraftBar's discovery).
  useEffect(() => {
    let raf = 0
    const read = () => {
      const raw = document
        .querySelector('[data-page-id]')
        ?.getAttribute('data-page-id')
      const n = raw ? Number(raw) : NaN
      setPageId(Number.isInteger(n) && n > 0 ? n : null)
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        read()
      })
    }
    read()
    const obs = new MutationObserver(schedule)
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-page-id'],
    })
    return () => {
      obs.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const post = useCallback(
    async (
      id: number,
      action: 'acquire' | 'takeover' | 'release',
    ): Promise<LockResponse | null> => {
      try {
        const r = await csrfFetch(`/api/cms/pages/${id}/edit-lock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (!r.ok) return null
        const j = (await r.json()) as LockResponse
        if (typeof j.heartbeatMs === 'number' && j.heartbeatMs >= 1_000) {
          heartbeatMsRef.current = j.heartbeatMs
        }
        return j
      } catch {
        // Transient network trouble — keep the last-known phase; the lock's
        // server-side TTL is generous enough to ride out a few misses.
        return null
      }
    },
    [],
  )

  // Apply an acquire/heartbeat result to the phase machine.
  const applyResult = useCallback(
    (j: LockResponse | null) => {
      if (!j) return
      const prev = phaseRef.current
      if (j.locked === true) {
        if (prev.kind === 'blocked') {
          toast.success(`${prev.holder.name} finished editing — the page is yours.`)
        }
        if (prev.kind !== 'held') setPhase({ kind: 'held' })
        return
      }
      if (j.locked === false && j.holder) {
        // Mid-session loss is a takeover; a conflict on arrival is a block.
        setPhase(
          prev.kind === 'held'
            ? { kind: 'lost', holder: j.holder }
            : prev.kind === 'lost'
              ? prev
              : { kind: 'blocked', holder: j.holder },
        )
      }
    },
    [toast],
  )

  // Acquire on page arrival + heartbeat while relevant. While 'blocked' the
  // same tick keeps trying, so the page unlocks itself the moment the other
  // operator leaves. While 'lost' we stop — grabbing the lock back is the
  // operator's explicit call via the prompt, never automatic.
  useEffect(() => {
    if (!pageId) {
      setPhase({ kind: 'idle' })
      return
    }
    let cancelled = false
    const tick = async () => {
      if (cancelled || phaseRef.current.kind === 'lost') return
      applyResult(await post(pageId, 'acquire'))
    }
    void tick()
    const t = setInterval(() => void tick(), heartbeatMsRef.current)
    // Returning to the tab re-checks immediately — a takeover that happened
    // while the tab was backgrounded surfaces the instant they come back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)

    // Best-effort release when the tab closes mid-edit. keepalive lets the
    // request outlive the page; the CSRF token is cookie-mirrored so it's
    // readable synchronously. If it doesn't land, the TTL frees the lock.
    const onPageHide = () => {
      if (phaseRef.current.kind !== 'held') return
      void fetch(`/api/cms/pages/${pageId}/edit-lock`, {
        method: 'POST',
        keepalive: true,
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': readCsrf(),
        },
        body: JSON.stringify({ action: 'release' }),
      }).catch(() => {})
    }
    window.addEventListener('pagehide', onPageHide)

    return () => {
      cancelled = true
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pagehide', onPageHide)
      // Soft-nav away / edit mode off — free the page for the next editor.
      if (phaseRef.current.kind === 'held') void post(pageId, 'release')
    }
  }, [pageId, post, applyResult])

  // "Preview instead" — leave edit mode entirely (cookie off + strip any
  // ?edit=1 URL override, mirroring EditModePill) so the operator reads the
  // page without holding or fighting over the lock.
  const previewInstead = useCallback(async () => {
    setBusy(true)
    try {
      const res = await csrfFetch('/api/cms/edit-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: false }),
      })
      if (!res.ok) {
        toast.error("That didn't work. Try again in a moment.")
        return
      }
      setPhase({ kind: 'idle' })
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      if (params.has('edit')) {
        params.delete('edit')
        const qs = params.toString()
        router.replace(qs.length > 0 ? `${pathname}?${qs}` : pathname)
      } else {
        router.refresh()
      }
    } catch {
      toast.error("We can't reach the server right now.")
    } finally {
      setBusy(false)
    }
  }, [router, pathname, searchParams, toast])

  const takeover = useCallback(async () => {
    if (!pageId) return
    setBusy(true)
    try {
      const j = await post(pageId, 'takeover')
      if (j?.locked === true) {
        setPhase({ kind: 'held' })
        // Pull the freshest draft state — the previous editor may have
        // changed things moments ago.
        router.refresh()
        window.dispatchEvent(new Event('cavecms:draft-changed'))
      } else {
        toast.error("Couldn't take over. Try again in a moment.")
      }
    } finally {
      setBusy(false)
    }
  }, [pageId, post, router, toast])

  // Portal to <body> — this component lives inside the admin bar, whose
  // backdrop-blur makes the bar the containing block for fixed-position
  // descendants (same trap Toast.tsx documents). Un-portaled, the modal
  // pins to the bar's box at the top of the screen, clipped.
  if (phase.kind === 'blocked') {
    return createPortal(
      <ConfirmModal
        title={`${phase.holder.name} is editing this page`}
        description={
          <>
            They&apos;re working on it right now — you both share one draft, so
            editing together would overwrite each other. Take over to edit now
            (they&apos;ll be asked to step back), or preview the page instead.
          </>
        }
        confirmLabel="Take over"
        cancelLabel="Preview instead"
        busy={busy}
        ariaLabel="Someone is already editing this page"
        onCancel={previewInstead}
        onConfirm={takeover}
      />,
      document.body,
    )
  }

  if (phase.kind === 'lost') {
    return createPortal(
      <ConfirmModal
        title={`${phase.holder.name} took over this page`}
        description={
          <>
            They&apos;re editing it now. Everything you changed is already saved
            in the page&apos;s draft — nothing is lost. You can take the page
            back, or preview it while they work.
          </>
        }
        confirmLabel="Take back"
        cancelLabel="Preview instead"
        busy={busy}
        ariaLabel="Another editor took over this page"
        onCancel={previewInstead}
        onConfirm={takeover}
      />,
      document.body,
    )
  }

  return null
}
