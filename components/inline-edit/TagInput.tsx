'use client'
import { useState, type KeyboardEvent } from 'react'

// Chip-based string-array editor. Users type a value, press Enter or
// comma, and the value pops into a copper-tinted chip. Backspace on
// an empty input removes the last chip — same UX as Gmail's "to:".
//
// No raw-text-area, no JSON, never a comma-separated mess.
export function TagInput({
  value,
  onChange,
  placeholder = 'Type and press Enter to add',
  maxItems,
  maxLength,
  disabled,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  maxItems?: number
  maxLength?: number
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')

  const add = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    if (maxItems !== undefined && value.length >= maxItems) return
    if (value.includes(v)) {
      setDraft('')
      return
    }
    onChange([...value, v])
    setDraft('')
  }

  const remove = (i: number) => {
    onChange(value.filter((_, j) => j !== i))
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      remove(value.length - 1)
    }
  }

  const canAdd = !disabled && (maxItems === undefined || value.length < maxItems)

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warm-stone/25 bg-cream-50/80 px-3 py-2 min-h-[44px] focus-within:border-copper-400 focus-within:ring-2 focus-within:ring-copper-300/40 transition-all">
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-copper-100 px-3 py-1 text-xs font-medium text-copper-800 animate-bwc-fade-in"
        >
          <span className="max-w-[24ch] truncate">{tag}</span>
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`Remove ${tag}`}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-copper-700 hover:bg-copper-200 transition-colors"
            >
              <span aria-hidden className="text-[14px] leading-none">×</span>
            </button>
          )}
        </span>
      ))}
      {canAdd && (
        <input
          value={draft}
          onChange={(e) => {
            const v = maxLength ? e.target.value.slice(0, maxLength) : e.target.value
            setDraft(v)
          }}
          onKeyDown={handleKey}
          onBlur={() => draft && add(draft)}
          placeholder={value.length === 0 ? placeholder : ''}
          disabled={disabled}
          className="flex-1 min-w-[8ch] bg-transparent text-sm text-near-black placeholder:text-warm-stone/60 focus:outline-none py-1"
        />
      )}
    </div>
  )
}
