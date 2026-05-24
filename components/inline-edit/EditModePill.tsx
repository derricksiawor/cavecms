'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Pencil, Save, Loader2 } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'

export function EditModePill({ on }: { on: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const toggle = async () => {
    setBusy(true); setErr(null)
    try {
      const res = await csrfFetch('/api/cms/edit-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: !on }),
      })
      if (!res.ok) {
        setErr(res.status === 401 ? 'Your session expired — refresh the page and sign in again.' : "That didn't work. Try again in a moment.")
        return
      }
      // When toggling OFF, also strip the `?edit=1` URL override so the
      // cleared cookie becomes the sole source of truth. Without this,
      // resolveEditableMode's URL fallback (canEdit + ?edit=1) would
      // keep the page rendering editable even after the cookie is
      // cleared — operator presses "Stop editing", the page stays in
      // edit mode, gesture looks broken.
      if (on) {
        const params = new URLSearchParams(searchParams?.toString() ?? '')
        if (params.has('edit')) {
          params.delete('edit')
          const qs = params.toString()
          const target = qs.length > 0 ? `${pathname}?${qs}` : pathname
          startTransition(() => { router.replace(target) })
          return
        }
      }
      startTransition(() => { router.refresh() })
    } catch (e) {
      setErr(e instanceof Error && e.name === 'AbortError'
        ? 'That took too long. Try again.'
        : "We can't reach the server right now. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }
  return (
    // Hidden below the md breakpoint: inline-editing on a 375px viewport
    // is impractical (drawer can't fit, drag handles are unusable), and
    // the pill competes with the public MobileCtaBar for the same screen
    // real estate. Operators editing CMS content do it on desktop or
    // tablet; mobile public visitors should see the CTA bar uncovered.
    <div className="hidden md:flex fixed bottom-6 right-6 z-30 flex-col items-end gap-2">
      {err && <p className="bg-red-600 text-white text-xs px-3 py-1 rounded shadow">{err}</p>}
      <div className="relative">
        {/* Ambient champagne glow — soft halo so the pill reads as
            "lit from behind" against any page background. Larger inset
            than the pulse ring so the glow extends beyond the ripple. */}
        <span
          aria-hidden
          className="lx-glow-champagne pointer-events-none absolute -inset-5 rounded-full"
        />
        <button
          onClick={toggle}
          disabled={busy}
          className="lx-pulse-champagne relative inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-champagne via-champagne to-antique-gold px-5 py-2.5 text-sm font-semibold tracking-wide text-obsidian ring-1 ring-champagne/70 transition-[filter,transform] duration-300 hover:brightness-110 active:scale-[0.98] disabled:cursor-wait disabled:opacity-80"
        >
          {on ? (
            busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Saving…
              </>
            ) : (
              <>
                <Save className="h-4 w-4" strokeWidth={2.4} aria-hidden />
                Stop editing
              </>
            )
          ) : (
            <>
              <Pencil className="h-4 w-4" strokeWidth={2.4} aria-hidden />
              Start editing this page
            </>
          )}
        </button>
      </div>
    </div>
  )
}
