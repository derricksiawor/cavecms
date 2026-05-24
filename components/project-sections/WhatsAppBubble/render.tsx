'use client'

import { useEffect, useState } from 'react'

// Fixed-position WhatsApp click-to-chat bubble. Pre-fills a message
// scoped to the project name so the agent sees context instantly.
// Phone is sanitised to the WhatsApp wa.me URL format: digits only,
// no leading +, no spaces, no parens — anything else breaks the
// deep-link.
//
// Uses the official WhatsApp brand mark from /public/icons/
// (downloaded from simple-icons CDN — MIT-licensed, brand-accurate)
// per project standards #0.57. Hand-rolled approximations are prohibited.
//
// Hides itself when StickyHeader is pinned (matches IntersectionObs
// hook so the two fixed elements never stack on top of each other
// at the top of the viewport).

interface Props {
  phone: string
  projectName: string
}

function sanitizePhone(raw: string): string {
  // wa.me expects digits-only (E.164 without the '+'). Strip
  // everything else; if nothing is left, return empty so we hide
  // the bubble instead of producing a broken link.
  const digits = raw.replace(/\D+/g, '')
  return digits
}

export function WhatsAppBubble({ phone, projectName }: Props) {
  // Start hidden so a deep-link arrival (page loaded with #pricing
  // hash, already past the hero) doesn't flash a misplaced bubble
  // for the frame between mount and first IO callback. The bubble
  // is non-critical chrome — one frame of absence beats one frame
  // of misplaced.
  const [visible, setVisible] = useState(false)
  // Gate render entirely on `mounted` to avoid the SSR-true / client-
  // false hydration mismatch (initial server render would have to
  // pick one default; mounting first lets us choose based on real
  // viewport state).
  const [mounted, setMounted] = useState(false)

  // Hide while the sticky header is up (the header occupies the
  // top, the bubble lives bottom-right — but on small viewports
  // they share visual weight; keeping the bubble visible
  // simultaneously feels noisy). We observe the same hero sentinel
  // and INVERT the result.
  useEffect(() => {
    setMounted(true)
    const sentinel = document.getElementById('project-hero')
    if (!sentinel) {
      // No hero in the DOM (defensive — every project page has one).
      // Show the bubble unconditionally so a malformed page still
      // exposes the contact CTA.
      setVisible(true)
      return
    }
    // Synchronous initial check so the first paint reflects the
    // current scroll position (covers deep-link arrivals where the
    // user lands mid-page via a hash anchor).
    const initialRect = sentinel.getBoundingClientRect()
    const initialOffHero = initialRect.bottom <= 0
    const narrow = window.matchMedia('(max-width: 640px)').matches
    setVisible(!(initialOffHero && narrow))

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        const offHero = !entry.isIntersecting && entry.boundingClientRect.top < 0
        const isNarrow = window.matchMedia('(max-width: 640px)').matches
        setVisible(!(offHero && isNarrow))
      },
      { threshold: 0 },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [])

  const digits = sanitizePhone(phone)
  if (!digits) return null
  // Defer first paint until the IO callback has settled (one render
  // cycle after mount). Prevents a one-frame flash of the bubble
  // for deep-link arrivals where the bubble should be hidden.
  if (!mounted) return null

  const message = `Hi, I'm interested in ${projectName}.`
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Chat about ${projectName} on WhatsApp`}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      data-visible={visible}
      className={[
        // z:30 keeps the bubble behind modal/drawer chrome (z:40+).
        // Bottom-right, never overlaps the StickyHeader at the top.
        'fixed bottom-5 right-5 z-30 grid h-14 w-14 place-items-center rounded-full bg-[#25D366] shadow-xl shadow-near-black/20 ring-1 ring-near-black/5',
        'transition-all duration-standard ease-standard',
        'hover:scale-105 hover:shadow-2xl hover:shadow-near-black/30',
        'data-[visible=false]:translate-y-24 data-[visible=false]:opacity-0 data-[visible=false]:pointer-events-none',
        'sm:bottom-6 sm:right-6',
      ].join(' ')}
    >
      {/* Official WhatsApp brand mark — MIT-licensed simple-icons SVG,
         downloaded at build to /public/icons/whatsapp.svg per
         project standards #0.57. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icons/whatsapp.svg"
        alt=""
        aria-hidden
        className="h-7 w-7 brightness-0 invert"
      />
      <span className="sr-only">Chat on WhatsApp</span>
    </a>
  )
}
