'use client'

import { useEffect, useRef } from 'react'
import type { MotionEffect } from '@/lib/cms/blockMeta'

// Self-contained scroll / mouse motion for a section or column (Elementor
// Motion Effects parity). Rendered as a hidden marker INSIDE the target
// element; on mount it grabs its parentElement and drives the effect with
// a single rAF loop + IntersectionObserver (so off-screen elements cost
// nothing). No wrapper div, no global runtime — safe for the editor's
// section/column detection. Honours prefers-reduced-motion (no-op).

export function SectionMotion({
  effect,
  intensity = 30,
}: {
  effect: Exclude<MotionEffect, 'none'>
  intensity?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const el = ref.current?.parentElement as HTMLElement | null
    if (!el) return

    const amt = Math.max(1, Math.min(100, intensity))
    let inView = false
    let raf = 0

    // Smooth perspective for the tilt effect.
    if (effect === 'tilt') {
      el.style.transformStyle = 'preserve-3d'
      el.style.willChange = 'transform'
      const max = amt / 10 // up to 10deg at intensity 100
      const onMove = (e: MouseEvent) => {
        const r = el.getBoundingClientRect()
        const px = (e.clientX - r.left) / r.width - 0.5
        const py = (e.clientY - r.top) / r.height - 0.5
        el.style.transform = `perspective(900px) rotateY(${px * max}deg) rotateX(${-py * max}deg)`
      }
      let leaveTimer = 0
      const onLeave = () => {
        el.style.transform = 'perspective(900px) rotateY(0deg) rotateX(0deg)'
        el.style.transition = 'transform 400ms ease'
        if (leaveTimer) window.clearTimeout(leaveTimer)
        leaveTimer = window.setTimeout(() => {
          el.style.transition = ''
          leaveTimer = 0
        }, 420)
      }
      el.addEventListener('mousemove', onMove)
      el.addEventListener('mouseleave', onLeave)
      return () => {
        el.removeEventListener('mousemove', onMove)
        el.removeEventListener('mouseleave', onLeave)
        if (leaveTimer) window.clearTimeout(leaveTimer)
        el.style.transform = ''
        el.style.transition = ''
        el.style.transformStyle = ''
        el.style.willChange = ''
      }
    }

    el.style.willChange = effect === 'fade-scroll' ? 'opacity' : 'transform'

    // progress: -1 (entering from bottom) → 0 (centred) → 1 (leaving top)
    const apply = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight || 1
      const centre = r.top + r.height / 2
      const progress = (centre - vh / 2) / (vh / 2 + r.height / 2) // ~[-1,1]
      const p = Math.max(-1, Math.min(1, progress))
      if (effect === 'parallax') {
        el.style.transform = `translate3d(0, ${(-p * amt).toFixed(1)}px, 0)`
      } else if (effect === 'zoom-scroll') {
        const scale = 1 + (1 - Math.abs(p)) * (amt / 100) * 0.25
        el.style.transform = `scale(${scale.toFixed(3)})`
      } else if (effect === 'fade-scroll') {
        el.style.opacity = String(Math.max(0.05, 1 - Math.abs(p)).toFixed(3))
      }
    }
    const onScroll = () => {
      if (!inView || raf) return
      raf = window.requestAnimationFrame(apply)
    }
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? false
        if (inView) onScroll()
      },
      { rootMargin: '10% 0px' },
    )
    io.observe(el)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    apply()
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
      el.style.transform = ''
      el.style.opacity = ''
      el.style.willChange = ''
    }
  }, [effect, intensity])

  return <span ref={ref} aria-hidden="true" className="hidden" />
}
