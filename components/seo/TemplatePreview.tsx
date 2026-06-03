'use client'
import { useMemo } from 'react'
import { resolveTemplate } from '@/lib/seo/templates/resolve'
import type { TemplateContext } from '@/lib/seo/templates/types'

// Live Google-SERP preview for a title/description TEMPLATE pair. Given
// the raw `%variable%` template strings + a sample TemplateContext, it
// runs the SAME resolveTemplate() the renderer uses at request time and
// shows the operator EXACTLY what the resolved <title> + meta description
// will look like in a search result — including dangling-separator
// cleanup, so a template like `%title% %sep% %sitename%` with an empty
// title collapses correctly.
//
// SERP styling (the #1a0dab title blue, the green-grey URL, the two-line
// description clamp) intentionally mimics Google's result card, NOT the
// CaveCMS brand UI — operators trust a preview that matches the real
// thing. Mirrors components/inline-edit/SeoFields.tsx's snippet preview.
//
// Google truncates a title around ~600px (~60 chars) and a description
// around ~155 chars; we soft-clamp the title to one line (ellipsis) and
// the description to two lines, plus a copper character-count hint so the
// operator sees when the RESOLVED string runs long.

// Google's SERP soft limits (chars). Used only for the length hint — the
// renderer never truncates the stored template, only the resolved output
// is shown.
const TITLE_SOFT = 60
const DESC_SOFT = 155

export function TemplatePreview({
  titleTemplate,
  descriptionTemplate,
  context,
  /** The displayed URL line. When omitted, falls back to a tidy host-only
   *  rendering derived from the context's siteName. */
  url,
}: {
  titleTemplate: string
  descriptionTemplate: string
  context: TemplateContext
  url?: string
}) {
  const title = useMemo(
    () => resolveTemplate(titleTemplate, context),
    [titleTemplate, context],
  )
  const description = useMemo(
    () => resolveTemplate(descriptionTemplate, context),
    [descriptionTemplate, context],
  )

  const titleText = title || context.siteName || 'Your page title'
  const descText =
    description ||
    context.siteDesc ||
    'Your meta description will appear here once the template resolves.'

  return (
    <div className="rounded-2xl border border-warm-stone/20 bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-warm-stone">
          Search preview
        </p>
        <span className="text-[10px] font-medium tabular-nums tracking-wider text-warm-stone">
          <LenHint value={title.length} soft={TITLE_SOFT} /> title ·{' '}
          <LenHint value={description.length} soft={DESC_SOFT} /> desc
        </span>
      </div>
      <div className="mt-3 max-w-xl">
        {url && <p className="truncate text-xs text-near-black/80">{url}</p>}
        <p className="mt-1 truncate text-lg font-medium leading-tight text-[#1a0dab] hover:underline">
          {titleText}
        </p>
        <p className="mt-1 line-clamp-2 text-sm text-near-black/70">
          {descText}
        </p>
      </div>
    </div>
  )
}

// A single character-count number, copper when over the soft SERP cap so
// the operator notices the resolved string will get truncated by Google.
function LenHint({ value, soft }: { value: number; soft: number }) {
  return (
    <span className={value > soft ? 'text-copper-700' : 'text-warm-stone'}>
      {value}
    </span>
  )
}

// A reasonable default sample context the Titles & Meta editor can reuse
// for each content type's preview. Callers override the entity-specific
// fields (title/excerpt/category/etc.) per type. Kept here so the preview
// + the page share one source of sample data.
export function sampleContext(
  overrides: Partial<TemplateContext> = {},
): TemplateContext {
  return {
    siteName: 'Your Site',
    siteDesc: 'A short, memorable description of what this site is about.',
    separator: '–',
    title: 'A Sample Page Title',
    excerpt:
      'A concise summary of the page, the kind of sentence that reads well in a search result.',
    category: 'Insights',
    authorName: 'Alex Rivera',
    orgName: 'Your Site',
    date: 'March 2026',
    modified: 'April 2026',
    currentYear: String(new Date().getFullYear()),
    searchPhrase: 'best running shoes',
    ptSingle: 'Page',
    ptPlural: 'Pages',
    ...overrides,
  }
}
