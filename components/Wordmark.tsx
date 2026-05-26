'use client'

import { motion } from 'framer-motion'

/**
 * Brand wordmark: Lucide paintbrush ringed by five twinkling sparkles
 * to signal AI. Tailwind classes use ivory + champagne tokens — swap
 * `text-ivory` for your foreground colour and the `#c9a961` glow tint
 * for your accent if you're not on the obsidian/gold palette.
 */
export function Wordmark({
  size = 'md',
  animated = true,
  label = 'CaveCMS',
  tone = 'light',
}: {
  size?: 'sm' | 'md' | 'lg'
  animated?: boolean
  label?: string
  /** 'light' = ivory text (for dark backgrounds — admin sidebar).
   *  'dark'  = near-black text (for cream backgrounds — install wizard). */
  tone?: 'light' | 'dark'
}) {
  const dim = size === 'lg' ? 30 : size === 'sm' ? 18 : 22
  const wrapDim = dim + 22

  const sparkles = [
    // top-right — biggest, leads the eye
    { x: dim * 0.78, y: -dim * 0.18, size: dim * 0.42, delay: 0 },
    // bottom-left — counterpoint
    { x: -dim * 0.18, y: dim * 0.7, size: dim * 0.32, delay: 0.8 },
    // top-left corner — tiny accent
    { x: -dim * 0.05, y: -dim * 0.05, size: dim * 0.24, delay: 1.6 },
    // mid-left — balances left side
    { x: -dim * 0.5, y: dim * 0.28, size: dim * 0.36, delay: 2.2 },
    // above brush, leaning left
    { x: -dim * 0.32, y: -dim * 0.6, size: dim * 0.34, delay: 1.2 },
  ]

  return (
    <span className="group inline-flex items-center gap-2.5">
      <span
        className="relative inline-flex items-center justify-center"
        style={{ width: wrapDim, height: wrapDim, marginLeft: -11, marginRight: -7 }}
      >
        <motion.span
          className="relative inline-flex items-center justify-center"
          style={{ width: dim, height: dim }}
          whileHover={
            animated
              ? {
                  rotate: [0, -14, 10, -6, 0],
                  transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1] },
                }
              : undefined
          }
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icons/paintbrush.svg"
            alt=""
            width={dim}
            height={dim}
            className="drop-shadow-[0_0_8px_rgba(201,169,97,0.4)] transition-[filter] duration-500 group-hover:drop-shadow-[0_0_14px_rgba(201,169,97,0.7)]"
          />
        </motion.span>

        {animated &&
          sparkles.map((s, i) => (
            <motion.span
              key={i}
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                left: '50%',
                top: '50%',
                width: s.size,
                height: s.size,
                marginLeft: s.x - s.size / 2,
              }}
              animate={{
                opacity: [0, 1, 0.6, 1, 0],
                scale: [0.3, 1, 0.85, 1, 0.3],
                rotate: [0, 90, 180],
              }}
              transition={{
                duration: 3.4,
                delay: s.delay,
                repeat: Infinity,
                ease: 'easeInOut',
                times: [0, 0.25, 0.5, 0.75, 1],
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/icons/sparkle.svg"
                alt=""
                width={s.size}
                height={s.size}
                className="h-full w-full drop-shadow-[0_0_6px_rgba(201,169,97,0.9)]"
              />
            </motion.span>
          ))}
      </span>

      <span
        className={`font-display text-[15px] font-semibold tracking-[0.04em] ${
          tone === 'dark' ? 'text-near-black' : 'text-ivory'
        }`}
        style={{ fontFeatureSettings: '"ss01"' }}
      >
        {label}
      </span>
    </span>
  )
}
