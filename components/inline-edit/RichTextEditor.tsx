'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

// Lightweight WYSIWYG for HTML richtext fields. ContentEditable surface
// + a copper toolbar with bold/italic/links/lists. The output is a
// plain HTML string compatible with the public-side renderer (which
// runs isomorphic-dompurify before render — that is the trust
// boundary). The editor only emits tags inside the dompurify allowlist:
// p, br, strong, em, a, ul, ol, li.
//
// Why custom: a single tiny component, zero new deps, works in Next 15
// + React 19, and the surface is small enough that we keep total
// control of the markup. Heavy editors (TipTap, Lexical) are overkill
// for the 200-2000 character bodies we edit here.
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  maxLength,
  disabled,
}: {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  maxLength?: number
  disabled?: boolean
}) {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const [focused, setFocused] = useState(false)
  // Track active formatting state so the toolbar buttons can highlight
  // when the caret is inside a bold/italic/link region.
  const [active, setActive] = useState({
    bold: false,
    italic: false,
    ul: false,
    ol: false,
    link: false,
  })

  // Sync prop value -> editor only when it's genuinely different. Without
  // this guard, every keystroke would reset the caret to position 0 on
  // re-render because we'd be overwriting the DOM on every change.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const current = el.innerHTML
    if (current !== value) {
      el.innerHTML = value || ''
    }
  }, [value])

  const queryState = useCallback(() => {
    if (typeof document === 'undefined') return
    setActive({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      ul: document.queryCommandState('insertUnorderedList'),
      ol: document.queryCommandState('insertOrderedList'),
      link: !!(document.getSelection()?.anchorNode &&
        (document.getSelection()!.anchorNode as Node).parentElement?.closest('a')),
    })
  }, [])

  const exec = (cmd: string, arg?: string) => {
    if (disabled) return
    editorRef.current?.focus()
    // execCommand is deprecated but still the simplest cross-browser
    // path for the small set of commands we need. The output is
    // sanitised downstream — we control the input surface.
    document.execCommand(cmd, false, arg)
    handleInput()
    queryState()
  }

  const handleInput = () => {
    const el = editorRef.current
    if (!el) return
    let html = el.innerHTML
    if (maxLength && html.length > maxLength) {
      // Soft-cap by truncating from the end. Better than blocking
      // entirely (causing seemingly-broken keystrokes).
      html = html.slice(0, maxLength)
      el.innerHTML = html
    }
    onChange(html)
  }

  const insertLink = () => {
    if (disabled) return
    const sel = document.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const existing = (sel.anchorNode?.parentElement?.closest('a') as HTMLAnchorElement | null)?.href ?? ''
    const href = window.prompt('Paste a link (https://… or /page-name)', existing)
    if (href === null) return
    if (href === '') {
      exec('unlink')
      return
    }
    // URL protocol whitelist — operator-self-XSS hardening. Without
    // this, a copy-pasted `javascript:fetch(...)` URL would land in
    // the href and fire on click. Allow https://, http://, mailto:,
    // tel:, and any same-origin relative path (starts with / or #).
    // Silent reject + console.warn (no custom modal needed — the
    // operator's button click won't apply the link, they can retry;
    // alert/prompt/confirm are project-banned per #design preferences).
    const trimmed = href.trim()
    const safe =
      /^(?:https?:|mailto:|tel:|\/|#)/i.test(trimmed) &&
      !/^[\s\t\n\r]*(?:javascript|vbscript|data:text\/html)/i.test(trimmed)
    if (!safe) {
      console.warn(
        '[RichTextEditor] insertLink: rejected unsafe URL protocol — only https/http/mailto/tel/relative allowed.',
      )
      return
    }
    exec('createLink', trimmed)
    // Force any newly created link to open in a new tab when external.
    const el = editorRef.current
    if (el) {
      el.querySelectorAll('a').forEach((a) => {
        if (/^https?:\/\//i.test(a.href)) {
          a.setAttribute('rel', 'noopener noreferrer')
          a.setAttribute('target', '_blank')
        }
      })
      handleInput()
    }
  }

  const stripFormatting = () => exec('removeFormat')

  // When a user pastes from Word/Google Docs, strip the noisy spans
  // and styles so our sanitiser doesn't ditch everything downstream.
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  // Drop — same strip-to-text discipline as handlePaste. Browser
  // default drop on a contentEditable inserts the dragged HTML
  // payload into el.innerHTML directly; without this guard an
  // operator dragging hostile HTML in from another tab/file would
  // land `<img onerror>` / `<iframe srcdoc>` in the live DOM,
  // firing the handler before our sanitiser ever sees the payload.
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (disabled) return
    const dt = e.dataTransfer
    const text =
      dt.getData('text/plain') ||
      dt.getData('text/html').replace(/<[^>]*>/g, '')
    if (!text) return
    try {
      document.execCommand('insertText', false, text)
    } catch {
      // No-op on browsers that have removed execCommand from this
      // surface; the trailing input event below still flushes
      // value to the parent.
    }
    handleInput()
  }

  const length = value.replace(/<[^>]*>/g, '').length
  const showLimit = maxLength !== undefined

  return (
    <div
      className={clsx(
        'rounded-xl border bg-cream-50/80 transition-all duration-quick overflow-hidden',
        focused
          ? 'border-copper-400 ring-2 ring-copper-300/40 bg-white'
          : 'border-warm-stone/25 hover:border-warm-stone/40',
        disabled && 'opacity-50',
      )}
    >
      <div
        className="flex flex-wrap items-center gap-1 border-b border-warm-stone/15 bg-cream-50/60 px-2 py-1.5"
        onMouseDown={(e) => e.preventDefault()}
      >
        <TbBtn active={active.bold} onClick={() => exec('bold')} title="Bold (Ctrl+B)">
          <span className="font-bold">B</span>
        </TbBtn>
        <TbBtn active={active.italic} onClick={() => exec('italic')} title="Italic (Ctrl+I)">
          <span className="italic">I</span>
        </TbBtn>
        <span className="mx-1 h-5 w-px bg-warm-stone/20" />
        <TbBtn active={false} onClick={() => exec('formatBlock', 'p')} title="Paragraph">
          <span className="text-[11px] font-semibold tracking-wider">P</span>
        </TbBtn>
        <TbBtn active={active.ul} onClick={() => exec('insertUnorderedList')} title="Bullet list">
          <ListIcon variant="ul" />
        </TbBtn>
        <TbBtn active={active.ol} onClick={() => exec('insertOrderedList')} title="Numbered list">
          <ListIcon variant="ol" />
        </TbBtn>
        <span className="mx-1 h-5 w-px bg-warm-stone/20" />
        <TbBtn active={active.link} onClick={insertLink} title="Insert link">
          <LinkIcon />
        </TbBtn>
        <TbBtn active={false} onClick={stripFormatting} title="Clear formatting">
          <span className="text-[11px] font-semibold tracking-wider">Tx</span>
        </TbBtn>
        {showLimit && (
          <span className={clsx(
            'ml-auto text-[10px] font-medium tabular-nums tracking-wider',
            length > (maxLength ?? Infinity) * 0.9 ? 'text-copper-700' : 'text-warm-stone',
          )}>
            {length}/{maxLength}
          </span>
        )}
      </div>
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onInput={handleInput}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyUp={queryState}
        onMouseUp={queryState}
        data-placeholder={placeholder ?? ''}
        className="min-h-[8rem] px-4 py-3 text-sm leading-relaxed text-near-black focus:outline-none prose prose-sm max-w-none prose-headings:font-serif prose-p:my-2 prose-a:text-copper-700 prose-a:underline empty:before:content-[attr(data-placeholder)] empty:before:text-warm-stone/60 [&:not(:focus):empty]:before:content-[attr(data-placeholder)]"
      />
    </div>
  )
}

function TbBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
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
      aria-pressed={active}
      className={clsx(
        'inline-flex h-8 min-w-[2rem] items-center justify-center rounded-lg px-2 text-near-black transition-all duration-standard',
        active
          ? 'bg-copper-500 text-cream-50 shadow-inner'
          : 'hover:bg-cream-100',
      )}
    >
      {children}
    </button>
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

function ListIcon({ variant }: { variant: 'ul' | 'ol' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="10" y1="6" x2="20" y2="6" />
      <line x1="10" y1="12" x2="20" y2="12" />
      <line x1="10" y1="18" x2="20" y2="18" />
      {variant === 'ul' ? (
        <>
          <circle cx="4.5" cy="6" r="1" />
          <circle cx="4.5" cy="12" r="1" />
          <circle cx="4.5" cy="18" r="1" />
        </>
      ) : (
        <>
          <text x="2.5" y="8" fontSize="6" fill="currentColor" stroke="none">1</text>
          <text x="2.5" y="14" fontSize="6" fill="currentColor" stroke="none">2</text>
          <text x="2.5" y="20" fontSize="6" fill="currentColor" stroke="none">3</text>
        </>
      )}
    </svg>
  )
}
