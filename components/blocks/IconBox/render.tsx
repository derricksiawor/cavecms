import clsx from 'clsx'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Elementor-parity Icon Box widget. Canonical Elementor fields per
// `includes/widgets/icon-box.php`:
//   - selected_icon (icons library / SVG, default fas fa-star)
//   - view: default | stacked | framed
//   - shape: square | rounded | circle (applies to stacked/framed)
//   - title_text, description_text, link (URL)
//   - title_size: h1..h6 | div | span | p
//   - position: icon left/right/top/bottom; content_vertical_alignment
//
// Elementor-parity finding from web research (NON-OBVIOUS):
// **The classic Icon Box has NO separate CTA button field — the single
// `link` makes the entire box a clickable navigation target.** Operators
// who want an icon-headline-body-button composition use Spacer + Heading
// + Text + Button instead. CaveCMS matches this exactly to keep the widget
// catalog narrow and the composition predictable.
//
// CaveCMS collapses Elementor's view+shape+colour triplet into three named
// presets that map to the brand palette:
//   - copper-filled: solid copper circle with cream icon (high-emphasis)
//   - copper-outline: thin copper ring with copper icon (default)
//   - cream-tint: soft warm-stone background with near-black icon
//
// Icons resolve via Chunk C's iconForAmenity registry (shared with the
// project Amenities section). Unknown names fall back to a neutral
// checkmark — the registry never throws, so a typo in `icon` produces a
// degraded but visible widget instead of a 500.
//
// Reference URLs:
//   - https://elementor.com/help/icon-box-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/icon-box.php
//   - https://code.elementor.com/classes/elementor-widget-icon-box/

interface IconBoxData {
  icon: string
  headline: string
  body?: string
  link?: {
    href: string
    openInNew?: boolean
  }
  alignment: 'left' | 'center'
  accent: 'copper-filled' | 'copper-outline' | 'cream-tint'
  // Headline + body text colour. Defaults to 'near-black' so icon_boxes
  // on cream surfaces keep their legacy treatment. Sections on obsidian
  // / charcoal MUST pass tone='ivory' so the copy stays high-contrast.
  tone?: 'near-black' | 'ivory'
}

const TONE_CLASS: Record<
  NonNullable<IconBoxData['tone']>,
  { headline: string; body: string; meta: string }
> = {
  'near-black': {
    headline: 'text-near-black',
    body: 'text-warm-stone',
    meta: 'text-warm-stone',
  },
  ivory: {
    headline: 'text-ivory',
    body: 'text-ivory/85',
    meta: 'text-ivory/70',
  },
}

const ACCENT_CLASS: Record<
  IconBoxData['accent'],
  { wrap: string; icon: string }
> = {
  'copper-filled': {
    wrap: 'bg-copper-500 ring-1 ring-copper-600',
    icon: 'text-cream-50',
  },
  'copper-outline': {
    wrap: 'bg-cream-50 ring-1 ring-copper-400/60',
    icon: 'text-copper-600',
  },
  'cream-tint': {
    wrap: 'bg-warm-stone/15 ring-1 ring-warm-stone/20',
    icon: 'text-near-black',
  },
}

const ALIGN_CLASS: Record<IconBoxData['alignment'], string> = {
  left: 'text-left items-start',
  center: 'text-center items-center mx-auto',
}

// External-vs-internal href detection for the rel attribute. Internal
// hrefs (relative paths and same-origin links) must NOT carry "nofollow"
// because that blocks PageRank flow inside the site — explicit SEO
// anti-pattern. "noopener noreferrer" still applies to internal new-tab
// opens for window.opener safety.
const EXTERNAL_HREF_RE = /^https?:/i
function linkRel(href: string, openInNew?: boolean): string | undefined {
  if (!openInNew) return undefined
  return EXTERNAL_HREF_RE.test(href)
    ? 'noopener noreferrer nofollow'
    : 'noopener noreferrer'
}

export function IconBox({
  data,
  inlineEdit,
  outerClass,
}: {
  data: IconBoxData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const accent = ACCENT_CLASS[data.accent]
  const tone = TONE_CLASS[data.tone ?? 'near-black']
  const innerClass = clsx(
    'flex flex-col gap-4 max-w-md',
    ALIGN_CLASS[data.alignment],
  )
  const headlineClass = clsx(
    'text-xl font-semibold tracking-tight',
    tone.headline,
  )
  const bodyClass = clsx('text-sm leading-relaxed', tone.body)
  const metaClass = clsx('text-xs font-mono', tone.meta)

  const content = (
    <>
      <span
        className={clsx(
          'inline-flex h-14 w-14 items-center justify-center rounded-full',
          accent.wrap,
        )}
        aria-hidden="true"
      >
        <IconByName
          name={data.icon}
          className={clsx('h-6 w-6', accent.icon)}
          strokeWidth={1.75}
        />
      </span>
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="headline"
          kind="plain"
          initialValue={data.headline}
          as="h3"
          className={headlineClass}
          placeholder="Icon box headline…"
        />
      ) : (
        <h3 className={headlineClass}>{data.headline}</h3>
      )}
      {inlineEdit ? (
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="body"
          kind="plain"
          initialValue={data.body ?? ''}
          as="p"
          className={bodyClass}
          placeholder="Add supporting copy…"
        />
      ) : (
        data.body && <p className={bodyClass}>{data.body}</p>
      )}
      {inlineEdit && (
        // Thin url affordance — operator can retarget the box link
        // without opening the drawer. The link wrapper is disabled in
        // edit mode (see `wrap` below) so the inline editor isn't
        // shadowed by an <a>.
        <InlineEditable
          blockId={inlineEdit.blockId}
          blockVersion={inlineEdit.blockVersion}
          pageId={inlineEdit.pageId}
          pageVersion={inlineEdit.pageVersion}
          initialData={data}
          field="link.href"
          kind="plain"
          initialValue={data.link?.href ?? ''}
          as="span"
          className={metaClass}
          placeholder="/services"
        />
      )}
    </>
  )

  // Edit-mode disables the link wrapper — otherwise clicking the icon
  // span or body <p> (which aren't inside <InlineEditable>) would
  // trigger <a> navigation and abandon the operator's edit session.
  // Mirrors Button's edit-mode strategy of swapping the navigable
  // element for an inert one when inlineEdit is set.
  const wrap = !inlineEdit && data.link

  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      {wrap ? (
        <a
          href={data.link!.href}
          target={data.link!.openInNew ? '_blank' : undefined}
          rel={linkRel(data.link!.href, data.link!.openInNew)}
          className={clsx(
            innerClass,
            'transition-opacity duration-quick ease-standard hover:opacity-90',
          )}
        >
          {content}
        </a>
      ) : (
        <div className={innerClass}>{content}</div>
      )}
    </section>
  )
}
