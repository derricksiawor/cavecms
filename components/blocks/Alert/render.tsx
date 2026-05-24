import clsx from 'clsx'
import { Info, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import type { BlockData } from '@/lib/cms/block-registry'
import { AlertDismissible } from './AlertDismissible'

// Elementor-parity Alert widget. Canonical fields per
// `includes/widgets/alert.php`:
//   - alert_type (info | success | warning | danger) - default info
//   - alert_title (text)
//   - alert_description (textarea)
//   - show_dismiss (yes | no) + dismiss_icon
//   - per-state typography + colour tokens
//   - alignment (left | right)
//
// BWC ships a copper-on-near-black palette - NEVER Bootstrap candy
// colours per researcher's luxury default. The variant drives the
// ICON only; surface remains the same near-black card with copper
// left-border accent. Reserved for listing-status banners ("Under
// contract"), compliance disclosures, open-house notices.
//
// Dismissibility:
//   - dismissible=false (default) -> static server-rendered alert.
//   - dismissible=true -> AlertDismissible client component reads
//     localStorage on mount and hides if previously dismissed.
//   - Storage key is `bwc:alert:${blockId}:${contentHash}`. blockId
//     scopes the dismissal to ONE specific block row, so two distinct
//     Alert blocks with identical text don't share a dismissal slot.
//     contentHash invalidates dismissal whenever the operator edits
//     the title/body/variant - a republish without content change
//     does NOT invalidate (intended: same content stays dismissed).
//   - Edit mode (inlineEdit) ALWAYS renders the alert visibly (the
//     operator must see the surface they're editing). The dismiss
//     button is suppressed in edit mode.
//
// a11y:
//   - role="status" for info/success (announcements that don't
//     interrupt - matches WAI-ARIA live-region polite).
//   - role="alert" for warning/error (assertive - announces
//     immediately on render).
//
// Reference URLs:
//   - https://elementor.com/help/alert-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/alert.php

type AlertData = BlockData<'alert'>

const VARIANT_ICON: Record<AlertData['variant'], typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
}

const VARIANT_ROLE: Record<AlertData['variant'], 'status' | 'alert'> = {
  info: 'status',
  success: 'status',
  warning: 'alert',
  error: 'alert',
}

// Shared outer-section wrapper. Hoisted as a constant so the three
// render branches (edit-mode / dismissible / static) and the
// AlertDismissible client wrapper all read from a single source.
export const ALERT_SECTION_CLASS = 'py-8 sm:py-12 px-4 sm:px-6 max-w-3xl mx-auto'

// 64-bit composite content hash. Two separately-mixed 32-bit hash
// streams (djb2 + FNV-1a-style XOR-multiply) concatenated as base36.
// The 32-bit djb2 alone produces a ~50% birthday-collision risk at
// only 65k distinct alerts - the visitor's localStorage could
// plausibly dismiss tens of alerts over time, and even though a
// collision is harmless (one extra alert suppressed), pushing to a
// 64-bit space removes the failure mode entirely. Not cryptographic
// - localStorage is per-origin + per-user; no integrity gate here.
function hashAlertContent(d: AlertData): string {
  const s = `${d.variant}:${d.title}:${d.body_richtext}`
  let h1 = 5381
  let h2 = 0x811c9dc5 | 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = ((h1 << 5) + h1 + c) | 0
    h2 = Math.imul(h2 ^ c, 0x01000193) | 0
  }
  return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`
}

// Body content visibility check. body_richtext goes through DOMPurify
// at write time, so any tag survives. An empty/whitespace-only body
// or a body of just-whitespace tags (operator pressed Enter then
// cleared text) renders a sad-looking empty prose block. Strip tags
// + collapse whitespace before deciding whether to render the body.
function bodyHasVisibleContent(richtext: string): boolean {
  return richtext.replace(/<[^>]*>/g, '').trim().length > 0
}

export function Alert({
  data,
  inlineEdit,
  outerClass,
  blockId,
}: {
  data: AlertData
  inlineEdit?: InlineEditContext
  outerClass?: string
  blockId?: number
}) {
  const Icon = VARIANT_ICON[data.variant]
  const role = VARIANT_ROLE[data.variant]
  const showBody = bodyHasVisibleContent(data.body_richtext)

  // The visual layer is shared between the static, dismissible, and
  // edit-mode flavours. Hoisted to a local node so the three render
  // paths can wrap or replace it cheaply.
  const content = (
    <div
      role={role}
      aria-live={role === 'status' ? 'polite' : 'assertive'}
      className={clsx(
        'relative flex gap-4 rounded-2xl border border-copper-400/20 bg-near-black px-6 py-5 text-cream-50 sm:px-7 sm:py-6',
        'before:absolute before:left-0 before:top-3 before:bottom-3 before:w-1 before:rounded-r-full before:bg-copper-500',
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className="mt-0.5 h-5 w-5 shrink-0 text-copper-400"
      />
      <div className="flex-1 space-y-2">
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
            as="p"
            className="text-sm font-semibold tracking-wide"
            placeholder="Alert title…"
          />
        ) : (
          <p className="text-sm font-semibold tracking-wide">{data.title}</p>
        )}
        {showBody && (
          <div
            // body_richtext sanitised via RICHTEXT_FIELDS in parse.ts
            // at both write and read boundaries (see lib/cms/parse.ts).
            // Safe to dangerouslySetInnerHTML here. `prose-invert`
            // recolours the default dark `--tw-prose-body` token so
            // copy reads correctly on the near-black surface.
            className="prose prose-sm prose-invert max-w-none prose-p:text-cream-50/85 prose-li:text-cream-50/85 prose-a:text-copper-300 prose-a:no-underline hover:prose-a:underline prose-strong:text-cream-50 prose-em:text-copper-300 prose-li:marker:text-copper-400"
            dangerouslySetInnerHTML={{ __html: data.body_richtext }}
          />
        )}
      </div>
    </div>
  )

  // Edit mode - never dismissible regardless of operator setting; the
  // operator must always see the alert they're editing.
  if (inlineEdit) {
    return (
      <section className={clsx(ALERT_SECTION_CLASS, outerClass)}>{content}</section>
    )
  }

  // Public + dismissible. Needs blockId for the per-block dismissal
  // key. If blockId is somehow missing (renderer called outside a
  // BlockTreeRenderer context — defensive), fall back to a non-
  // dismissible static render instead of clobbering localStorage with
  // an unscoped key.
  if (data.dismissible && typeof blockId === 'number') {
    return (
      <AlertDismissible
        contentKey={`${blockId}:${hashAlertContent(data)}`}
        outerClass={outerClass}
      >
        {content}
      </AlertDismissible>
    )
  }

  // Default - static server render.
  return (
    <section className={clsx(ALERT_SECTION_CLASS, outerClass)}>{content}</section>
  )
}
