'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { csrfFetch, readCsrf, refreshCsrf } from '@/lib/client/csrf'
import { Drawer } from '@/components/ui/Drawer'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { type MediaRef, useMediaPicker } from './MediaPickerProvider'

interface MediaRow {
  id: number
  alt_text: string
  mime_type: string
  variants: { thumb?: string; md?: string; lg?: string; og?: string } | null
}

interface UploadJob {
  id: string
  file: File
  alt: string
  progress: number
  status: 'queued' | 'uploading' | 'done' | 'error'
  error?: string
  mediaId?: number
}

let jobIdSeq = 1

// Polished media drawer: tabs for Library + Upload, gallery with
// search, lazy-loaded thumbnails, drag-and-drop upload zone with
// per-file progress, inline alt-text capture before commit.
export function MediaPickerModal({
  current,
  onPick,
  onClose,
}: {
  current?: MediaRef
  onPick: (m: MediaRef) => void
  onClose: () => void
}) {
  const { cacheThumbs } = useMediaPicker()
  const [tab, setTab] = useState<'library' | 'upload'>('library')
  const [items, setItems] = useState<MediaRow[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [jobs, setJobs] = useState<UploadJob[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const cancelledRef = useRef(false)
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
    }
  }, [])
  const inFlightRef = useRef(false)

  async function loadPage(c?: number | null) {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    try {
      const url = c ? `/api/cms/media?cursor=${c}` : '/api/cms/media'
      const r = await fetch(url, {
        credentials: 'include',
        signal: AbortSignal.timeout(30_000),
      })
      if (cancelledRef.current) return
      if (!r.ok) {
        setError("We couldn't load your files. Try again in a moment.")
        return
      }
      const j = (await r.json()) as { items: MediaRow[]; nextCursor: number | null }
      if (cancelledRef.current) return
      setItems((prev) => (c ? [...prev, ...j.items] : j.items))
      setCursor(j.nextCursor)
      // Push thumbnails into the shared cache so field-level previews
      // (MediaPicker) can render without an extra round trip.
      cacheThumbs(j.items)
    } catch (e) {
      if (cancelledRef.current) return
      if (e instanceof Error && e.name === 'AbortError') {
        setError('That took too long. Try again in a moment.')
      } else {
        setError("We can't reach the server right now. Check your connection and try again.")
      }
    } finally {
      if (!cancelledRef.current) setBusy(false)
      inFlightRef.current = false
    }
  }

  useEffect(() => {
    void loadPage(null)
    // Mount-only: intentional empty dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Local-only filter — the server endpoint doesn't ship a search route
  // yet, but in-memory filtering on already-loaded items covers the
  // common case for libraries up to several hundred items.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (m) => m.alt_text.toLowerCase().includes(q) || String(m.id).includes(q),
    )
  }, [items, query])

  const queueFiles = (files: FileList | File[]) => {
    const arr = Array.from(files)
    const next = arr.map<UploadJob>((file) => ({
      id: `j${jobIdSeq++}`,
      file,
      alt: file.name.replace(/\.[^.]+$/, '').slice(0, 320),
      progress: 0,
      status: 'queued',
    }))
    setJobs((prev) => [...prev, ...next])
    setTab('upload')
  }

  const updateJob = (id: string, patch: Partial<UploadJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)))
  }

  const removeJob = (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  const runJob = async (job: UploadJob) => {
    if (!job.alt.trim()) {
      updateJob(job.id, { status: 'error', error: 'Please add a short description of the image first.' })
      return
    }
    updateJob(job.id, { status: 'uploading', progress: 0, error: undefined })
    try {
      const fd = new FormData()
      fd.append('file', job.file)
      fd.append('alt', job.alt.trim())
      const result = await xhrUpload<{ id: number }>(
        '/api/cms/media',
        fd,
        (p) => updateJob(job.id, { progress: p }),
      )
      updateJob(job.id, { status: 'done', progress: 100, mediaId: result.id })
      // Push freshly uploaded item to the top of the library cache.
      setItems((prev) => [
        {
          id: result.id,
          alt_text: job.alt.trim(),
          mime_type: job.file.type,
          variants: null,
        },
        ...prev,
      ])
    } catch (e) {
      updateJob(job.id, {
        status: 'error',
        error: e instanceof Error ? e.message : "We couldn't upload that file. Try again.",
      })
    }
  }

  const uploadAll = async () => {
    const queued = jobs.filter((j) => j.status === 'queued')
    for (const j of queued) {
      // Sequential to keep server fair — concurrent uploads risk hitting
      // the rate limiter and burning the user's quota on retries.
      await runJob(j)
    }
  }

  return (
    <Drawer open onClose={onClose} width="lg">
      <header className="flex items-center justify-between border-b border-warm-stone/20 px-6 py-5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Your files
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
            {tab === 'library' ? 'Pick a file' : 'Upload a new file'}
          </h2>
        </div>
        <button
          onClick={onClose}
          aria-label="Close media picker"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-warm-stone hover:bg-cream-100 hover:text-near-black transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
      </header>

      <div className="flex gap-1 border-b border-warm-stone/15 bg-cream-50/60 px-4 pt-2">
        <TabBtn active={tab === 'library'} onClick={() => setTab('library')}>
          Your files
        </TabBtn>
        <TabBtn active={tab === 'upload'} onClick={() => setTab('upload')}>
          Upload new
          {jobs.length > 0 && (
            <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-copper-500 px-1.5 text-[9px] font-bold text-cream-50">
              {jobs.length}
            </span>
          )}
        </TabBtn>
      </div>

      <div className="p-6 space-y-5">
        {error && (
          <div role="alert" className="rounded-xl border border-red-400/50 bg-red-50/40 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {tab === 'library' ? (
          <>
            <div className="flex gap-3 items-center">
              <Input
                type="search"
                placeholder="Search files by description…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Upload
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/avif,application/pdf"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) queueFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>

            {current && (
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
                Currently selected
              </p>
            )}

            {filtered.length === 0 && !busy ? (
              <p className="py-10 text-center text-sm text-warm-stone">
                {query
                  ? 'Nothing matches that search. Try a different word.'
                  : 'No files here yet. Switch to Upload new to add one.'}
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {filtered.map((m) => {
                  const isCurrent = current?.media_id === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onPick({ media_id: m.id, alt: m.alt_text })}
                      className={clsx(
                        'group relative overflow-hidden rounded-xl border bg-cream-50 transition-all duration-quick bwc-focus-ring',
                        isCurrent
                          ? 'border-copper-500 ring-2 ring-copper-300/50'
                          : 'border-warm-stone/15 hover:border-copper-400',
                      )}
                    >
                      <div className="aspect-square w-full overflow-hidden bg-cream-100 flex items-center justify-center">
                        {m.mime_type === 'application/pdf' ? (
                          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-warm-stone">PDF</span>
                        ) : m.variants?.thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={m.variants.thumb}
                            alt={m.alt_text}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-standard group-hover:scale-105"
                          />
                        ) : (
                          <div className="bwc-skeleton h-full w-full" />
                        )}
                      </div>
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-near-black/85 to-transparent px-2 pt-6 pb-2">
                        <p className="truncate text-[11px] font-medium text-cream-50">
                          {m.alt_text || 'Untitled file'}
                        </p>
                      </div>
                      {isCurrent && (
                        <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-copper-500 text-cream-50">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {cursor && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => loadPage(cursor)}
              >
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-copper-300 border-t-copper-700" />
                    Loading more…
                  </span>
                ) : (
                  'Load more'
                )}
              </Button>
            )}
          </>
        ) : (
          <>
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                if (e.dataTransfer.files?.length) queueFiles(e.dataTransfer.files)
              }}
              onClick={() => fileInputRef.current?.click()}
              className={clsx(
                'flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition-all duration-quick cursor-pointer',
                dragOver
                  ? 'border-copper-500 bg-copper-50 scale-[0.99]'
                  : 'border-warm-stone/30 bg-cream-50/60 hover:border-copper-400 hover:bg-cream-50',
              )}
              role="button"
              tabIndex={0}
            >
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-copper-100 text-copper-700">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </span>
              <p className="text-base font-medium text-near-black">
                {dragOver ? 'Drop to add to upload list' : 'Drop files here or click to choose'}
              </p>
              <p className="text-[11px] text-warm-stone">
                JPG, PNG, WebP, AVIF, or PDF
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/avif,application/pdf"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) queueFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>

            {jobs.length > 0 && (
              <div className="space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Ready to upload · {jobs.length}
                </p>
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    className="rounded-xl border border-warm-stone/20 bg-cream-50 p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-near-black">
                          {job.file.name}
                        </p>
                        <p className="text-[11px] text-warm-stone font-mono">
                          {formatBytes(job.file.size)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeJob(job.id)}
                        aria-label="Remove"
                        className="text-warm-stone hover:text-red-600 transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="6" y1="6" x2="18" y2="18" />
                          <line x1="6" y1="18" x2="18" y2="6" />
                        </svg>
                      </button>
                    </div>
                    {job.status !== 'done' && (
                      <Input
                        value={job.alt}
                        onChange={(e) => updateJob(job.id, { alt: e.target.value })}
                        placeholder="Describe this image — helps people who can't see it and Google (required)"
                        maxLength={320}
                        disabled={job.status === 'uploading'}
                      />
                    )}
                    {job.status === 'uploading' && (
                      <div className="h-1.5 overflow-hidden rounded-full bg-cream-200">
                        <div
                          className="h-full bg-copper-500 transition-[width] duration-quick"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                    )}
                    {job.status === 'done' && job.mediaId !== undefined && (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-copper-500 text-cream-50">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                        <p className="text-xs text-near-black">
                          Uploaded
                        </p>
                        <button
                          type="button"
                          onClick={() => onPick({ media_id: job.mediaId!, alt: job.alt.trim() })}
                          className="ml-auto inline-flex h-8 items-center rounded-full bg-near-black px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-cream-50 hover:bg-copper-700 transition-colors"
                        >
                          Use this file
                        </button>
                      </div>
                    )}
                    {job.status === 'error' && (
                      <p className="text-xs text-red-600">{job.error}</p>
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={uploadAll}
                    disabled={jobs.every((j) => j.status !== 'queued')}
                  >
                    Upload all
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setJobs([])}
                    disabled={jobs.some((j) => j.status === 'uploading')}
                  >
                    Clear list
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center rounded-t-lg px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-colors',
        active
          ? 'bg-cream-50 text-near-black border border-b-0 border-warm-stone/20'
          : 'text-warm-stone hover:text-near-black',
      )}
    >
      {children}
    </button>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// XHR uploader (mirrors the one in MediaPicker.tsx). Could be DRY'd in
// a shared module but kept local to avoid one more file in the
// inline-edit/ surface.
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
      // Last-ditch: hit /api/csrf via csrfFetch to seed the cookie.
      const r = await csrfFetch('/api/csrf', { method: 'GET' })
      if (!r.ok) throw new Error('Your session expired — refresh the page and try again.')
      token = readCsrf()
    }
  }
  if (!token) throw new Error('Your session expired — refresh the page and try again.')
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
      xhr.onerror = () => reject(new Error("We can't reach the server right now. Check your connection and try again."))
      xhr.ontimeout = () => reject(new Error('The upload took too long. Try again with a smaller file or a stronger connection.'))
      xhr.timeout = 120_000
      xhr.send(body)
    })

  let res = await send(token)
  if (res.status === 403) {
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
