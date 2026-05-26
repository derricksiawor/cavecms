'use client'

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  TRANSLATE_LANGUAGES,
  type TranslateLanguageCode,
} from '@/lib/ai/prompts/inlineCatalog'

// Translate tab — searchable language combobox.
//
// The list is fixed at 30 (marketing promise). Filtering is local
// (instant) on a case-insensitive substring match against either the
// language code or the English label.
//
// Submit is gated on language selection. An optional free-text field
// passes notes ("keep prices in USD", "use formal register") that
// the server folds into the translate prompt.

interface Props {
  onSubmit: (language: TranslateLanguageCode, freeText: string | undefined) => void
}

export function AISparkleTranslateCard(p: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<TranslateLanguageCode | null>(null)
  const [freeText, setFreeText] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return TRANSLATE_LANGUAGES
    const q = query.trim().toLowerCase()
    return TRANSLATE_LANGUAGES.filter(
      (l) =>
        l.code.toLowerCase().includes(q) || l.label.toLowerCase().includes(q),
    )
  }, [query])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!selected) return
        p.onSubmit(
          selected,
          freeText.trim().length > 0 ? freeText.trim() : undefined,
        )
      }}
      className="flex flex-col gap-3"
    >
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-copper-700">
          Pick a language
        </p>
        <p className="mt-1 text-[11px] text-warm-stone">
          Thirty languages. Source detected automatically.
        </p>
      </div>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search…"
        aria-label="Search languages"
        className="w-full rounded-xl border border-warm-stone/25 bg-white px-3 py-2 text-[12px] text-near-black placeholder:text-warm-stone/60 focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
      />
      <div
        role="listbox"
        aria-label="Translate language"
        className="max-h-44 overflow-y-auto rounded-xl border border-warm-stone/15 bg-cream-100/40"
      >
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-warm-stone">
            No match — try fewer characters.
          </p>
        ) : (
          <ul className="divide-y divide-warm-stone/10">
            {filtered.map((lang) => {
              const active = lang.code === selected
              return (
                <li key={lang.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => setSelected(lang.code)}
                    className={clsx(
                      'flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition-colors',
                      active
                        ? 'bg-copper-500 text-cream-50'
                        : 'text-near-black hover:bg-copper-50',
                    )}
                  >
                    <span>{lang.label}</span>
                    <span
                      className={clsx(
                        'text-[10px] uppercase tracking-[0.16em] tabular-nums',
                        active ? 'text-cream-100/80' : 'text-warm-stone/70',
                      )}
                    >
                      {lang.code}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <label className="block">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-warm-stone">
          Notes (optional)
        </span>
        <textarea
          maxLength={240}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="e.g. keep brand names in English"
          rows={2}
          className="mt-1.5 w-full resize-none rounded-xl border border-warm-stone/25 bg-white px-3 py-2 text-[12px] leading-relaxed text-near-black placeholder:text-warm-stone/60 focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
        />
      </label>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!selected}
          className="inline-flex h-11 items-center rounded-full bg-copper-500 px-5 text-[12px] font-semibold uppercase tracking-[0.16em] text-cream-50 hover:bg-copper-600 transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:py-2"
        >
          Translate
        </button>
      </div>
    </form>
  )
}
