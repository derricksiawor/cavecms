'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'
import { useGoogleFonts } from '@/components/inline-edit/pickers/useGoogleFonts'
import { fontCatalogVar, FONT_CATEGORY_LABELS } from '@/lib/typography/catalog'

// Mirrors CustomFontsManager's list pattern, for the activated-Google-fonts
// tier. The picker is where operators ACTIVATE a Google font (it self-hosts
// the woff2 on the server); this card just lists what's been activated and
// lets the operator deactivate (delete the row + unlink the file). Bounded by
// pagination like the custom list.
const MAX_FONTS = 100 // mirrors the server cap (settings-registry + endpoint).
const PAGE_SIZE = 8

export function GoogleFontsManager() {
  const router = useRouter()
  const toast = useToast()
  // enabled=true: this card always shows the activated list, so fetch on mount.
  const { activated, reload } = useGoogleFonts(true)
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(1)

  const pageCount = Math.max(1, Math.ceil(activated.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = activated.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  async function onDelete(key: string, name: string) {
    if (busy) return
    setBusy(true)
    try {
      const r = await csrfFetch(`/api/admin/fonts/google/${key}`, { method: 'DELETE' })
      if (!r.ok) {
        toast.error('Deactivate failed — try again.')
        return
      }
      await reload()
      router.refresh() // re-emit (drop) the @font-face from the root layout
      toast.success(`"${name}" deactivated.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
          Google fonts
        </p>
        {activated.length > 0 && (
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-stone/70">
            {activated.length} of {MAX_FONTS}
          </p>
        )}
      </div>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-warm-stone">
        Pick from the full Google Fonts library in any font picker. When you
        choose one, your server downloads it once and serves it from your own
        domain — visitors never load anything from Google, so nothing leaks to
        a third party.
      </p>

      {activated.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-warm-stone/25 bg-cream-50/40 px-4 py-5 text-[13px] text-warm-stone/80">
          No Google fonts activated yet. Open any font picker, expand{' '}
          <span className="font-semibold text-near-black">Google Fonts</span>, and
          choose one — it&rsquo;ll appear here, self-hosted.
        </p>
      ) : (
        <ul className="mt-7 space-y-2 border-t border-warm-stone/15 pt-6">
          {pageItems.map((f) => (
            <li
              key={f.key}
              className="flex items-center gap-4 rounded-xl border border-warm-stone/20 bg-cream-50/70 px-4 py-3"
            >
              <span
                aria-hidden
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-warm-stone/20 bg-cream-100/70 text-xl font-semibold text-near-black"
                style={{ fontFamily: `var(${fontCatalogVar(f.key)})` }}
              >
                Aa
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-[15px] text-near-black"
                  style={{ fontFamily: `var(${fontCatalogVar(f.key)})` }}
                >
                  {f.family}
                </p>
                <p className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-warm-stone/70">
                  Google · {FONT_CATEGORY_LABELS[f.category]} · self-hosted
                  {f.weightRange
                    ? ` · ${f.weightRange[0]}–${f.weightRange[1]}`
                    : f.staticWeight
                      ? ` · ${f.staticWeight}`
                      : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onDelete(f.key, f.family)}
                disabled={busy}
                aria-label={`Deactivate ${f.family}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-copper-300/60 px-3 py-1.5 text-xs font-semibold text-copper-700 transition-colors hover:bg-copper-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Deactivate
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Pagination — only past one page. Keeps the list (and its font-preview
          loads) bounded to PAGE_SIZE regardless of how many fonts exist. */}
      {pageCount > 1 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-warm-stone">
          <span>
            Page {safePage} of {pageCount} &middot; {activated.length} fonts
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="rounded-md border border-warm-stone/30 px-3 py-1.5 font-medium text-near-black transition-colors hover:bg-cream-50 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={safePage >= pageCount}
              className="rounded-md border border-warm-stone/30 px-3 py-1.5 font-medium text-near-black transition-colors hover:bg-cream-50 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
