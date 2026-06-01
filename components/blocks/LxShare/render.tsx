'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Mail, Link2, Check } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Share buttons (Elementor: Share Buttons). Share intents are built from
// the CURRENT page URL at click time — no operator-supplied URL, so no
// injection surface. Brand glyphs use the bundled official simple-icons
// SVGs (per #0.57) via CSS mask; email + copy use lucide utility icons.
// The email option is a recipient-less mailto (no address in the DOM) so
// Cloudflare email-obfuscation never touches it.

const SIZE_PX: Record<BlockData<'lx_share'>['size'], number> = { sm: 16, md: 20, lg: 24 }
const BTN_SIZE: Record<BlockData<'lx_share'>['size'], string> = {
  sm: 'h-9 w-9',
  md: 'h-11 w-11',
  lg: 'h-12 w-12',
}
const ALIGN: Record<BlockData<'lx_share'>['alignment'], string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}
const TONE_BTN: Record<string, string> = {
  obsidian: 'text-obsidian/80 ring-obsidian/10 hover:text-champagne hover:ring-champagne/40',
  ivory: 'text-ivory/80 ring-ivory/15 hover:text-champagne hover:ring-champagne/50',
  'warm-stone': 'text-warm-stone ring-warm-stone/20 hover:text-champagne hover:ring-champagne/40',
}

function MaskGlyph({ src, px }: { src: string; px: number }) {
  return (
    <span
      aria-hidden="true"
      className="block bg-current"
      style={{
        width: `${px}px`,
        height: `${px}px`,
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  )
}

export function LxShare({
  data,
  outerClass,
}: {
  data: BlockData<'lx_share'>
  outerClass?: string
}) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])
  const px = SIZE_PX[data.size]
  const btnSize = BTN_SIZE[data.size]
  const isToken = isColorToken(data.tone)
  const toneClass = isToken ? TONE_BTN[data.tone] : undefined
  const custom = !isToken ? resolveColorValue(data.tone) : undefined

  const currentUrl = useCallback(
    () => (typeof window !== 'undefined' ? window.location.href : ''),
    [],
  )

  const openShare = useCallback(
    (build: (u: string) => string) => {
      const url = build(encodeURIComponent(currentUrl()))
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    [currentUrl],
  )

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentUrl())
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard denied — no-op */
    }
  }, [currentUrl])

  const shareEmail = useCallback(() => {
    // Built at click time (not render) so there is no operator email in
    // the SSR DOM and no SSR/client href hydration mismatch.
    window.location.href = `mailto:?body=${encodeURIComponent(currentUrl())}`
  }, [currentUrl])

  const btnClass = clsx(
    'inline-flex items-center justify-center rounded-full ring-1 backdrop-blur-sm transition-colors',
    btnSize,
    toneClass,
  )

  const buttons: React.ReactNode[] = []
  if (data.shareX)
    buttons.push(
      <button key="x" type="button" aria-label="Share on X" onClick={() => openShare((u) => `https://twitter.com/intent/tweet?url=${u}`)} className={btnClass} style={custom ? { color: custom } : undefined}>
        <MaskGlyph src="/icons/social/twitter.svg" px={px} />
      </button>,
    )
  if (data.shareLinkedin)
    buttons.push(
      <button key="li" type="button" aria-label="Share on LinkedIn" onClick={() => openShare((u) => `https://www.linkedin.com/sharing/share-offsite/?url=${u}`)} className={btnClass} style={custom ? { color: custom } : undefined}>
        <MaskGlyph src="/icons/social/linkedin.svg" px={px} />
      </button>,
    )
  if (data.shareFacebook)
    buttons.push(
      <button key="fb" type="button" aria-label="Share on Facebook" onClick={() => openShare((u) => `https://www.facebook.com/sharer/sharer.php?u=${u}`)} className={btnClass} style={custom ? { color: custom } : undefined}>
        <MaskGlyph src="/icons/social/facebook.svg" px={px} />
      </button>,
    )
  if (data.shareEmail)
    buttons.push(
      <button key="email" type="button" onClick={shareEmail} aria-label="Share by email" className={btnClass} style={custom ? { color: custom } : undefined}>
        <Mail style={{ width: px, height: px }} strokeWidth={1.75} aria-hidden="true" />
      </button>,
    )
  if (data.shareCopy)
    buttons.push(
      <button key="copy" type="button" aria-label={copied ? 'Link copied' : 'Copy link'} onClick={copyLink} className={btnClass} style={custom ? { color: custom } : undefined}>
        {copied ? (
          <Check style={{ width: px, height: px }} strokeWidth={2} className="text-champagne" aria-hidden="true" />
        ) : (
          <Link2 style={{ width: px, height: px }} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>,
    )

  const composed = (
    <div className={clsx('flex flex-wrap items-center gap-3', ALIGN[data.alignment], outerClass)}>
      {data.label && (
        <span className="font-sans text-xs font-semibold uppercase tracking-eyebrow text-warm-stone">
          {data.label}
        </span>
      )}
      {buttons}
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
