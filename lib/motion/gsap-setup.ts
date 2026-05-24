'use client'

import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

/**
 * Centralised GSAP plugin registration. Imported by every motion
 * hook before tween creation. Idempotent — calling it from N hook
 * instances costs one branch check after the first call.
 *
 * SplitText is registered lazily inside useLineReveal (only the
 * line-reveal hook needs it; loading it eagerly would ship the
 * plugin to every page that uses any motion hook).
 */
let scrollTriggerRegistered = false

export function setupGsap(): void {
  if (scrollTriggerRegistered || typeof window === 'undefined') return
  gsap.registerPlugin(ScrollTrigger)
  scrollTriggerRegistered = true
}

export { gsap, ScrollTrigger }
