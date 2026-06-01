'use client'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useMediaPicker, type MediaRef } from './MediaPickerProvider'
import { readCsrf, refreshCsrf } from '@/lib/client/csrf'
import { registerUploadedMedia } from '@/lib/cms/uploadedMediaRegistry'
import { Input } from '@/components/ui/Input'

// Polished media field. When empty: shows a copper drag-and-drop zone
// that accepts a file drop or opens the gallery picker on click. When
// filled: shows the thumbnail, inline alt-text editor, and Replace /
// Remove actions. PDF accept variant shows a doc tile + filename.
//
// Drop-to-upload: goes straight through the same CSRF-protected
// /api/cms/media endpoint as the modal Upload tab. Alt text is
// captured inline after upload (the editor commits when they tab
// away or hit Enter).
export function MediaPicker({
  value,
  onChange,
  label = 'Image',
  accept = 'image',
  help,
  thumbUrl,
}: {
  value: MediaRef | undefined
  onChange: (m: MediaRef | undefined) => void
  label?: string
  accept?: 'image' | 'pdf'
  help?: string
  /** Optional thumbnail URL the parent already resolved (SSR). */
  thumbUrl?: string | null
}) {
  const { open, resolveThumb, resolveThumbAsync } = useMediaPicker()
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const altInputRef = useRef<HTMLInputElement | null>(null)
  const [altDraft, setAltDraft] = useState('')
  const [resolvedThumb, setResolvedThumb] = useState<string | null>(null)

  // Sync alt-draft on value change. Thumbnail is looked up via the
  // shared MediaPickerProvider cache first; on a miss we fall back to
  // an async fetch against /api/cms/media/<id> so the thumb appears
  // even when the picker modal has never been opened (the common case
  // for a section/column drawer with a pre-set backgroundImage).
  useEffect(() => {
    if (!value) {
      setResolvedThumb(null)
      return
    }
    setAltDraft(value.alt ?? '')
    const cached = resolveThumb(value.media_id)
    if (cached) {
      setResolvedThumb(cached)
      return
    }
    // Cache miss — fetch + populate. Cancellation flag protects against
    // a fast value change resolving an older fetch onto the new value's
    // slot.
    let cancelled = false
    setResolvedThumb(null)
    void resolveThumbAsync(value.media_id).then((url) => {
      if (!cancelled) setResolvedThumb(url)
    })
    return () => {
      cancelled = true
    }
  }, [value, resolveThumb, resolveThumbAsync])

  const finalThumb = thumbUrl ?? resolvedThumb

  const acceptMime =
    accept === 'pdf'
      ? 'application/pdf'
      : 'image/jpeg,image/png,image/webp,image/avif'

  const uploadFile = async (file: File) => {
    if (uploading) return
    setError(null)
    if (accept === 'pdf' && !file.type.includes('pdf')) {
      setError('Please pick a PDF file here.')
      return
    }
    if (accept === 'image' && !file.type.startsWith('image/')) {
      setError('Please pick an image file here.')
      return
    }
    setUploading(true)
    setProgress(0)
    // Provisional alt fallback — the user can refine it inline after the
    // upload completes. If we let the user upload without alt, the API
    // would 400; so we pass the filename as a placeholder alt and they
    // immediately get to edit it.
    const provisionalAlt = file.name.replace(/\.[^.]+$/, '').slice(0, 320)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('alt', provisionalAlt)
      // XHR for upload progress — fetch() doesn't expose it.
      const result = await xhrUpload<{ id: number }>('/api/cms/media', fd, (p) =>
        setProgress(p),
      )
      // Register the freshly-uploaded media so a section/column background
      // keyed on its id resolves its URL immediately — the SSR media map
      // doesn't include it, so without this the background only appears after
      // a full refresh. Variants are generated synchronously by the upload, so
      // this GET returns them. Best-effort: on failure we still commit the
      // value (it shows on the next refresh, the prior behaviour — no
      // regression).
      try {
        const mr = await fetch(`/api/cms/media/${result.id}`, {
          credentials: 'same-origin',
        })
        if (mr.ok) {
          const m = (await mr.json()) as {
            variants?: Record<string, string> | null
          }
          registerUploadedMedia(result.id, m.variants ?? null)
        }
      } catch {
        /* best-effort — background just shows after the next refresh */
      }
      onChange({ media_id: result.id, alt: provisionalAlt })
      setAltDraft(provisionalAlt)
      // Focus the alt input so the user can refine the alt text.
      window.setTimeout(() => altInputRef.current?.focus(), 80)
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't upload that file. Try again.")
    } finally {
      setUploading(false)
      setProgress(0)
    }
  }

  const commitAlt = () => {
    if (!value) return
    const next = altDraft.trim().slice(0, 320)
    if (next && next !== value.alt) {
      onChange({ ...value, alt: next })
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void uploadFile(file)
  }

  const hasValue = !!value
  const isPdf = accept === 'pdf'

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-near-black">{label}</p>
      {!hasValue ? (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !uploading && open(value, (m) => onChange(m))}
          className={clsx(
            'group relative flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition-all duration-quick cursor-pointer min-h-[160px]',
            dragOver
              ? 'border-copper-500 bg-copper-50 scale-[0.99]'
              : 'border-warm-stone/30 bg-cream-50/60 hover:border-copper-400 hover:bg-cream-50',
          )}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              open(value, (m) => onChange(m))
            }
          }}
        >
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-copper-100 text-copper-700">
            {isPdf ? <PdfIcon /> : <UploadIcon />}
          </span>
          <p className="text-sm font-medium text-near-black">
            {dragOver
              ? 'Drop to upload'
              : isPdf
                ? 'Drop a PDF here or click to choose'
                : 'Drop an image here or click to choose'}
          </p>
          <p className="text-[11px] text-warm-stone">
            {isPdf ? 'PDF, up to about 25 MB' : 'JPG, PNG, WebP, or AVIF'}
          </p>
          {help && (
            <p className="mt-2 text-[11px] text-warm-stone max-w-md">{help}</p>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={acceptMime}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadFile(f)
              e.target.value = ''
            }}
          />
          {uploading && (
            <div className="absolute inset-x-6 bottom-3 h-1.5 overflow-hidden rounded-full bg-cream-200">
              <div
                className="h-full bg-copper-500 transition-[width] duration-quick"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={clsx(
            'group flex flex-col sm:flex-row items-stretch gap-4 rounded-2xl border bg-cream-50/60 p-4 transition-all',
            dragOver
              ? 'border-copper-500 bg-copper-50'
              : 'border-warm-stone/20 hover:border-warm-stone/40',
          )}
        >
          <div className="relative h-32 w-full sm:w-32 shrink-0 overflow-hidden rounded-xl bg-cream-100 flex items-center justify-center">
            {isPdf ? (
              <div className="flex flex-col items-center gap-1 text-warm-stone">
                <PdfIcon />
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">PDF</span>
              </div>
            ) : finalThumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={finalThumb} alt={value.alt || ''} className="h-full w-full object-cover" />
            ) : (
              <div className="cavecms-skeleton h-full w-full" />
            )}
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            {!isPdf && (
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
                  Image description
                </span>
                <Input
                  ref={altInputRef}
                  value={altDraft}
                  onChange={(e) => setAltDraft(e.target.value)}
                  onBlur={commitAlt}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                  placeholder="Describe what's in the image — helps people who can't see it and Google"
                  className="mt-1"
                  maxLength={320}
                />
              </label>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => open(value, (m) => onChange(m))}
                className="inline-flex h-9 items-center rounded-full border border-warm-stone/30 px-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-near-black hover:border-copper-400 transition-colors"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => onChange(undefined)}
                className="inline-flex h-9 items-center rounded-full border border-red-300/60 px-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-red-700 hover:border-red-500 hover:bg-red-50/40 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

// XHR-based uploader that exposes progress. fetch() does not expose
// upload progress events; XHR does. CSRF token is read from the cookie
// (refreshed if absent via /api/csrf).
async function xhrUpload<T>(
  url: string,
  body: FormData,
  onProgress: (pct: number) => void,
): Promise<T> {
  let token = readCsrf()
  if (!token) {
    try {
      token = await refreshCsrf()
    } catch {
      throw new Error('Your session expired — refresh the page and try again.')
    }
  }
  const send = (t: string): Promise<{ status: number; text: string }> =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', url, true)
      xhr.withCredentials = true
      xhr.setRequestHeader('x-csrf-token', t)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText })
      // Explicit abort() on error/timeout — without it, iOS Safari's
      // network stack can leave the underlying connection open until
      // GC runs (variable timing). abort() releases the socket now so
      // a quick retry doesn't hit an orphan handle.
      xhr.onerror = () => {
        xhr.abort()
        reject(
          new Error(
            "We can't reach the server right now. Check your connection and try again.",
          ),
        )
      }
      xhr.ontimeout = () => {
        xhr.abort()
        reject(
          new Error(
            'The upload took too long. Try again with a smaller file or a stronger connection.',
          ),
        )
      }
      xhr.timeout = 120_000
      xhr.send(body)
    })

  let res = await send(token)
  if (res.status === 403) {
    // CSRF rejected — refresh and retry exactly once, mirroring csrfFetch.
    token = await refreshCsrf()
    res = await send(token)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error("That upload didn't go through. Try again in a moment.")
  }
  try {
    return JSON.parse(res.text) as T
  } catch {
    throw new Error('The server replied with something unexpected. Refresh the page and try again.')
  }
}

function UploadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}
function PdfIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <text x="8" y="18" fontSize="6" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
    </svg>
  )
}
