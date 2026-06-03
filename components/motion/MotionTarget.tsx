'use client'

import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { useRevealOnScroll } from '@/lib/motion/useRevealOnScroll'
import { useMotionTiming } from '@/lib/motion/MotionTiming'
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

// React 19 + Next.js Server Components: the
// `cloneElement(Children.only(children), { ref })` pattern is "soft
// deprecated" per the React core team (Sebastian Markbåge: "cloneElement
// is basically soft deprecated. It works against any ability to optimize
// by inlining.") and BREAKS unpredictably during hydration —
// specifically the `Children.only` validator throws "expected to receive
// a single React element child" when the upstream React reconciler has
// already unwrapped a server-stream fragment past Children.only's
// inspection point. This is the same bug @radix-ui/react-slot patched
// in v1.2.0 by falling back to createElement when children is a
// Promise/serialized-server-shape.
//
// We saw this concretely: certain hotel-solenne pages (e.g. /dining,
// /story) 500'd with "React.Children.only expected to receive a single
// React element child" — even though every MotionTarget caller in this
// codebase passes a single root element. The error fired in
// SlideUpTarget after a few successful renders, depending on the
// ordering of sibling MotionTarget instances on the page.
//
// Fix: inject the ref via React 19's ref-as-prop. Use `cloneElement`
// WITHOUT the `Children.only` validator wrapper. cloneElement still
// works fine when called directly — what was broken was *requiring*
// children to pass `Children.only`'s tighter "is exactly one element"
// check at hydration time. `isValidElement` is the lighter equivalent.

type RefBearingChild = ReactElement<{ ref?: Ref<HTMLElement> }>

function attachRef(children: ReactNode, ref: Ref<HTMLElement>): ReactNode {
  // Refs only attach to real DOM-backed elements. If the caller passed
  // a fragment / string / array (none of which can hold a ref), we
  // render the children unmodified. The animation hook still runs but
  // its scroll/intersection observer never fires — visually identical
  // to `animation: none`. That's the safest degrade — silently dropping
  // the animation beats crashing the whole page render.
  if (!isValidElement(children)) return children
  return cloneElement(children as RefBearingChild, { ref })
}

// One thin client component per preset so each MotionTarget instance
// runs EXACTLY ONE hook. Calling all 6 hooks unconditionally would
// install N × usePrefersReducedMotion matchMedia listeners per page;
// dispatching to a sub-component pins it to 1 listener per widget.

function FadeInTarget({ children }: { children: ReactNode }) {
  const t = useMotionTiming()
  const ref = useRevealOnScroll<HTMLElement>({
    y: 0,
    ...(t.durationMs ? { duration: t.durationMs / 1000 } : {}),
    ...(t.delayMs ? { delay: t.delayMs / 1000 } : {}),
  })
  return attachRef(children, ref)
}
function SlideUpTarget({ children }: { children: ReactNode }) {
  const t = useMotionTiming()
  const ref = useRevealOnScroll<HTMLElement>({
    y: 24,
    ...(t.durationMs ? { duration: t.durationMs / 1000 } : {}),
    ...(t.delayMs ? { delay: t.delayMs / 1000 } : {}),
  })
  return attachRef(children, ref)
}
function LineRevealTarget({ children }: { children: ReactNode }) {
  const ref = useLineReveal<HTMLElement>()
  return attachRef(children, ref)
}
function MagneticTarget({ children }: { children: ReactNode }) {
  const ref = useMagneticHover<HTMLElement>()
  return attachRef(children, ref)
}
function ParallaxTarget({ children }: { children: ReactNode }) {
  const ref = useParallax<HTMLElement>()
  return attachRef(children, ref)
}

/**
 * Generic client-side motion attacher. Used by lx_* widget renderers
 * to opt a single HTML child into a named animation preset without
 * each renderer growing its own client wrapper.
 *
 * Contract:
 *   - children SHOULD be a single HTML element (heading / button / img
 *     / div / etc.). Refs forward natively through HTML elements;
 *     wrapping a custom component requires that component to forward
 *     refs explicitly. When children is a fragment / string / array,
 *     the wrapper degrades to "no animation" rather than crashing.
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
  children: ReactNode
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
