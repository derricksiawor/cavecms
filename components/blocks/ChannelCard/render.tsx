import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Channel card — the editorial 3-up "ways to reach us" tile. Bordered,
// rounded, generously padded; carries a kicker label, a body paragraph,
// and an optional action link. Address-shaped cards omit `action`
// (nowhere to click — just an info card); Email / Phone / WhatsApp /
// social cards include the mailto: / tel: / https: action.
//
// Shape ported from the boxxticket /contact reference: rounded-3xl
// dark-on-dark card with internal padding-8. CaveCMS tokens map dark-on-
// dark → cream-50 fill with warm-stone/20 ring on top of the surrounding
// cream-100 section bg. Copper action link replaces boxxticket's gold.
//
// External-vs-internal href detection drives the rel attribute. Internal
// hrefs (relative paths, same-origin) never carry "nofollow" so internal
// PageRank flow isn't blocked. "noopener noreferrer" still applies to
// internal new-tab opens for window.opener safety.

interface ChannelCardData {
  label: string
  body: string
  action?: {
    text: string
    href: string
    openInNew?: boolean
  }
}

const EXTERNAL_HREF_RE = /^https?:/i
function linkRel(href: string, openInNew?: boolean): string | undefined {
  if (!openInNew) return undefined
  return EXTERNAL_HREF_RE.test(href)
    ? 'noopener noreferrer nofollow'
    : 'noopener noreferrer'
}

export function ChannelCard({
  data,
  inlineEdit,
  outerClass,
}: {
  data: ChannelCardData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  return (
    <article
      className={clsx(
        'rounded-3xl border border-warm-stone/20 bg-cream-50 p-8',
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
          field="label"
          kind="plain"
          initialValue={data.label}
          as="p"
          className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone"
          placeholder="LABEL"
        />
      ) : (
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          {data.label}
        </p>
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
          initialValue={data.body}
          as="p"
          className="mt-4 text-sm leading-relaxed text-near-black/70"
          placeholder="Body…"
        />
      ) : (
        <p className="mt-4 text-sm leading-relaxed text-near-black/70">
          {data.body}
        </p>
      )}
      {inlineEdit ? (
        // Editing: action text + href surface as paired inline editors.
        // The <a> wrapper is dropped in edit mode so the inline editor
        // isn't shadowed by a navigation target.
        <span className="mt-6 inline-flex flex-col items-start gap-1">
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="action.text"
            kind="plain"
            initialValue={data.action?.text ?? ''}
            as="span"
            className="text-base font-semibold text-copper-600"
            placeholder="Action label"
          />
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="action.href"
            kind="plain"
            initialValue={data.action?.href ?? ''}
            as="span"
            className="text-xs font-mono text-warm-stone"
            placeholder="/contact"
          />
        </span>
      ) : (
        data.action && (
          <a
            href={data.action.href}
            target={data.action.openInNew ? '_blank' : undefined}
            rel={linkRel(data.action.href, data.action.openInNew)}
            className="mt-6 inline-block text-base font-semibold text-copper-600 transition hover:text-copper-700"
          >
            {data.action.text}
          </a>
        )
      )}
    </article>
  )
}
