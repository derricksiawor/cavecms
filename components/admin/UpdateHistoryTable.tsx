'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock } from 'lucide-react'
import { humaniseAuditAction } from '@/lib/admin/humanise'

// Update history table on /admin/settings/updates.
//
// Reads from the existing /api/admin/audit-log endpoint with
// `?resource_type=updates&limit=20`. Each row is one append-only event
// from the audit thread: an `apply` / `force_apply` (written when the
// operator clicked Update/Re-run), or one of `completed` / `failed` /
// `rolled_back` (written by the orchestrator script at terminal
// transition). Operators read them in time order to see the story of
// each update.
//
// Deliberately no join between apply rows + terminal rows here — the
// audit table IS the event log, and a paired view would add server-
// side complexity (groupBy + window functions) for marginal UX gain.
// /admin/activity?resource_type=updates is the full paginated feed
// when the operator needs more than the latest 20.

interface AuditRow {
  id: number
  user_id: number | null
  user_email: string | null
  action: string
  resource_type: string
  resource_id: string | null
  diff: unknown
  created_at: string
}

interface AuditResponse {
  items: AuditRow[]
  nextCursor: string | null
}

// Pretty timestamp matching the convention used in ActivityClient.
function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toISOString().slice(0, 16).replace('T', ' ')
  } catch {
    return iso
  }
}

// Friendly duration: "12s", "1m 24s", "2h 5m". Bounded at hours so a
// stuck multi-day row reads "many hours" rather than "47h 13m".
function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`
}

interface DiffShape {
  fromSha?: string
  toSha?: string
  durationMs?: number
  error?: string
  force?: boolean
}

function parseDiff(raw: unknown): DiffShape {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as DiffShape
    } catch {
      return {}
    }
  }
  if (typeof raw === 'object') return raw as DiffShape
  return {}
}

// Short SHA display — 7 chars matches what `git log --oneline` shows
// and is what operators recognise.
function shortSha(sha: string | undefined): string {
  if (!sha) return '—'
  if (sha === 'unknown') return '—'
  return sha.slice(0, 7)
}

// Colour the row's status badge by outcome:
//   - apply / force_apply: copper (in-progress style, neutral)
//   - completed: emerald (success)
//   - failed / rolled_back: red (failure / recovery)
const STATUS_TONE: Record<string, string> = {
  apply: 'bg-copper-100 text-copper-700',
  force_apply: 'bg-copper-100 text-copper-700',
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  rolled_back: 'bg-red-100 text-red-700',
}

export function UpdateHistoryTable() {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await fetch(
        '/api/admin/audit-log?resource_type=updates&limit=20',
        { credentials: 'include' },
      )
      if (!r.ok) {
        setErr("We couldn't load the update history.")
        return
      }
      const j = (await r.json()) as AuditResponse
      setRows(j.items)
    } catch {
      setErr("We couldn't load the update history.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <article
      data-update-history
      className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm"
    >
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            History
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
            Recent updates
          </h2>
          <p className="mt-2 text-sm text-warm-stone">
            The last 20 update events. Visit{' '}
            <Link
              href="/admin/activity?resource_type=updates"
              className="font-medium text-copper-700 underline decoration-copper-400/40 underline-offset-2 hover:decoration-copper-600"
            >
              Activity
            </Link>{' '}
            for the full paginated history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone transition-colors hover:text-copper-700 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      <div className="mt-6 overflow-hidden rounded-xl border border-warm-stone/15 bg-cream-50/50">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-warm-stone/20 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">What</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Duration</th>
            </tr>
          </thead>
          <tbody>
            {err ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-sm text-warm-stone">
                  {err}
                </td>
              </tr>
            ) : loading && !rows ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-sm text-warm-stone">
                  Loading update history…
                </td>
              </tr>
            ) : !rows || rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-sm text-warm-stone">
                  No updates yet. When you run one, it shows up here.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const d = parseDiff(r.diff)
                const tone = STATUS_TONE[r.action] ?? 'bg-warm-stone/15 text-warm-stone'
                const duration = formatDuration(d.durationMs)
                return (
                  <tr
                    key={r.id}
                    className="border-b border-warm-stone/10 last:border-b-0"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-warm-stone">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3 w-3" />
                        {formatWhen(r.created_at)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-near-black">
                      {r.user_email ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium ${tone}`}
                      >
                        {humaniseAuditAction(r.action)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-warm-stone">
                      {shortSha(d.fromSha)} → {shortSha(d.toSha)}
                    </td>
                    <td className="px-4 py-3 text-xs text-warm-stone">
                      {duration ?? '—'}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </article>
  )
}
