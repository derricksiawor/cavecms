'use client'
import { useEffect, useState } from 'react'
import type { CustomFont } from '@/lib/typography/customFonts'

// Lazy, module-cached Google-fonts hook. Mirrors useCustomFonts' shared-cache
// + pub/sub pattern, with ONE critical difference: the catalog (~1,934
// families, ~163 KB) is fetched ONLY when a picker actually opens the Google
// section — never on every picker mount. `enabled=false` keeps the hook inert
// (returns empty until the operator expands "Google Fonts"); the first
// `enabled=true` triggers the single shared fetch that every picker instance
// then shares.

// Compact catalog entry as served by GET /api/admin/fonts/google.
export interface GoogleFontCatalogEntry {
  slug: string
  family: string
  category: 'serif' | 'sans' | 'display' | 'mono'
  weights: number[]
  italic: boolean
  variable: [number, number] | null
}

interface GoogleFontsState {
  catalog: GoogleFontCatalogEntry[]
  // Activated fonts share the CustomFont shape (key `gf-<slug>`, self-hosted).
  activated: CustomFont[]
}

let cache: GoogleFontsState | null = null
let inflight: Promise<GoogleFontsState | null> | null = null
const listeners = new Set<() => void>()

async function fetchGoogleFonts(): Promise<GoogleFontsState | null> {
  try {
    const r = await fetch('/api/admin/fonts/google', { credentials: 'same-origin' })
    if (!r.ok) return null
    const j = (await r.json()) as { fonts?: unknown; activated?: unknown }
    const catalog = Array.isArray(j.fonts) ? (j.fonts as GoogleFontCatalogEntry[]) : []
    const activated = Array.isArray(j.activated) ? (j.activated as CustomFont[]) : []
    return { catalog, activated }
  } catch {
    return null
  }
}

function notify() {
  for (const l of listeners) l()
}

export function useGoogleFonts(enabled: boolean): {
  catalog: GoogleFontCatalogEntry[]
  activated: CustomFont[]
  loading: boolean
  /** Re-fetch the activated list after an activation/deactivation. */
  reload: () => Promise<void>
} {
  const [state, setState] = useState<GoogleFontsState | null>(cache)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const onChange = () => setState(cache)
    listeners.add(onChange)
    if (cache !== null) {
      setState(cache)
    } else if (!inflight) {
      setLoading(true)
      inflight = fetchGoogleFonts().then((s) => {
        cache = s
        inflight = null
        notify()
        return s
      })
      void inflight.finally(() => setLoading(false))
    } else {
      setLoading(true)
      void inflight.finally(() => setLoading(false))
    }
    return () => {
      listeners.delete(onChange)
    }
  }, [enabled])

  const reload = async () => {
    const s = await fetchGoogleFonts()
    if (s) {
      cache = s
      notify()
    }
  }

  return {
    catalog: state?.catalog ?? [],
    activated: state?.activated ?? [],
    loading,
    reload,
  }
}
