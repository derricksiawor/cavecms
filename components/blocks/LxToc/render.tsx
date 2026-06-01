import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Table of contents (Elementor: Table of Contents) — manual anchor list.
// Each item links to a block's HTML id (set in that block's Advanced
// tab) or an lx_menu_anchor. Server component.

const TONE_TITLE: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_LINK: Record<string, string> = {
  obsidian: 'text-warm-stone hover:text-obsidian',
  ivory: 'text-ivory/70 hover:text-ivory',
}

export function LxToc({
  data,
  outerClass,
}: {
  data: BlockData<'lx_toc'>
  outerClass?: string
}) {
  const isToken = isColorToken(data.tone)
  const titleClass = isToken ? TONE_TITLE[data.tone] : undefined
  const linkClass = isToken ? TONE_LINK[data.tone] : undefined
  const custom = !isToken ? resolveColorValue(data.tone) : undefined

  const composed = (
    <nav
      aria-label={data.title || 'Table of contents'}
      className={clsx(
        'mx-auto w-full max-w-md rounded-2xl border border-champagne/20 px-7 py-6',
        outerClass,
      )}
    >
      {data.title && (
        <p
          className={clsx('mb-4 font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne')}
        >
          {data.title}
        </p>
      )}
      <ul className="flex flex-col gap-2.5">
        {data.items.map((item, i) => (
          <li key={i}>
            <a
              href={`#${item.anchor}`}
              className={clsx(
                'group flex items-center gap-2 font-sans text-sm transition-colors',
                linkClass,
              )}
              style={custom ? { color: custom } : undefined}
            >
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-champagne transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
              <span className={clsx(titleClass)} style={custom ? { color: custom } : undefined}>
                {item.label}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
