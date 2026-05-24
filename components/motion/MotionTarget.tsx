'use client'

import {
  Children,
  cloneElement,
  type ReactElement,
  type Ref,
} from 'react'
import { useRevealOnScroll } from '@/lib/motion/useRevealOnScroll'
import { useLineReveal } from '@/lib/motion/useLineReveal'
import { useMagneticHover } from '@/lib/motion/useMagneticHover'
import { useParallax } from '@/lib/motion/useParallax'

// 'gold-rule' preset removed alongside the lx_rule widget — no
// borders/lines in the luxury system means no rule-wipe motion.
export type MotionPreset =
  | 'fade-in'
  | 'slide-up'
  | 'line-reveal'
  | 'magnetic'
  | 'parallax'

// Type-erased child shape — refs on HTML elements are regular props
// in React 19, but cloneElement's signature wants a typed props bag.
type RefBearingChild = ReactElement<{ ref?: Ref<HTMLElement> }>

// One thin client component per preset so each MotionTarget instance
// runs EXACTLY ONE hook. Calling all 6 hooks unconditionally would
// install N × usePrefersReducedMotion matchMedia listeners per page;
// dispatching to a sub-component pins it to 1 listener per widget.

function FadeInTarget({ children }: { children: RefBearingChild }) {
  const ref = useRevealOnScroll<HTMLElement>({ y: 0 })
  return cloneElement(Children.only(children), { ref })
}
function SlideUpTarget({ children }: { children: RefBearingChild }) {
  const ref = useRevealOnScroll<HTMLElement>({ y: 24 })
  return cloneElement(Children.only(children), { ref })
}
function LineRevealTarget({ children }: { children: RefBearingChild }) {
  const ref = useLineReveal<HTMLElement>()
  return cloneElement(Children.only(children), { ref })
}
function MagneticTarget({ children }: { children: RefBearingChild }) {
  const ref = useMagneticHover<HTMLElement>()
  return cloneElement(Children.only(children), { ref })
}
function ParallaxTarget({ children }: { children: RefBearingChild }) {
  const ref = useParallax<HTMLElement>()
  return cloneElement(Children.only(children), { ref })
}

/**
 * Generic client-side motion attacher. Used by lx_* widget renderers
 * to opt a single HTML child into a named animation preset without
 * each renderer growing its own client wrapper.
 *
 * Contract:
 *   - children MUST be a single HTML element (heading / button / img
 *     / div / etc.). Refs forward natively through HTML elements;
 *     wrapping a custom component requires that component to forward
 *     refs explicitly.
 *   - Inline-edit mode in the parent renderer should SKIP wrapping
 *     in MotionTarget — contenteditable + SplitText conflict, and
 *     operators want to edit without animations firing under them.
 *
 * Each preset routes to a sub-component so only the relevant hook
 * runs (see one-listener-per-widget note above).
 */
export function MotionTarget({
  preset,
  children,
}: {
  preset: MotionPreset
  children: RefBearingChild
}) {
  switch (preset) {
    case 'fade-in':
      return <FadeInTarget>{children}</FadeInTarget>
    case 'slide-up':
      return <SlideUpTarget>{children}</SlideUpTarget>
    case 'line-reveal':
      return <LineRevealTarget>{children}</LineRevealTarget>
    case 'magnetic':
      return <MagneticTarget>{children}</MagneticTarget>
    case 'parallax':
      return <ParallaxTarget>{children}</ParallaxTarget>
  }
}
