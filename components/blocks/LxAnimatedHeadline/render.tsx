'use client'

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { BlockData } from '@/lib/cms/block-registry'
import {
  FAMILY_TAILWIND,
  fontWeightClass,
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Animated headline (Elementor: Animated Headline). A static prefix +
// rotating/typed words + optional suffix. Hydration-safe: the server
// renders words[0]; the cycling effect starts only after mount in
// useEffect, so SSR and first client render match. prefers-reduced-
// motion freezes on words[0] (the rotation is decorative).

const SIZE_CLASS: Record<BlockData<'lx_animated_headline'>['size'], string> = {
  'display-2xl': 'text-5xl sm:text-6xl md:text-7xl',
  'display-xl': 'text-4xl sm:text-5xl md:text-6xl',
  'display-lg': 'text-3xl sm:text-4xl md:text-5xl',
  'display-md': 'text-2xl sm:text-3xl md:text-4xl',
  'display-sm': 'text-xl sm:text-2xl md:text-3xl',
}
const ALIGN_CLASS: Record<BlockData<'lx_animated_headline'>['alignment'], string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}
const TOKEN_TEXT_CLASS: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
  champagne: 'text-champagne',
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

export function LxAnimatedHeadline({
  data,
  outerClass,
}: {
  data: BlockData<'lx_animated_headline'>
  outerClass?: string
}) {
  const reduced = usePrefersReducedMotion()
  const [index, setIndex] = useState(0)
  const [typed, setTyped] = useState(data.words[0] ?? '')
  const words = data.words

  // rotate / fade: advance the word index on an interval.
  useEffect(() => {
    if (reduced || data.effect === 'type' || words.length <= 1) return
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % words.length)
    }, data.intervalMs)
    return () => clearInterval(id)
  }, [reduced, data.effect, data.intervalMs, words.length])

  // typewriter: type the current word out, pause, delete, advance.
  const phaseRef = useRef<'typing' | 'pausing' | 'deleting'>('typing')
  useEffect(() => {
    if (reduced || data.effect !== 'type') {
      setTyped(words[0] ?? '')
      return
    }
    let raf: ReturnType<typeof setTimeout>
    let i = index
    let text = ''
    phaseRef.current = 'typing'
    const word = () => words[i % words.length] ?? ''
    const tick = () => {
      const w = word()
      if (phaseRef.current === 'typing') {
        text = w.slice(0, text.length + 1)
        setTyped(text)
        if (text === w) {
          phaseRef.current = 'pausing'
          raf = setTimeout(tick, data.intervalMs)
          return
        }
        raf = setTimeout(tick, 90)
      } else if (phaseRef.current === 'pausing') {
        phaseRef.current = 'deleting'
        raf = setTimeout(tick, 40)
      } else {
        text = w.slice(0, Math.max(0, text.length - 1))
        setTyped(text)
        if (text === '') {
          i = (i + 1) % words.length
          setIndex(i)
          phaseRef.current = 'typing'
        }
        raf = setTimeout(tick, 40)
      }
    }
    raf = setTimeout(tick, 400)
    return () => clearTimeout(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, data.effect, data.intervalMs, words])

  const Tag = data.level
  const family = data.family
  const familyClass = family ? FAMILY_TAILWIND[family] : 'font-serif'
  const weightClass = data.weight ? fontWeightClass(data.weight) : 'font-bold'
  const toneClass = isColorToken(data.tone) ? TOKEN_TEXT_CLASS[data.tone] : undefined
  const toneStyle = !isColorToken(data.tone) ? { color: resolveColorValue(data.tone) } : undefined

  const current = words[index] ?? ''
  const animClass =
    reduced || data.effect === 'type'
      ? ''
      : data.effect === 'rotate'
        ? 'animate-cavecms-slide-up'
        : 'animate-cavecms-fade-in'

  return (
    <Tag
      className={clsx(
        familyClass,
        weightClass,
        'tracking-tight leading-tight',
        SIZE_CLASS[data.size],
        ALIGN_CLASS[data.alignment],
        toneClass,
        outerClass,
      )}
      style={toneStyle}
    >
      {data.prefix && <span>{data.prefix} </span>}
      <span className="text-champagne" suppressHydrationWarning>
        {data.effect === 'type' ? (
          <>
            {typed}
            <span className="ml-0.5 inline-block w-px animate-cavecms-pulse-copper align-baseline" aria-hidden="true">
              |
            </span>
          </>
        ) : (
          <span key={index} className={clsx('inline-block', animClass)}>
            {current}
          </span>
        )}
      </span>
      {data.suffix && <span> {data.suffix}</span>}
    </Tag>
  )
}
