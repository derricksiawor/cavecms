'use client'

import { useEffect, useRef } from 'react'
import { setupGsap, gsap } from './gsap-setup'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

type MagneticOptions = {
  /** px max displacement in either axis (default 8) */
  strength?: number
  /** gsap ease for follow (default 'power2.out') */
  ease?: string
  /** seconds for follow tween (default 0.4) */
  duration?: number
}

/**
 * Cursor-following magnetic hover. Element translates toward the
 * cursor by up to `strength` px while the cursor is over it; smoothly
 * returns to origin (with a soft elastic ease) when the cursor
 * leaves. Common on luxury CTAs.
 *
 * Disabled when:
 *   - prefers-reduced-motion: reduce
 *   - pointer: coarse (touch — no hover state)
 *
 * Pointer-coarse changes subscribed via matchMedia change events so
 * hybrid devices (iPad with Magic Keyboard, Surface) switching from
 * mouse to touch mid-session tear down the magnetic listeners.
 *
 * Tween lifecycle: each pointer event kills the previously-active
 * tween and starts a new one. On unmount, the active tween is killed
 * + transform is cleared. The legacy `gsap.set(clearProps)` raced
 * against in-flight tweens; explicit tween tracking + kill avoids
 * the race.
 */
export function useMagneticHover<T extends HTMLElement = HTMLButtonElement>(
  options: MagneticOptions = {},
) {
  const ref = useRef<T | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const { strength = 8, ease = 'power2.out', duration = 0.4 } = options

  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion) return

    const coarseMql = window.matchMedia('(pointer: coarse)')

    let bound = false
    let onMove: ((e: PointerEvent) => void) | null = null
    let onLeave: (() => void) | null = null
    let activeTween: gsap.core.Tween | null = null

    const clamp = (n: number) => Math.max(-strength, Math.min(strength, n))

    const bind = () => {
      if (bound || coarseMql.matches) return
      setupGsap()

      onMove = (e: PointerEvent) => {
        const rect = el.getBoundingClientRect()
        const relX = e.clientX - rect.left - rect.width / 2
        const relY = e.clientY - rect.top - rect.height / 2
        const x = clamp((relX / rect.width) * strength * 2)
        const y = clamp((relY / rect.height) * strength * 2)
        if (activeTween) activeTween.kill()
        activeTween = gsap.to(el, { x, y, duration, ease })
      }
      onLeave = () => {
        if (activeTween) activeTween.kill()
        activeTween = gsap.to(el, {
          x: 0,
          y: 0,
          duration: duration * 1.5,
          ease: 'elastic.out(1, 0.5)',
        })
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerleave', onLeave)
      bound = true
    }

    const unbind = () => {
      if (!bound) return
      if (onMove) el.removeEventListener('pointermove', onMove)
      if (onLeave) el.removeEventListener('pointerleave', onLeave)
      if (activeTween) {
        activeTween.kill()
        activeTween = null
      }
      try {
        gsap.set(el, { clearProps: 'transform' })
      } catch {
        // ignore — detached node
      }
      onMove = null
      onLeave = null
      bound = false
    }

    bind()

    const onCoarseChange = (e: MediaQueryListEvent) => {
      if (e.matches) unbind()
      else bind()
    }
    coarseMql.addEventListener('change', onCoarseChange)

    return () => {
      coarseMql.removeEventListener('change', onCoarseChange)
      unbind()
    }
  }, [reducedMotion, strength, ease, duration])

  return ref
}
