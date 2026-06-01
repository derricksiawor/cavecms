'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { csrfFetch } from '@/lib/client/csrf'
import { RedirectFormModal, type FormSeed } from './RedirectFormModal'

export interface RedirectItem {
  id: number
  source: string
  matchType: 'exact' | 'wildcard' | 'regex'
  action: 'redirect' | 'gone'
  target: string | null
  statusCode: number | null
  queryHandling: 'passthrough' | 'ignore' | 'exact'
  caseInsensitive: boolean
  enabled: boolean
  position: number
  hitCount: number
  lastHitAt: string | null
  notes: string | null
}
export interface NotFoundItem {
  id: number
  path: string
  hits: number
  lastSeenAt: string
  referrer: string | null
}

interface Props {
  initialRedirects: RedirectItem[]
  initialNotFounds: NotFoundItem[]
}

export function RedirectsClient({ initialRedirects, initialNotFounds }: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<'redirects' | 'log'>('redirects')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<RedirectItem | null>(null)
  const [seed, setSeed] = useState<FormSeed | undefined>(undefined)
  const [testUrl, setTestUrl] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)

  function openCreate(s?: FormSeed) {
    setEditing(null)
    setSeed(s)
    setModalOpen(true)
  }
  function openEdit(item: RedirectItem) {
    setEditing(item)
    setSeed(undefined)
    setModalOpen(true)
  }
  function afterSave() {
    setModalOpen(false)
    router.refresh()
  }

  async function toggleEnabled(item: RedirectItem) {
    await csrfFetch(`/api/admin/redirects/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !item.enabled }),
    })
    router.refresh()
  }
  async function remove(id: number) {
    await csrfFetch(`/api/admin/redirects/${id}`, { method: 'DELETE' })
    router.refresh()
  }
  async function dismiss404(id: number) {
    await csrfFetch(`/api/admin/redirects/404-log/${id}`, { method: 'DELETE' })
    router.refresh()
  }
  async function runTest() {
    setTestResult('…')
    const res = await csrfFetch('/api/admin/redirects/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: testUrl }),
    })
    const j = (await res.json()) as {
      result: null | { kind: string; location?: string; status?: number }
    }
    if (!j.result) setTestResult('No match — this URL would 404.')
    else if (j.result.kind === 'gone') setTestResult('Matches a "Gone" rule → 410.')
    else setTestResult(`→ ${j.result.location} (${j.result.status})`)
  }

  return (
    <div>
      <h1 className="font-serif text-3xl font-bold tracking-tight text-near-black">Redirects</h1>
      <p className="mt-2 text-sm text-warm-stone">
        Send old URLs to new ones, and catch broken inbound links.
      </p>

      <div className="mt-6 flex gap-6 border-b border-near-black/10">
        {(['redirects', 'log'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-1 pb-3 text-sm font-semibold ${tab === t ? 'border-copper-500 text-near-black' : 'border-transparent text-warm-stone'}`}
          >
            {t === 'redirects' ? 'Redirects' : `404 Log (${initialNotFounds.length})`}
          </button>
        ))}
      </div>

      {tab === 'redirects' && (
        <div className="mt-6">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <input
                value={testUrl}
                onChange={(e) => setTestUrl(e.target.value)}
                placeholder="Test a URL, e.g. /old-pricing"
                className="w-72 rounded-lg border border-near-black/10 bg-white px-3 py-2 font-mono text-sm"
              />
              <button
                type="button"
                onClick={runTest}
                className="rounded-lg border border-near-black/10 px-4 py-2 text-sm font-semibold text-near-black"
              >
                Test
              </button>
            </div>
            <button
              type="button"
              onClick={() => openCreate()}
              className="rounded-lg bg-copper-500 px-5 py-2 text-sm font-semibold text-white hover:bg-copper-600"
            >
              New redirect
            </button>
          </div>
          {testResult && <p className="mt-3 font-mono text-sm text-near-black">{testResult}</p>}

          <div className="mt-5 overflow-hidden rounded-xl border border-near-black/10 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-cream/60 text-left text-[11px] uppercase tracking-[0.18em] text-warm-stone">
                <tr>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">On</th>
                  <th className="px-4 py-3">Hits</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {initialRedirects.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-warm-stone">
                      No redirects yet.
                    </td>
                  </tr>
                )}
                {initialRedirects.map((r) => (
                  <tr key={r.id} className="border-t border-near-black/5">
                    <td className="px-4 py-3 font-mono text-near-black">{r.source}</td>
                    <td className="px-4 py-3 font-mono text-warm-stone">
                      {r.action === 'gone' ? '— gone —' : r.target}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-cream px-2 py-0.5 text-[11px] font-semibold text-near-black">
                        {r.matchType}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-cream px-2 py-0.5 text-[11px] font-semibold text-near-black">
                        {r.action === 'gone' ? '410' : r.statusCode}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => toggleEnabled(r)}
                        className={`text-xs font-semibold ${r.enabled ? 'text-copper-600' : 'text-warm-stone'}`}
                      >
                        {r.enabled ? 'On' : 'Off'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-warm-stone">{r.hitCount}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => openEdit(r)}
                        className="mr-3 text-xs font-semibold text-near-black"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        className="text-xs font-semibold text-red-600"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div className="mt-6 overflow-hidden rounded-xl border border-near-black/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-cream/60 text-left text-[11px] uppercase tracking-[0.18em] text-warm-stone">
              <tr>
                <th className="px-4 py-3">Path</th>
                <th className="px-4 py-3">Hits</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {initialNotFounds.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-warm-stone">
                    No 404s recorded.
                  </td>
                </tr>
              )}
              {initialNotFounds.map((n) => (
                <tr key={n.id} className="border-t border-near-black/5">
                  <td className="px-4 py-3 font-mono text-near-black">{n.path}</td>
                  <td className="px-4 py-3 text-warm-stone">{n.hits}</td>
                  <td className="px-4 py-3 text-warm-stone">
                    {new Date(n.lastSeenAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => openCreate({ source: n.path, matchType: 'exact' })}
                      className="mr-3 text-xs font-semibold text-copper-600"
                    >
                      Create redirect
                    </button>
                    <button
                      type="button"
                      onClick={() => dismiss404(n.id)}
                      className="text-xs font-semibold text-warm-stone"
                    >
                      Dismiss
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <RedirectFormModal
          editing={editing}
          seed={seed}
          onClose={() => setModalOpen(false)}
          onSaved={afterSave}
        />
      )}
    </div>
  )
}
