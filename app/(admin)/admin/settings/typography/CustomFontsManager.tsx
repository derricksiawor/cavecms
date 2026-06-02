'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, UploadCloud } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/inline-edit/Toast'
import { useCustomFonts } from '@/components/inline-edit/pickers/useCustomFonts'
import { fontCatalogVar, FONT_CATEGORY_LABELS, type FontCategory } from '@/lib/typography/catalog'

const CATS: FontCategory[] = ['serif', 'sans', 'display', 'mono']
// Mirrors the server cap (settings-registry custom_fonts .max + the fonts
// endpoint MAX_FONTS). Keep in sync if the server cap changes.
const MAX_FONTS = 50
const PAGE_SIZE = 8

export function CustomFontsManager() {
  const router = useRouter()
  const toast = useToast()
  const { fonts, reload } = useCustomFonts()
  const [busy, setBusy] = useState(false)
  const [family, setFamily] = useState('')
  const [category, setCategory] = useState<FontCategory>('sans')
  const [weight, setWeight] = useState('400')
  const [weightTo, setWeightTo] = useState('')
  const [page, setPage] = useState(1)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const atCap = fonts.length >= MAX_FONTS
  const pageCount = Math.max(1, Math.ceil(fonts.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = fonts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  async function onUpload() {
    if (busy) return
    if (atCap) {
      toast.error(`You've reached the ${MAX_FONTS}-font limit — delete one to add more.`)
      return
    }
    const file = fileRef.current?.files?.[0]
    if (!file) {
      toast.error('Choose a font file first.')
      return
    }
    if (family.trim().length < 1) {
      toast.error('Give the font a name so you recognise it.')
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('family', family.trim())
      fd.append('category', category)
      const w = Number(weight)
      const to = Number(weightTo)
      if (weightTo.trim() && Number.isFinite(to) && Number.isFinite(w) && to > w) {
        fd.append('weightMin', String(w))
        fd.append('weightMax', String(to))
      } else if (Number.isFinite(w) && w >= 1) {
        fd.append('staticWeight', String(w))
      }
      const r = await csrfFetch('/api/admin/fonts', { method: 'POST', body: fd })
      if (r.status === 413) {
        toast.error('That file is too large — fonts are capped at 5 MB.')
        return
      }
      if (r.status === 400) {
        toast.error("That doesn't look like a .woff2/.woff/.ttf/.otf font.")
        return
      }
      if (!r.ok) {
        toast.error("Upload didn't go through. Try again in a moment.")
        return
      }
      setFamily('')
      setWeightTo('')
      setWeight('400')
      if (fileRef.current) fileRef.current.value = ''
      await reload()
      router.refresh() // re-emit the new @font-face from the root layout
      toast.success('Font uploaded.')
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(key: string, name: string) {
    if (busy) return
    setBusy(true)
    try {
      const r = await csrfFetch(`/api/admin/fonts/${key}`, { method: 'DELETE' })
      if (!r.ok) {
        toast.error('Delete failed — try again.')
        return
      }
      await reload()
      router.refresh()
      toast.success(`"${name}" removed.`)
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black placeholder:text-warm-stone/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70'

  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
          Custom fonts
        </p>
        {fonts.length > 0 && (
          <p
            className={
              'text-[10px] font-semibold uppercase tracking-[0.2em] ' +
              (atCap ? 'text-copper-700' : 'text-warm-stone/70')
            }
          >
            {fonts.length} of {MAX_FONTS}
          </p>
        )}
      </div>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-warm-stone">
        Upload your own typefaces — bought or bespoke (.woff2, .woff, .ttf, .otf,
        up to 5&nbsp;MB). They&rsquo;re stored on your own server and appear in
        every font picker. Nothing is sent to a third party.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void onUpload()
        }}
        className="mt-6 grid gap-4 sm:grid-cols-2"
      >
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Font file
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
            disabled={busy}
            className="block w-full text-sm text-warm-stone file:mr-4 file:rounded-full file:border-0 file:bg-near-black file:px-4 file:py-2 file:text-[11px] file:font-semibold file:uppercase file:tracking-[0.18em] file:text-cream-50 hover:file:bg-copper-700"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Name
          </span>
          <input
            type="text"
            value={family}
            onChange={(e) => setFamily(e.target.value)}
            placeholder="e.g. Söhne, GT Sectra…"
            maxLength={60}
            disabled={busy}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Category
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as FontCategory)}
            disabled={busy}
            className={inputCls}
          >
            {CATS.map((c) => (
              <option key={c} value={c}>
                {FONT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Weight
          </span>
          <input
            type="number"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            min={1}
            max={1000}
            step={100}
            disabled={busy}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Variable up to (optional)
          </span>
          <input
            type="number"
            value={weightTo}
            onChange={(e) => setWeightTo(e.target.value)}
            min={1}
            max={1000}
            step={100}
            placeholder="e.g. 700"
            disabled={busy}
            className={inputCls}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || atCap}
            onClick={() => void onUpload()}
          >
            <UploadCloud className="h-4 w-4" />
            {busy ? 'Uploading…' : 'Upload font'}
          </Button>
          {atCap && (
            <span className="text-[11px] font-medium text-copper-700">
              Limit reached — delete a font to add another.
            </span>
          )}
        </div>
      </form>

      {fonts.length > 0 && (
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
                  Custom · {FONT_CATEGORY_LABELS[f.category]} · {f.format}
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
                aria-label={`Delete ${f.family}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-copper-300/60 px-3 py-1.5 text-xs font-semibold text-copper-700 transition-colors hover:bg-copper-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
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
            Page {safePage} of {pageCount} &middot; {fonts.length} fonts
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
