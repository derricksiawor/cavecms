'use client'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { MediaPickerModal } from './MediaPickerModal'

export interface MediaRef {
  media_id: number
  alt: string
}

interface PickerCtx {
  open: (current: MediaRef | undefined, onPick: (m: MediaRef) => void) => void
  /** Cached thumbnail URL for a previously-loaded media id, or null. */
  resolveThumb: (id: number) => string | null
  /** Async variant: returns the cached thumb when present, otherwise
   *  fetches it from /api/cms/media/<id>, populates the cache, and
   *  resolves with the URL. Used by MediaPicker fields whose value is
   *  pre-set before the modal has ever been opened (which is the only
   *  path that warms the cache via list pagination). */
  resolveThumbAsync: (id: number) => Promise<string | null>
  /** Used by the modal to push library thumbs into the shared cache. */
  cacheThumbs: (
    items: Array<{ id: number; variants: { thumb?: string } | null }>,
  ) => void
}

const Ctx = createContext<PickerCtx | null>(null)

// Module-scope LRU thumbnail cache + in-flight map. Survives provider
// re-mounts (preview iframe, route transitions that retain the React
// tree but mount a fresh provider) so the picker doesn't re-fetch
// every thumb on every edit-mode session start. Hard cap at 500
// entries — typical sessions touch <100 distinct ids; pathological
// pagination through 5000+ rows would otherwise leak URL strings for
// the whole tab life.
//
// `globalThis` pinning makes HMR-survivable in dev too.
const THUMB_LRU_MAX = 500
declare global {
  var __cavecmsMediaThumbLRU: Map<number, string> | undefined
  var __cavecmsMediaThumbInFlight: Map<number, Promise<string | null>> | undefined
}
const moduleThumbCache: Map<number, string> =
  globalThis.__cavecmsMediaThumbLRU ?? new Map<number, string>()
globalThis.__cavecmsMediaThumbLRU = moduleThumbCache
const moduleInFlight: Map<number, Promise<string | null>> =
  globalThis.__cavecmsMediaThumbInFlight ??
  new Map<number, Promise<string | null>>()
globalThis.__cavecmsMediaThumbInFlight = moduleInFlight

function lruSet(id: number, url: string): void {
  // Map preserves insertion order — delete + set moves to most-recent.
  if (moduleThumbCache.has(id)) moduleThumbCache.delete(id)
  moduleThumbCache.set(id, url)
  if (moduleThumbCache.size > THUMB_LRU_MAX) {
    const oldest = moduleThumbCache.keys().next().value
    if (oldest !== undefined) moduleThumbCache.delete(oldest)
  }
}

export function MediaPickerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    current?: MediaRef
    onPick: (m: MediaRef) => void
  } | null>(null)

  // Cache lookups read through the module-scope LRU above so a fresh
  // provider mount (preview iframe, route transition that remounts
  // the tree) doesn't have to re-fetch every thumb.

  const open = useCallback<PickerCtx['open']>((current, onPick) => {
    setState({ current, onPick })
  }, [])

  const resolveThumb = useCallback((id: number): string | null => {
    return moduleThumbCache.get(id) ?? null
  }, [])

  const resolveThumbAsync = useCallback(
    async (id: number): Promise<string | null> => {
      const cached = moduleThumbCache.get(id)
      if (cached) return cached
      const pending = moduleInFlight.get(id)
      if (pending) return pending
      const fetchPromise = (async () => {
        try {
          const r = await fetch(`/api/cms/media/${id}`, {
            credentials: 'include',
            cache: 'no-store',
          })
          if (!r.ok) return null
          const row = (await r.json()) as {
            variants: { thumb?: string; md?: string; lg?: string } | null
          }
          // Prefer `thumb` (the smallest variant the gallery uses);
          // fall back to `md`/`lg` if a media row was uploaded before
          // the four-variant pipeline landed (legacy seeded rows).
          const url =
            row.variants?.thumb ?? row.variants?.md ?? row.variants?.lg ?? null
          if (url) lruSet(id, url)
          return url
        } catch {
          return null
        } finally {
          moduleInFlight.delete(id)
        }
      })()
      moduleInFlight.set(id, fetchPromise)
      return fetchPromise
    },
    [],
  )

  const cacheThumbs = useCallback<PickerCtx['cacheThumbs']>((items) => {
    for (const it of items) {
      const url = it.variants?.thumb
      if (url) lruSet(it.id, url)
    }
  }, [])

  // Memoise the provider value so it doesn't re-create on every render and
  // cascade re-renders into every `useMediaPicker()` consumer (every widget
  // drawer's media field, every Gallery picker, etc). open/resolveThumb/
  // resolveThumbAsync/cacheThumbs are all useCallback-stable; the wrapper
  // object identity has been the source of N×consumer churn per state change.
  const value = useMemo(
    () => ({ open, resolveThumb, resolveThumbAsync, cacheThumbs }),
    [open, resolveThumb, resolveThumbAsync, cacheThumbs],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      {state && (
        <MediaPickerModal
          current={state.current}
          onPick={(m) => {
            state.onPick(m)
            setState(null)
          }}
          onClose={() => setState(null)}
        />
      )}
    </Ctx.Provider>
  )
}

export function useMediaPicker(): PickerCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useMediaPicker outside provider')
  return c
}
