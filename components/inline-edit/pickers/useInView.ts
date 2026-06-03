'use client'
import { useEffect, useRef, useState } from 'react'

// Lazy-visibility hook for font-preview options. A font option only applies
// its real typeface (which triggers the woff2 download) once it scrolls into
// view — so opening a picker with hundreds of fonts loads only the ~handful
// visible in the scroll viewport, not every font at once. `once: true` keeps
// the face applied after first reveal (no flicker on scroll-away/back).
export function useInView<T extends Element>(
  options?: IntersectionObserverInit & { once?: boolean },
): { ref: (node: T | null) => void; inView: boolean } {
  const [inView, setInView] = useState(false)
  const nodeRef = useRef<T | null>(null)
  const obsRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    return () => {
      obsRef.current?.disconnect()
      obsRef.current = null
    }
  }, [])

  const ref = (node: T | null) => {
    obsRef.current?.disconnect()
    nodeRef.current = node
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      // SSR / unsupported — render eagerly so nothing is ever hidden.
      setInView(true)
      return
    }
    const obs = new IntersectionObserver((entries) => {
      const e = entries[0]
      if (e?.isIntersecting) {
        setInView(true)
        if (options?.once !== false) {
          obs.disconnect()
          obsRef.current = null
        }
      } else if (options?.once === false) {
        setInView(false)
      }
    }, { root: null, rootMargin: '120px', threshold: 0, ...options })
    obs.observe(node)
    obsRef.current = obs
  }

  return { ref, inView }
}
