'use client'
import { useEffect, useState } from 'react'
import type { CustomFont } from '@/lib/typography/customFonts'

// Module-level cache + tiny pub/sub so every picker instance (the inline-edit
// drawer AND the Typography settings page) shares ONE fetch of the operator's
// custom fonts, and an upload/delete anywhere refreshes them all.
let cache: CustomFont[] | null = null
let inflight: Promise<CustomFont[]> | null = null
const listeners = new Set<() => void>()

async function fetchFonts(): Promise<CustomFont[]> {
  try {
    const r = await fetch('/api/admin/fonts', { credentials: 'same-origin' })
    if (!r.ok) return []
    const j = (await r.json()) as { fonts?: unknown }
    return Array.isArray(j.fonts) ? (j.fonts as CustomFont[]) : []
  } catch {
    return []
  }
}

function notify() {
  for (const l of listeners) l()
}

export function useCustomFonts(): {
  fonts: CustomFont[]
  reload: () => Promise<void>
} {
  const [fonts, setFonts] = useState<CustomFont[]>(cache ?? [])

  useEffect(() => {
    const onChange = () => setFonts(cache ?? [])
    listeners.add(onChange)
    if (cache !== null) {
      setFonts(cache)
    } else if (!inflight) {
      inflight = fetchFonts().then((f) => {
        cache = f
        inflight = null
        notify()
        return f
      })
    }
    return () => {
      listeners.delete(onChange)
    }
  }, [])

  const reload = async () => {
    cache = await fetchFonts()
    notify()
  }

  return { fonts, reload }
}
