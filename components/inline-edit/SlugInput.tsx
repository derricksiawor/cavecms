'use client'
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Input } from '@/components/ui/Input'

// Slug input with live URL preview and an auto-suggest toggle. When
// `lock` is false (default), the slug auto-derives from the title
// source; once the user types anything, the lock engages so we
// stop trampling their manual edit. A small lock toggle lets them
// reopen the auto-suggest at any time.
export function SlugInput({
  value,
  onChange,
  source,
  baseUrl,
  disabled,
  invalidMessage,
}: {
  value: string
  onChange: (v: string) => void
  source: string // e.g. the title — slug derives from this when unlocked
  baseUrl: string // e.g. "yourdomain.com/projects/"
  disabled?: boolean
  invalidMessage?: string
}) {
  // Locked = "user has typed; stop auto-deriving."
  const [locked, setLocked] = useState<boolean>(() => value.trim().length > 0)

  useEffect(() => {
    if (locked || disabled) return
    const slug = slugify(source)
    if (slug && slug !== value) {
      onChange(slug)
    }
    // Intentional: react to source changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, locked, disabled])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            value={value}
            onChange={(e) => {
              setLocked(true)
              onChange(e.target.value.toLowerCase().replace(/\s+/g, '-'))
            }}
            disabled={disabled}
            placeholder="my-project-slug"
            className={clsx(invalidMessage && 'border-red-400 focus:border-red-500 focus:ring-red-300/40')}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (disabled) return
            if (locked) {
              setLocked(false)
              onChange(slugify(source))
            } else {
              setLocked(true)
            }
          }}
          disabled={disabled}
          title={locked ? 'Auto-suggest from title' : 'Lock manual slug'}
          aria-pressed={locked}
          className={clsx(
            'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-all',
            locked
              ? 'border-copper-400 bg-copper-50 text-copper-700'
              : 'border-warm-stone/25 bg-cream-50 text-warm-stone hover:border-copper-400',
          )}
        >
          {locked ? <LockClosed /> : <LockOpen />}
        </button>
      </div>
      <p className="text-[11px] text-warm-stone font-mono truncate">
        {baseUrl}
        <span className="text-copper-700 font-semibold">{value || 'slug-here'}</span>
      </p>
      {invalidMessage && (
        <p className="text-[11px] text-red-600">{invalidMessage}</p>
      )}
    </div>
  )
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function LockClosed() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
function LockOpen() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0" />
    </svg>
  )
}
