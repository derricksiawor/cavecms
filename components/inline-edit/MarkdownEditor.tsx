'use client'
import { useCallback, useRef, useState } from 'react'
import clsx from 'clsx'

// Markdown editor with a copper toolbar that wraps the current
// selection with the right syntax, plus a live preview pane fed by
// the caller's render function (we don't bundle a markdown parser
// client-side — the server-rendered preview is the source of truth).
//
// Why not TipTap or @uiw/react-md-editor? Bundle size and consistency.
// We already have a server-side markdown pipeline (remark + sanitize)
// that we trust; the editor just needs to make the syntax friendly to
// non-technical authors. Toolbar handlers compose plain text inserts
// — nothing about the markup is generated client-side.
export function MarkdownEditor({
  value,
  onChange,
  onRenderPreview,
  maxLength,
  placeholder = 'Start writing your post…',
  disabled,
  minHeightClass = 'min-h-[40vh]',
}: {
  value: string
  onChange: (v: string) => void
  /** Async render — typically a server action that returns sanitized HTML. */
  onRenderPreview: (md: string) => Promise<string>
  maxLength?: number
  placeholder?: string
  disabled?: boolean
  minHeightClass?: string
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string>('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [showPreview, setShowPreview] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const renderPreview = useCallback(async () => {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      const html = await onRenderPreview(value)
      setPreviewHtml(html)
    } catch {
      setPreviewError("We couldn't show a preview right now. Save and refresh to try again.")
    } finally {
      setPreviewBusy(false)
    }
  }, [onRenderPreview, value])

  // Wrap or insert at selection. Most toolbar buttons fall into the
  // "wrap selection" bucket; for lists and headings, we operate on the
  // current line.
  const insertWrap = (prefix: string, suffix: string = prefix, placeholderText = 'text') => {
    const ta = taRef.current
    if (!ta || disabled) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const before = value.slice(0, start)
    const sel = value.slice(start, end) || placeholderText
    const after = value.slice(end)
    const next = before + prefix + sel + suffix + after
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      const newStart = start + prefix.length
      ta.setSelectionRange(newStart, newStart + sel.length)
    })
  }

  const insertLinePrefix = (prefix: string) => {
    const ta = taRef.current
    if (!ta || disabled) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    // Expand selection to whole lines
    const before = value.slice(0, start)
    const after = value.slice(end)
    const lineStart = before.lastIndexOf('\n') + 1
    const lineEnd = (() => {
      const idx = after.indexOf('\n')
      return idx === -1 ? value.length : end + idx
    })()
    const block = value.slice(lineStart, lineEnd)
    const transformed = block
      .split('\n')
      .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line))
      .join('\n')
    const next = value.slice(0, lineStart) + transformed + value.slice(lineEnd)
    onChange(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(lineStart, lineStart + transformed.length)
    })
  }

  const insertLink = () => {
    const ta = taRef.current
    if (!ta) return
    const href = window.prompt('Paste a link (https://… or /page-name)', '')
    if (!href) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const sel = value.slice(start, end) || 'link text'
    const next =
      value.slice(0, start) + `[${sel}](${href})` + value.slice(end)
    onChange(next)
  }

  return (
    <div className={clsx('rounded-2xl border border-warm-stone/25 bg-cream-50/80 overflow-hidden')}>
      <div className="flex flex-wrap items-center gap-1 border-b border-warm-stone/15 bg-cream-50/60 px-2 py-1.5">
        <TbBtn onClick={() => insertWrap('**', '**', 'bold')} title="Bold (Ctrl+B)">
          <span className="font-bold">B</span>
        </TbBtn>
        <TbBtn onClick={() => insertWrap('_', '_', 'italic')} title="Italic (Ctrl+I)">
          <span className="italic">I</span>
        </TbBtn>
        <span className="mx-1 h-5 w-px bg-warm-stone/20" />
        <TbBtn onClick={() => insertLinePrefix('# ')} title="Heading 1">
          <span className="text-[11px] font-bold tracking-wider">H1</span>
        </TbBtn>
        <TbBtn onClick={() => insertLinePrefix('## ')} title="Heading 2">
          <span className="text-[11px] font-bold tracking-wider">H2</span>
        </TbBtn>
        <TbBtn onClick={() => insertLinePrefix('### ')} title="Heading 3">
          <span className="text-[11px] font-bold tracking-wider">H3</span>
        </TbBtn>
        <span className="mx-1 h-5 w-px bg-warm-stone/20" />
        <TbBtn onClick={() => insertLinePrefix('- ')} title="Bullet list">
          <BulletIcon />
        </TbBtn>
        <TbBtn onClick={() => insertLinePrefix('1. ')} title="Numbered list">
          <span className="text-[11px] font-bold">1.</span>
        </TbBtn>
        <TbBtn onClick={() => insertLinePrefix('> ')} title="Quote">
          <QuoteIcon />
        </TbBtn>
        <span className="mx-1 h-5 w-px bg-warm-stone/20" />
        <TbBtn onClick={insertLink} title="Insert link">
          <LinkIcon />
        </TbBtn>
        <TbBtn onClick={() => insertWrap('`', '`', 'code')} title="Inline code">
          <span className="font-mono text-[11px]">{'<>'}</span>
        </TbBtn>

        <div className="ml-auto flex items-center gap-2">
          {maxLength && (
            <span className={clsx(
              'text-[10px] font-medium tabular-nums tracking-wider',
              value.length > maxLength * 0.95 ? 'text-copper-700' : 'text-warm-stone',
            )}>
              {value.length.toLocaleString()}/{maxLength.toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            className={clsx(
              'inline-flex h-8 items-center rounded-lg px-3 text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors',
              showPreview ? 'bg-copper-500 text-cream-50' : 'text-warm-stone hover:bg-cream-100',
            )}
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => void renderPreview()}
            disabled={previewBusy}
            className="inline-flex h-8 items-center rounded-lg px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-near-black hover:bg-cream-100 transition-colors disabled:opacity-50"
          >
            {previewBusy ? 'Rendering…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className={clsx('grid gap-0', showPreview ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1')}>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            const v = maxLength ? e.target.value.slice(0, maxLength) : e.target.value
            onChange(v)
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
              e.preventDefault()
              insertWrap('**', '**', 'bold')
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
              e.preventDefault()
              insertWrap('_', '_', 'italic')
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className={clsx(
            'w-full bg-white px-5 py-4 text-sm leading-relaxed text-near-black placeholder:text-warm-stone/50 focus:outline-none resize-y',
            minHeightClass,
            showPreview ? 'lg:border-r border-warm-stone/15' : '',
            'font-mono',
          )}
        />
        {showPreview && (
          <div
            className={clsx(
              'overflow-auto bg-cream-50 px-5 py-4 prose prose-sm max-w-none prose-headings:font-serif prose-a:text-copper-700',
              minHeightClass,
            )}
          >
            {previewError ? (
              <p className="text-sm text-red-700">{previewError}</p>
            ) : previewHtml ? (
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
            ) : (
              <div className="flex h-full items-center justify-center text-center">
                <button
                  type="button"
                  onClick={() => void renderPreview()}
                  disabled={previewBusy}
                  className="rounded-full border border-warm-stone/30 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-warm-stone hover:border-copper-400 hover:text-copper-700 transition-colors disabled:opacity-50"
                >
                  {previewBusy ? 'Rendering…' : 'Render preview'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TbBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      title={title}
      className="inline-flex h-8 min-w-[2rem] items-center justify-center rounded-lg px-2 text-near-black transition-colors hover:bg-cream-100"
    >
      {children}
    </button>
  )
}

function BulletIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      <circle cx="4" cy="6" r="1.5" fill="currentColor" />
      <circle cx="4" cy="12" r="1.5" fill="currentColor" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" />
    </svg>
  )
}

function QuoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 7v6H3V7zM15 7v6h-4V7z" opacity="0.45" />
      <path d="M3 11h4v2l-2 4H3zM11 11h4v2l-2 4h-2z" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07L11 5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07L13 19" />
    </svg>
  )
}
