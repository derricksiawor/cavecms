import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Luxury CTA banner — eyebrow + title + body + primary CTA + optional
// secondary CTA. Sits as a full-width band; operator picks the
// surrounding section background via section meta. Designed for the
// closing banner on a landing page ("ready to start?" / "book a
// table" / "request a quote").

const ALIGN_CLASS: Record<BlockData<'lx_cta_banner'>['alignment'], string> = {
  left: 'text-left items-start',
  center: 'text-center items-center mx-auto',
}

const TONE_TITLE: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

const TONE_BODY: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/80',
}

const TONE_EYEBROW: Record<string, string> = {
  obsidian: 'text-copper-700',
  ivory: 'text-champagne',
}

export function LxCtaBanner({
  data,
  inlineEdit,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_cta_banner'>
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const titleClass = isToken ? TONE_TITLE[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const eyebrowClass = isToken ? TONE_EYEBROW[tone] : undefined
  const customColor = !isToken ? resolveColorValue(tone) : undefined

  const primaryButtonClass =
    tone === 'ivory'
      ? 'bg-champagne text-obsidian hover:bg-antique-gold hover:text-ivory'
      : 'bg-obsidian text-ivory hover:bg-near-black'

  const secondaryButtonClass =
    tone === 'ivory'
      ? 'border border-ivory/40 text-ivory hover:bg-ivory/10'
      : 'border border-obsidian/30 text-obsidian hover:bg-obsidian/5'

  const composed = (
    <div
      className={clsx(
        'flex flex-col gap-6 max-w-3xl',
        ALIGN_CLASS[data.alignment],
        outerClass,
      )}
    >
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="eyebrow"
          kind="text"
          initialValue={data.eyebrow ?? ''}
          as="p"
          className={clsx(
            'font-sans text-xs font-semibold uppercase tracking-eyebrow',
            eyebrowClass,
          )}
          style={customColor ? { color: customColor } : undefined}
          placeholder="Eyebrow (optional)"
        />
      ) : (
        data.eyebrow && (
          <p
            className={clsx(
              'font-sans text-xs font-semibold uppercase tracking-eyebrow',
              eyebrowClass,
            )}
            style={customColor ? { color: customColor } : undefined}
          >
            {data.eyebrow}
          </p>
        )
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="title"
          kind="plain"
          initialValue={data.title}
          as="h2"
          className={clsx(
            'font-serif font-semibold tracking-tight leading-[1.08]',
            'text-4xl sm:text-5xl md:text-6xl',
            titleClass,
          )}
          style={customColor ? { color: customColor } : undefined}
          placeholder="Headline"
        />
      ) : (
        <h2
          className={clsx(
            'font-serif font-semibold tracking-tight leading-[1.08]',
            'text-4xl sm:text-5xl md:text-6xl',
            titleClass,
          )}
          style={customColor ? { color: customColor } : undefined}
        >
          {data.title}
        </h2>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="body"
          kind="text"
          initialValue={data.body ?? ''}
          as="p"
          className={clsx(
            'font-sans text-base sm:text-lg leading-relaxed max-w-2xl',
            bodyClass,
          )}
          style={customColor ? { color: customColor, opacity: 0.8 } : undefined}
          placeholder="Supporting copy (optional)"
        />
      ) : (
        data.body && (
          <p
            className={clsx(
              'font-sans text-base sm:text-lg leading-relaxed max-w-2xl',
              bodyClass,
            )}
            style={customColor ? { color: customColor, opacity: 0.8 } : undefined}
          >
            {data.body}
          </p>
        )
      )}
      <div
        className={clsx(
          'mt-2 flex flex-wrap gap-4',
          data.alignment === 'center' ? 'justify-center' : 'justify-start',
        )}
      >
        <a
          href={data.primaryCta.href}
          target={data.primaryCta.openInNew ? '_blank' : undefined}
          rel={data.primaryCta.openInNew ? 'noopener noreferrer' : undefined}
          className={clsx(
            'inline-flex w-fit items-center justify-center rounded-full px-8 py-3 font-sans text-[13px] font-semibold uppercase tracking-[0.22em] shadow-lg transition-colors',
            primaryButtonClass,
          )}
        >
          {data.primaryCta.label}
        </a>
        {data.secondaryCta && (
          <a
            href={data.secondaryCta.href}
            target={data.secondaryCta.openInNew ? '_blank' : undefined}
            rel={data.secondaryCta.openInNew ? 'noopener noreferrer' : undefined}
            className={clsx(
              'inline-flex w-fit items-center justify-center rounded-full px-8 py-3 font-sans text-[13px] font-semibold uppercase tracking-[0.22em] transition-colors',
              secondaryButtonClass,
            )}
          >
            {data.secondaryCta.label}
          </a>
        )}
      </div>
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
