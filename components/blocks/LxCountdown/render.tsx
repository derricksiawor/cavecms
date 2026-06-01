'use client'

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Countdown (Elementor: Countdown). Counts down to an ISO target.
// Hydration-safe: the server renders a deterministic snapshot (the
// remaining time computed once, with suppressHydrationWarning on the
// volatile digits) and the live 1s tick starts in useEffect — the same
// pattern as SaveStatus.tsx's relative-time fix. The countdown keeps
// ticking under prefers-reduced-motion (it's information, not decoration).

const TONE_DIGIT: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_LABEL: Record<string, string> = { obsidian: 'text-warm-stone', ivory: 'text-ivory/65' }

interface Remaining {
  days: number
  hours: number
  minutes: number
  seconds: number
  expired: boolean
}

function remainingTo(targetMs: number, nowMs: number): Remaining {
  const diff = Math.max(0, targetMs - nowMs)
  const expired = diff <= 0
  const totalSeconds = Math.floor(diff / 1000)
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired,
  }
}

export function LxCountdown({
  data,
  outerClass,
}: {
  data: BlockData<'lx_countdown'>
  outerClass?: string
}) {
  const targetMs = Date.parse(data.target)
  // Deterministic server snapshot: assume the full duration remains
  // (target − target = full from an unknown "now" would be 0, so we
  // render zeros server-side and let the effect fill the real values).
  // suppressHydrationWarning covers the swap.
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    if (Number.isNaN(targetMs)) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [targetMs])

  const r =
    now === null || Number.isNaN(targetMs)
      ? { days: 0, hours: 0, minutes: 0, seconds: 0, expired: false }
      : remainingTo(targetMs, now)

  const isToken = isColorToken(data.tone)
  const digitClass = isToken ? TONE_DIGIT[data.tone] : undefined
  const labelClass = isToken ? TONE_LABEL[data.tone] : undefined
  const custom = !isToken ? resolveColorValue(data.tone) : undefined

  const units: Array<[boolean, number, string]> = [
    [data.showDays, r.days, 'Days'],
    [data.showHours, r.hours, 'Hours'],
    [data.showMinutes, r.minutes, 'Minutes'],
    [data.showSeconds, r.seconds, 'Seconds'],
  ]

  const composed =
    r.expired && now !== null ? (
      <p
        className={clsx('text-center font-serif text-2xl font-semibold tracking-tight', digitClass, outerClass)}
        style={custom ? { color: custom } : undefined}
      >
        {data.expiredText || 'This countdown has ended.'}
      </p>
    ) : (
      <div
        className={clsx('flex flex-wrap items-start justify-center gap-4 sm:gap-8', outerClass)}
        suppressHydrationWarning
      >
        {units
          .filter(([show]) => show)
          .map(([, n, label]) => (
            <div key={label} className="flex min-w-[3.5rem] flex-col items-center">
              <span
                className={clsx('font-serif text-5xl font-bold tabular-nums tracking-tight sm:text-6xl', digitClass)}
                style={custom ? { color: custom } : undefined}
                suppressHydrationWarning
              >
                {String(n).padStart(2, '0')}
              </span>
              <span className={clsx('mt-2 font-sans text-[10px] font-semibold uppercase tracking-eyebrow', labelClass)}>
                {label}
              </span>
            </div>
          ))}
      </div>
    )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
