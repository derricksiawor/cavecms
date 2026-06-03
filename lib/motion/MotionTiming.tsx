'use client'

import { createContext, useContext, type ReactNode } from 'react'

// Per-widget animation timing (E16). The widget wrapper provides duration +
// delay (ms) from widget meta; MotionTarget consumes them so an operator can
// tune the entrance speed + stagger of any animated block without per-block
// schema changes. Context (not props) so existing MotionTarget call sites
// need no change.
export interface MotionTimingValue {
  durationMs?: number
  delayMs?: number
}

const MotionTimingContext = createContext<MotionTimingValue>({})

export function MotionTimingProvider({
  durationMs,
  delayMs,
  children,
}: MotionTimingValue & { children: ReactNode }) {
  return (
    <MotionTimingContext.Provider value={{ durationMs, delayMs }}>
      {children}
    </MotionTimingContext.Provider>
  )
}

export function useMotionTiming(): MotionTimingValue {
  return useContext(MotionTimingContext)
}
