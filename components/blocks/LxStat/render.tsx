'use client'

import clsx from 'clsx'
import { useCallback } from 'react'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import { useCountUp } from '@/lib/motion/useCountUp'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  FAMILY_TAILWIND,
  fontWeightClass,
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury animated stat — count-up number + label. Per ~/.claude/CLAUDE.md
// "Large icons with glow effects... primary color highlights." The
// number sits on a CHAMPAGNE GLOW BACKDROP (radial blur halo) so it
// reads as "lit from behind" — primary highlight via depth, not a
// border or chrome.
//
// Bold Montserrat in champagne for the number; label below in
// uppercase semibold for the editorial-label hierarchy.

const ALIGN_CLASS: Record<BlockData<'lx_stat'>['alignment'], string> = {
  left: 'text-left items-start',
  center: 'text-center items-center',
  right: 'text-right items-end',
}

const TONE_VALUE_CLASS: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
  champagne: 'text-champagne',
}

const TONE_LABEL_CLASS: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/70',
  champagne: 'text-obsidian/70',
}


export function LxStat({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_stat'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const prefix = data.prefix ?? ''
  const suffix = data.suffix ?? ''
  const decimals = data.decimals

  const format = useCallback(
    (n: number) => {
      const num = decimals > 0 ? n.toFixed(decimals) : String(Math.round(n))
      return `${prefix}${num}${suffix}`
    },
    [prefix, suffix, decimals],
  )

  const [text, ref] = useCountUp({
    to: data.value,
    duration: data.duration_ms / 1000,
    format,
  })

  const tone = data.tone
  const isToken = isColorToken(tone)
  const valueToneClass = isToken ? TONE_VALUE_CLASS[tone] : undefined
  const labelToneClass = isToken ? TONE_LABEL_CLASS[tone] : undefined
  const resolved = !isToken ? resolveColorValue(tone) : undefined
  const valueStyle = resolved ? { color: resolved } : undefined
  const labelStyle = resolved ? { color: resolved, opacity: 0.7 } : undefined

  const family = data.family
  const familyClass = family ? FAMILY_TAILWIND[family] : 'font-sans'
  const overrideWeight = data.weight
  const weightClass = overrideWeight
    ? fontWeightClass(overrideWeight)
    : 'font-bold'

  return (
    <div
      className={clsx(
        'flex flex-col gap-3',
        ALIGN_CLASS[data.alignment],
        outerClass,
      )}
    >
      {/* Glow + number stack — the radial blur sits absolutely
         behind the number element. The relative wrapper anchors
         the absolute children to the number's own box. */}
      <div className="relative inline-flex">
        <div
          aria-hidden="true"
          className="lx-glow-champagne absolute -inset-8"
        />
        <span
          ref={ref}
          className={clsx(
            'relative',
            familyClass,
            weightClass,
            'tracking-tight leading-none',
            'text-6xl sm:text-7xl md:text-8xl',
            valueToneClass,
          )}
          style={valueStyle}
        >
          {text}
        </span>
      </div>
      {inlineEdit && (
        // Prefix/suffix surface as paired tiny inline editors above the
        // label so the operator can tune both without opening the
        // drawer. Empty placeholders read as "+", "%", etc. The
        // count-up render above keeps using the persisted prefix/suffix
        // until a save lands and the parent re-renders with the new
        // data — same propagation contract as every other inline-edit
        // path.
        <span className="inline-flex items-center gap-3 text-[10px] font-mono text-warm-stone">
          <span>
            prefix:{' '}
            <InlineEditable
              blockId={inlineEdit.blockId}
              blockVersion={inlineEdit.blockVersion}
              pageId={inlineEdit.pageId}
              pageVersion={inlineEdit.pageVersion}
              initialData={data}
              field="prefix"
              kind="plain"
              initialValue={data.prefix ?? ''}
              as="span"
              placeholder="—"
            />
          </span>
          <span>
            suffix:{' '}
            <InlineEditable
              blockId={inlineEdit.blockId}
              blockVersion={inlineEdit.blockVersion}
              pageId={inlineEdit.pageId}
              pageVersion={inlineEdit.pageVersion}
              initialData={data}
              field="suffix"
              kind="plain"
              initialValue={data.suffix ?? ''}
              as="span"
              placeholder="—"
            />
          </span>
        </span>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="label"
          kind="plain"
          initialValue={data.label}
          as="span"
          className={clsx(
            'font-sans text-xs font-semibold uppercase tracking-eyebrow',
            labelToneClass,
          )}
          style={labelStyle}
          placeholder="Stat label"
        />
      ) : (
        <span
          className={clsx(
            'font-sans text-xs font-semibold uppercase tracking-eyebrow',
            labelToneClass,
          )}
          style={labelStyle}
        >
          {data.label}
        </span>
      )}
    </div>
  )
}
