'use client'

import { createElement, type ReactNode } from 'react'
import { useRevealOnScroll } from '@/lib/motion/useRevealOnScroll'

type AllowedTag = 'div' | 'section' | 'article' | 'span' | 'header' | 'footer' | 'aside' | 'main'

type Props = {
  children: ReactNode
  y?: number
  duration?: number
  delay?: number
  ease?: string
  start?: string
  once?: boolean
  as?: AllowedTag
  className?: string
}

/**
 * Declarative wrapper around useRevealOnScroll. Lets a block
 * renderer opt into the slide-up reveal without managing a ref
 * itself:
 *
 *   <RevealOnScroll as="section" delay={0.1}>
 *     <Heading ... />
 *   </RevealOnScroll>
 *
 * For callers that need fine-grained control (e.g., revealing
 * specific child elements with offset delays from a parent timeline)
 * use the useRevealOnScroll hook directly.
 */
export function RevealOnScroll({
  children,
  as = 'div',
  className,
  y,
  duration,
  delay,
  ease,
  start,
  once,
}: Props) {
  const ref = useRevealOnScroll<HTMLElement>({ y, duration, delay, ease, start, once })
  return createElement(as, { ref, className }, children)
}
