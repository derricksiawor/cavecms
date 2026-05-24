'use client'

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

// Avoid the "useLayoutEffect on server" warning during SSR.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

// Single client wrapper for scroll-tied entrance animation. Uses
// IntersectionObserver (no Framer Motion dep) — children render
// invisible until the wrapper enters the viewport, then add one of
// the Chunk D motion utility classes (animate-bwc-slide-up by
// default).
//
// Section-usage policy (project-detail page):
//   - Below-the-fold sections (Summary, Pricing, Amenities, Brochure,
//     Inquiry, Location, Timeline, SimilarProjectsRail) WRAP their
//     outer section in RevealOnView for the scroll-tied entrance.
//   - Above-the-fold sections (Hero, FactsStrip) animate on first
//     paint via the static `animate-bwc-rise` / `animate-bwc-fade-in`
//     classes — wrapping them would delay paint by one IO tick and
//     leave a blank strip during the hero's settle.
//   - Client-interactive sections that own their internal motion
//     (Gallery, FloorPlans, Testimonials) skip RevealOnView; they
//     would double-animate the entrance + the internal interaction
//     and feel busy.
//   - Fixed-position chrome (StickyHeader, WhatsAppBubble) skips
//     RevealOnView; they have their own visibility-tied transitions.
//
// Why a shared client wrapper rather than ad-hoc:
//   - keeps every section render.tsx a server component
//   - one observer instance per section beats Framer Motion's
//     whileInView weight for read-only marketing content
//   - one place to honour prefers-reduced-motion (the wrapper
//     becomes a pass-through when the user opts out — the
//     animation utility class never lands)
//   - keeps Chunk D's token system authoritative (animation
//     duration/easing live in @theme, not JS)
//
// Usage:
//   <RevealOnView>           default = slide-up + 0px stagger
//   <RevealOnView delay={0.2} animation="scale-in">
//   <RevealOnView once={false}>  re-reveals if scrolled past
//
// `delay` is in seconds (matches Framer Motion convention used
// elsewhere in the project so authors don't have to think in two
// units). The component converts to a CSS animation-delay.
//
// rootMargin '-10%' fires the reveal slightly before the element's
// top edge crosses the viewport — feels more like a "tied to the
// scroll" reveal and less like a "popped after entering".

type RevealAnimation = 'slide-up' | 'fade-in' | 'scale-in' | 'rise'

const CLASS_FOR_ANIMATION: Record<RevealAnimation, string> = {
  'slide-up': 'animate-bwc-slide-up',
  'fade-in': 'animate-bwc-fade-in',
  'scale-in': 'animate-bwc-scale-in',
  rise: 'animate-bwc-rise',
}

interface Props {
  children: ReactNode
  animation?: RevealAnimation
  delay?: number
  // When true (default) the observer disconnects after first reveal —
  // matches the spec's "scroll-tied entrance" intent: it's an arrival
  // moment, not a constantly-resetting parallax.
  once?: boolean
  // Optional wrapper className — for layout (margins/padding/etc.).
  // Animation-related classes are appended by the wrapper itself.
  className?: string
  // Optional id on the wrapper — sections often need a hash-link
  // anchor (e.g. id="brochure", id="amenities") and the wrapper IS
  // the outermost rendered element, so the id has to live here.
  id?: string
  // Hand-off prop for testing or sections that want to override the
  // intersection root threshold.
  threshold?: number
  // Tag the wrapper renders as. Defaults to <div>. <section> is the
  // common alternative when the parent already owns vertical rhythm.
  as?: 'div' | 'section' | 'article' | 'header' | 'footer'
}

export function RevealOnView({
  children,
  animation = 'slide-up',
  delay = 0,
  once = true,
  className,
  id,
  threshold = 0.05,
  as: Tag = 'div',
}: Props) {
  // Ref types as HTMLElement (not HTMLDivElement) since `as` can
  // resolve to any block-level element.
  const ref = useRef<HTMLElement | null>(null)
  const [revealed, setRevealed] = useState(false)
  // Track reduced-motion. Server-rendered HTML always shows
  // pre-reveal opacity-0; the useLayoutEffect below flips the
  // reduced-motion branch to revealed BEFORE the browser paints so
  // SR users never see a flash of opacity-0 content.
  const [reducedMotion, setReducedMotion] = useState(false)

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (mq.matches) {
      setReducedMotion(true)
      setRevealed(true)
    }
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setReducedMotion(true)
        setRevealed(true)
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (reducedMotion) return
    const el = ref.current
    if (!el) return
    // IntersectionObserver is widely supported across every browser
    // listed in tsconfig's lib target; no polyfill needed.
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        if (entry.isIntersecting) {
          setRevealed(true)
          if (once) io.disconnect()
        } else if (!once) {
          setRevealed(false)
        }
      },
      { threshold, rootMargin: '0px 0px -10% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [once, threshold, reducedMotion])

  // Pre-reveal: opacity-0 (no transform — the animation utility owns
  // its own transform end-state via 'both' fill-mode).
  // Post-reveal: animate-bwc-* utility applies; with `both` fill-mode
  // the end state sticks even after the animation finishes.
  const animClass = revealed && !reducedMotion ? CLASS_FOR_ANIMATION[animation] : ''
  const visibility = revealed || reducedMotion ? '' : 'opacity-0'

  const style =
    revealed && !reducedMotion && delay > 0
      ? { animationDelay: `${delay}s` }
      : undefined

  return (
    <Tag
      // `as` resolves to a div/section/article/header/footer — every
      // option is an HTMLElement, which is all IntersectionObserver
      // needs (the ref is only ever read internally via `.observe()`).
      // React's JSX ref typing system insists on HTMLDivElement here
      // because that's the default polymorphic prop type; the cast is
      // the standard pattern for polymorphic `as` components and is
      // safe because no consumer reads `ref.current` externally.
      ref={ref as React.RefObject<HTMLDivElement>}
      id={id}
      className={[className, visibility, animClass].filter(Boolean).join(' ')}
      style={style}
    >
      {children}
    </Tag>
  )
}
