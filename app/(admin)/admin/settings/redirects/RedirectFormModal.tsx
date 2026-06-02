'use client'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import type { RedirectItem } from './RedirectsClient'

const MATCH_TYPES = [
  { v: 'exact', label: 'Exact', hint: '/old-page' },
  { v: 'wildcard', label: 'Wildcard', hint: '/blog/*' },
  { v: 'regex', label: 'Regex', hint: '^/p/(\\d+)$' },
] as const
const STATUS = [
  { v: 301, label: '301', hint: 'Moved permanently' },
  { v: 302, label: '302', hint: 'Found (temporary)' },
  { v: 307, label: '307', hint: 'Temporary, keep method' },
  { v: 308, label: '308', hint: 'Permanent, keep method' },
] as const
const QUERY = [
  { v: 'passthrough', label: 'Pass through', hint: 'Append ?query to target' },
  { v: 'ignore', label: 'Ignore', hint: 'Drop the query' },
] as const

export interface FormSeed {
  source?: string
  matchType?: RedirectItem['matchType']
}

interface Props {
  // null = create; an item = edit
  editing: RedirectItem | null
  seed?: FormSeed
  onClose: () => void
  onSaved: () => void
}

export function RedirectFormModal({ editing, seed, onClose, onSaved }: Props) {
  const [source, setSource] = useState(editing?.source ?? seed?.source ?? '')
  const [matchType, setMatchType] = useState<RedirectItem['matchType']>(
    editing?.matchType ?? seed?.matchType ?? 'exact',
  )
  const [action, setAction] = useState<RedirectItem['action']>(editing?.action ?? 'redirect')
  const [target, setTarget] = useState(editing?.target ?? '')
  const [statusCode, setStatusCode] = useState<number>(editing?.statusCode ?? 301)
  const [queryHandling, setQueryHandling] = useState<RedirectItem['queryHandling']>(
    editing?.queryHandling ?? 'passthrough',
  )
  const [caseInsensitive, setCaseInsensitive] = useState(editing?.caseInsensitive ?? true)
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [notes, setNotes] = useState(editing?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    setError(null)
    const body = {
      source,
      matchType,
      action,
      target: action === 'gone' ? null : target,
      statusCode: action === 'gone' ? null : statusCode,
      queryHandling,
      caseInsensitive,
      enabled,
      notes: notes || null,
    }
    const res = await csrfFetch(
      editing ? `/api/admin/redirects/${editing.id}` : '/api/admin/redirects',
      {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    setSaving(false)
    if (res.ok) {
      onSaved()
      return
    }
    let msg = 'Could not save the redirect.'
    try {
      const j = (await res.json()) as { error?: string }
      if (j.error) msg = j.error
    } catch {
      /* keep default */
    }
    setError(msg)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-cream p-8 shadow-2xl">
        <h2 className="font-serif text-2xl font-bold text-near-black">
          {editing ? 'Edit redirect' : 'New redirect'}
        </h2>

        <label className="mt-6 block text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Source path
        </label>
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="/old-pricing"
          className="mt-2 w-full rounded-lg border border-near-black/10 bg-white px-4 py-2.5 font-mono text-sm text-near-black"
        />

        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Match type
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {MATCH_TYPES.map((m) => (
            <button
              key={m.v}
              type="button"
              onClick={() => setMatchType(m.v)}
              className={`rounded-lg border px-3 py-2 text-left ${matchType === m.v ? 'border-copper-500 bg-copper-50 ring-1 ring-copper-500' : 'border-near-black/10 bg-white'}`}
            >
              <span className="block text-sm font-semibold text-near-black">{m.label}</span>
              <span className="block font-mono text-[11px] text-warm-stone">{m.hint}</span>
            </button>
          ))}
        </div>

        {matchType === 'regex' && (
          <p className="mt-2 text-[12px] leading-relaxed text-warm-stone">
            Patterns match the normalized path (no trailing slash, collapsed
            slashes). Anchor with <span className="font-mono">^</span> and{' '}
            <span className="font-mono">$</span>; use{' '}
            <span className="font-mono">$1</span>…<span className="font-mono">$9</span> in
            the target for captured groups. Avoid a repeated group that contains
            a quantifier or <span className="font-mono">|</span> (e.g.{' '}
            <span className="font-mono">(a|b)+</span>) — use a character class
            like <span className="font-mono">[ab]+</span> instead.
          </p>
        )}

        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Action
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(['redirect', 'gone'] as const).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAction(a)}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold ${action === a ? 'border-copper-500 bg-copper-50 text-near-black ring-1 ring-copper-500' : 'border-near-black/10 bg-white text-warm-stone'}`}
            >
              {a === 'redirect' ? 'Redirect' : 'Gone (410)'}
            </button>
          ))}
        </div>

        {action === 'redirect' && (
          <>
            <label className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Target{' '}
              {matchType === 'regex' && (
                <span className="text-copper-600">(use $1 for captures)</span>
              )}
            </label>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="/pricing"
              className="mt-2 w-full rounded-lg border border-near-black/10 bg-white px-4 py-2.5 font-mono text-sm text-near-black"
            />

            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Status code
            </p>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {STATUS.map((s) => (
                <button
                  key={s.v}
                  type="button"
                  title={s.hint}
                  onClick={() => setStatusCode(s.v)}
                  className={`rounded-lg border px-2 py-2 text-center ${statusCode === s.v ? 'border-copper-500 bg-copper-50 ring-1 ring-copper-500' : 'border-near-black/10 bg-white'}`}
                >
                  <span className="block text-sm font-semibold text-near-black">{s.label}</span>
                </button>
              ))}
            </div>

            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Query string
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {QUERY.map((q) => (
                <button
                  key={q.v}
                  type="button"
                  title={q.hint}
                  onClick={() => setQueryHandling(q.v)}
                  className={`rounded-lg border px-3 py-2 text-left ${queryHandling === q.v ? 'border-copper-500 bg-copper-50 ring-1 ring-copper-500' : 'border-near-black/10 bg-white'}`}
                >
                  <span className="block text-sm font-semibold text-near-black">{q.label}</span>
                  <span className="block text-[11px] text-warm-stone">{q.hint}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="mt-5 flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm text-near-black">
            <input
              type="checkbox"
              checked={caseInsensitive}
              onChange={(e) => setCaseInsensitive(e.target.checked)}
            />
            Case-insensitive
          </label>
          <label className="flex items-center gap-2 text-sm text-near-black">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>

        <label className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Notes (optional)
        </label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="mt-2 w-full rounded-lg border border-near-black/10 bg-white px-4 py-2.5 text-sm text-near-black"
        />

        {error && <p className="mt-4 text-sm font-medium text-red-600">{error}</p>}

        <div className="mt-8 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-warm-stone hover:text-near-black"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-copper-500 px-6 py-2.5 text-sm font-semibold text-white hover:bg-copper-600 disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create redirect'}
          </button>
        </div>
      </div>
    </div>
  )
}
