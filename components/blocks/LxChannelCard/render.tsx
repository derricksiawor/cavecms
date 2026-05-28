import clsx from 'clsx'
import { ArrowUpRight } from 'lucide-react'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Luxury channel card — per ~/.claude/CLAUDE.md "No borders/border
// lines" and "Large icons with glow effects, gradient blur backgrounds
// for depth." The tile has NO border. Visual containment comes from
// a champagne radial glow behind the LARGE icon (h-12 w-12), and a
// hover-state translucent gradient bloom that swells when the whole
// card is a click target.
//
// Each card stacks: large glowing icon → display value (bold) → kicker
// label (semibold uppercase) → optional descriptor → optional
// arrow-link affordance. The whole card becomes a click target when
// `href` is set — same pattern as the legacy IconBox.

const TONE_TOKEN_CLASSES: Record<
  string,
  { valueText: string; labelText: string; descText: string }
> = {
  obsidian: {
    valueText: 'text-obsidian',
    labelText: 'text-champagne',
    descText: 'text-warm-stone',
  },
  ivory: {
    valueText: 'text-ivory',
    labelText: 'text-champagne',
    descText: 'text-ivory/70',
  },
}

const EXTERNAL_HREF_RE = /^https?:\/\//i

export function LxChannelCard({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_channel_card'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  // Tone resolution — token names use the cacheable Tailwind classes,
  // custom hex values fall back to inline-style colours. labelText
  // stays champagne by design (it's the signature accent) so custom
  // hex tone only re-tints the value/desc text.
  const toneRaw = data.tone
  const isToken = isColorToken(toneRaw)
  const tone =
    (isToken && TONE_TOKEN_CLASSES[toneRaw]) ||
    ({ valueText: '', labelText: 'text-champagne', descText: '' } as const)
  const customColor = !isToken ? resolveColorValue(toneRaw) : undefined
  const valueStyle = customColor ? { color: customColor } : undefined
  const descStyle = customColor
    ? { color: customColor, opacity: 0.7 }
    : undefined
  const hasIcon = !!data.icon

  // Kicker — pill-style label above the value. No border; soft
  // champagne tint. Inline-edit swaps to the editable surface; the
  // visual still reads as a label.
  const kicker = inlineEdit ? (
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
        tone.labelText,
      )}
      placeholder="KICKER"
    />
  ) : (
    <span
      className={clsx(
        'font-sans text-xs font-semibold uppercase tracking-eyebrow',
        tone.labelText,
      )}
    >
      {data.label}
    </span>
  )

  const tileInner = (
    <div className="relative flex flex-col items-start gap-4 p-8 transition-all duration-base ease-luxury group-hover:scale-[1.02]">
      {hasIcon && (
        <div className="relative flex h-16 w-16 items-center justify-center">
          {/* Glow halo behind the icon — large champagne radial blur
             positioned absolutely so the icon glyph sits on a lit
             field rather than a flat surface. */}
          <div
            aria-hidden="true"
            className="lx-glow-champagne-icon absolute inset-0"
          />
          <IconByName
            name={data.icon}
            className={clsx('relative h-10 w-10', tone.labelText)}
            aria-hidden
          />
        </div>
      )}
      {kicker}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="value"
          kind="plain"
          initialValue={data.value}
          as="p"
          className={clsx(
            'font-serif text-2xl font-bold tracking-tight leading-tight',
            tone.valueText,
          )}
          style={valueStyle}
          placeholder="Value"
        />
      ) : (
        <p
          className={clsx(
            'font-serif text-2xl font-bold tracking-tight leading-tight',
            tone.valueText,
          )}
          style={valueStyle}
        >
          {data.value}
        </p>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="description"
          kind="plain"
          initialValue={data.description ?? ''}
          as="p"
          className={clsx(
            'font-sans text-sm font-medium leading-relaxed',
            tone.descText,
          )}
          style={descStyle}
          placeholder="Description"
        />
      ) : (
        data.description && (
          <p
            className={clsx(
              'font-sans text-sm font-medium leading-relaxed',
              tone.descText,
            )}
            style={descStyle}
          >
            {data.description}
          </p>
        )
      )}
      {inlineEdit && (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="href"
          kind="url"
          initialValue={data.href ?? ''}
          as="span"
          className="font-sans text-xs text-warm-stone"
          placeholder="mailto:hello@example.com"
        />
      )}
      {data.href && !inlineEdit && (
        <span
          className={clsx(
            'mt-2 inline-flex items-center gap-1.5 font-sans text-sm font-semibold tracking-tight',
            tone.labelText,
            'group-hover:text-antique-gold transition-colors duration-base ease-luxury',
          )}
        >
          <span>Reach out</span>
          <ArrowUpRight
            size={16}
            strokeWidth={2.5}
            aria-hidden="true"
            className="transition-transform duration-base ease-luxury group-hover:translate-x-1 group-hover:-translate-y-0.5"
          />
        </span>
      )}
    </div>
  )

  if (inlineEdit || !data.href) {
    return <div className={outerClass}>{tileInner}</div>
  }

  const isExternal = EXTERNAL_HREF_RE.test(data.href)
  return (
    <div className={outerClass}>
      <a
        href={data.href}
        target={isExternal ? '_blank' : undefined}
        rel={isExternal ? 'noopener noreferrer nofollow' : undefined}
        className="group block"
      >
        {tileInner}
      </a>
    </div>
  )
}
