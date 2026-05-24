'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import {
  humaniseAuditAction,
  humaniseResourceType,
  humaniseAlertKind,
} from '@/lib/admin/humanise'

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

interface AlertRow {
  id: number
  kind: string
  ref_table: string | null
  ref_id: number | null
  payload: unknown
  attempts: number
  last_error: string | null
  next_retry_at: string | null
  created_at: string
}

type Tab = 'audit' | 'alerts'

const PAGE_SIZE_OPTIONS = [10, 15, 20, 25, 50, 100]
const DEFAULT_PAGE_SIZE = 25

const RESOURCE_TYPES = [
  'content_block',
  'project',
  'project_section',
  'post',
  'page',
  'lead',
  'media',
  'notification_failure',
  'user',
  'setting',
  'auth',
] as const

const ALERT_KINDS = [
  { value: 'smtp', label: 'Email delivery' },
  { value: 'revalidate', label: 'Page refresh' },
  { value: 'recaptcha', label: 'Spam check' },
  { value: 'rbac', label: 'Permission denied' },
  { value: 'hydrate', label: 'Page render warning' },
  { value: 'runtime', label: 'Unexpected error' },
  { value: 'crm', label: 'CRM lead handoff' },
] as const

// Human-readable summary of an audit diff. Shown by default in the
// table; an operator can click any row to see the raw JSON in the
// detail drawer (rendered below by the same component). The shape of
// `diff` varies by action — we cover the common cases (object with
// `kind` + `changes` array, or a bare patch object) and fall back to
// a count of fields touched.
function prettifyPath(p: string): string {
  return p.replace(/_/g, ' ').replace(/^\w/, (c) => c.toLowerCase())
}

function summarizeDiff(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v.slice(0, 80)
  if (typeof v !== 'object') return String(v)
  const obj = v as Record<string, unknown>
  if (typeof obj.kind === 'string') {
    switch (obj.kind) {
      case 'create':
        return 'Created'
      case 'delete':
        return 'Deleted'
      case 'restore':
        return 'Restored'
      case 'publish':
        return 'Made live'
      case 'unpublish':
        return 'Hidden from the public site'
      case 'reorder':
        return 'Reordered'
      case 'update': {
        const ch = obj.changes
        if (Array.isArray(ch) && ch.length > 0) {
          const fields = ch
            .map((c) => (typeof c === 'object' && c && 'path' in c ? prettifyPath(String((c as { path: unknown }).path)) : ''))
            .filter(Boolean)
          if (fields.length) {
            return `Changed ${fields.slice(0, 3).join(', ')}${fields.length > 3 ? ` and ${fields.length - 3} more` : ''}`
          }
        }
        return 'Edited'
      }
    }
  }
  const keys = Object.keys(obj).map(prettifyPath)
  if (keys.length === 0) return '—'
  return `Changed ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` and ${keys.length - 3} more` : ''}`
}

export function ActivityClient({
  initialTab,
  initialKind,
  initialResourceType,
}: {
  initialTab: Tab
  initialKind: string
  initialResourceType: string
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [resourceType, setResourceType] = useState(initialResourceType)
  const [kind, setKind] = useState(initialKind)
  const [showRaw, setShowRaw] = useState(false)
  // The audit log is append-only and can grow huge; cursor pagination
  // is the correct shape for it. Page-size lets the operator widen
  // the fetch window from 25 (default) up to 100 per request.
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [auditCursor, setAuditCursor] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [alertsCursor, setAlertsCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Shared abort controller across both tabs — switching tab cancels
  // the in-flight load for the previous tab so a slow audit response
  // can't overwrite a fresh alerts state. Also cleared on unmount.
  const inFlightRef = useRef<AbortController | null>(null)
  useEffect(() => {
    return () => {
      inFlightRef.current?.abort()
    }
  }, [])

  const loadAudit = useCallback(
    async (cur: string | null, replace: boolean) => {
      inFlightRef.current?.abort()
      const ctrl = new AbortController()
      inFlightRef.current = ctrl
      setLoading(true)
      setError(null)
      try {
        const p = new URLSearchParams({ limit: String(pageSize) })
        if (resourceType) p.set('resource_type', resourceType)
        if (cur) p.set('cursor', cur)
        const r = await fetch('/api/admin/audit-log?' + p.toString(), {
          credentials: 'include',
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (!r.ok) {
          setError("We couldn't load the history. Try again in a moment.")
          return
        }
        const j = (await r.json()) as {
          items: AuditRow[]
          nextCursor: string | null
        }
        if (ctrl.signal.aborted) return
        setAudit((prev) => (replace ? j.items : [...prev, ...j.items]))
        setAuditCursor(j.nextCursor)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError("We can't reach the server right now. Check your connection and try again.")
      } finally {
        if (inFlightRef.current === ctrl) {
          setLoading(false)
          inFlightRef.current = null
        }
      }
    },
    [resourceType, pageSize],
  )

  const loadAlerts = useCallback(
    async (cur: string | null, replace: boolean) => {
      inFlightRef.current?.abort()
      const ctrl = new AbortController()
      inFlightRef.current = ctrl
      setLoading(true)
      setError(null)
      try {
        const p = new URLSearchParams({ limit: String(pageSize) })
        if (kind) p.set('kind', kind)
        if (cur) p.set('cursor', cur)
        const r = await fetch('/api/admin/alerts?' + p.toString(), {
          credentials: 'include',
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (!r.ok) {
          setError("We couldn't load the alerts. Try again in a moment.")
          return
        }
        const j = (await r.json()) as {
          items: AlertRow[]
          nextCursor: string | null
        }
        if (ctrl.signal.aborted) return
        setAlerts((prev) => (replace ? j.items : [...prev, ...j.items]))
        setAlertsCursor(j.nextCursor)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError("We can't reach the server right now. Check your connection and try again.")
      } finally {
        if (inFlightRef.current === ctrl) {
          setLoading(false)
          inFlightRef.current = null
        }
      }
    },
    [kind, pageSize],
  )

  // Two effects, one per tab. This avoids the previous shape where
  // changing `pageSize` on the audit tab rebuilt `loadAlerts` (since
  // both loaders depend on pageSize) and re-fired the master effect,
  // which would issue a stale-tab fetch.
  useEffect(() => {
    if (tab !== 'audit') return
    void loadAudit(null, true)
  }, [tab, loadAudit])
  useEffect(() => {
    if (tab !== 'alerts') return
    void loadAlerts(null, true)
  }, [tab, loadAlerts])

  // Mark an alert as resolved. Admin-only at the server; the UI also
  // hides the button for editors via the parent page (alerts tab is
  // admin-only anyway). Optimistically drops the row from the local
  // state on 2xx — if a follow-up reload picks it up again (e.g. the
  // resolution didn't actually fix the upstream condition), the next
  // failure will INSERT a fresh row anyway.
  const resolveAlert = useCallback(async (id: number) => {
    setError(null)
    try {
      const res = await csrfFetch(`/api/admin/alerts/${id}/resolve`, {
        method: 'POST',
      })
      if (!res.ok) {
        setError("We couldn't mark that as resolved. Try again in a moment.")
        return
      }
      setAlerts((prev) => prev.filter((a) => a.id !== id))
    } catch {
      setError("We can't reach the server right now. Check your connection and try again.")
    }
  }, [])

  return (
    <section className="mt-10">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab('audit')}
          className={
            tab === 'audit'
              ? 'rounded-lg bg-near-black px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50'
              : 'rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400'
          }
        >
          History
        </button>
        <button
          type="button"
          onClick={() => setTab('alerts')}
          className={
            tab === 'alerts'
              ? 'rounded-lg bg-near-black px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50'
              : 'rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400'
          }
        >
          Background alerts
        </button>
      </div>

      {tab === 'audit' ? (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <select
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value)}
              className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
              aria-label="Filter by what was changed"
            >
              <option value="">Everything</option>
              {RESOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humaniseResourceType(t)}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Show
              <select
                value={pageSize}
                onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
                className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-1.5 text-sm text-near-black"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              per page
            </label>
            <label className="ml-auto inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone select-none cursor-pointer">
              <input
                type="checkbox"
                checked={showRaw}
                onChange={(e) => setShowRaw(e.target.checked)}
                className="h-4 w-4 accent-copper-500"
              />
              Show technical detail
            </label>
          </div>

          {error && (
            <p className="mt-4 text-sm font-medium text-copper-700">{error}</p>
          )}

          <div className="mt-6 overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 backdrop-blur-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-warm-stone/20 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  <th className="px-5 py-4">When</th>
                  <th className="px-5 py-4">Who</th>
                  <th className="px-5 py-4">What happened</th>
                  <th className="px-5 py-4">Where</th>
                  <th className="px-5 py-4">Details</th>
                </tr>
              </thead>
              <tbody>
                {audit.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-warm-stone">
                      Nothing matches this filter. Try clearing it above.
                    </td>
                  </tr>
                ) : (
                  audit.map((r) => {
                    const diffStr =
                      r.diff == null
                        ? ''
                        : typeof r.diff === 'string'
                          ? r.diff
                          : JSON.stringify(r.diff)
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-warm-stone/10 last:border-b-0"
                      >
                        <td className="px-5 py-4 text-xs text-warm-stone">
                          {new Date(r.created_at)
                            .toISOString()
                            .slice(0, 16)
                            .replace('T', ' ')}
                        </td>
                        <td className="px-5 py-4 text-xs text-near-black">
                          {r.user_email ?? '—'}
                        </td>
                        <td className="px-5 py-4 text-xs font-medium">
                          {humaniseAuditAction(r.action)}
                        </td>
                        <td className="px-5 py-4 text-xs text-warm-stone">
                          {humaniseResourceType(r.resource_type)}
                          {r.resource_id ? ` · ${r.resource_id}` : ''}
                        </td>
                        <td
                          className="max-w-md truncate px-5 py-4 text-[11px]"
                          title={diffStr}
                        >
                          {showRaw ? (
                            <code className="font-mono text-[10px] text-warm-stone truncate">
                              {diffStr.length > 80 ? diffStr.slice(0, 80) + '…' : diffStr}
                            </code>
                          ) : (
                            <span className="text-near-black/80">{summarizeDiff(r.diff)}</span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {auditCursor && (
            <button
              type="button"
              onClick={() => loadAudit(auditCursor, false)}
              disabled={loading}
              className="mt-6 rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-copper-300 border-t-copper-700" />
                  Loading more…
                </span>
              ) : (
                'Load more'
              )}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
              aria-label="Filter alerts"
            >
              <option value="">All alerts</option>
              {ALERT_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Show
              <select
                value={pageSize}
                onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
                className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-1.5 text-sm text-near-black"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              per page
            </label>
          </div>

          {error && (
            <p className="mt-4 text-sm font-medium text-copper-700">{error}</p>
          )}

          <div className="mt-6 overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 backdrop-blur-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-warm-stone/20 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  <th className="px-5 py-4">When</th>
                  <th className="px-5 py-4">What</th>
                  <th className="px-5 py-4">Where</th>
                  <th className="px-5 py-4">Tries</th>
                  <th className="px-5 py-4">Last message</th>
                  <th className="px-5 py-4"></th>
                </tr>
              </thead>
              <tbody>
                {alerts.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-6 text-warm-stone">
                      Nothing needs your attention right now.
                    </td>
                  </tr>
                ) : (
                  alerts.map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-warm-stone/10 last:border-b-0"
                    >
                      <td className="px-5 py-4 text-xs text-warm-stone">
                        {new Date(a.created_at)
                          .toISOString()
                          .slice(0, 16)
                          .replace('T', ' ')}
                      </td>
                      <td className="px-5 py-4 text-xs font-medium">
                        {humaniseAlertKind(a.kind)}
                      </td>
                      <td className="px-5 py-4 text-xs text-warm-stone">
                        {a.ref_table
                          ? `${humaniseResourceType(a.ref_table)}${a.ref_id ? ` · ${a.ref_id}` : ''}`
                          : '—'}
                      </td>
                      <td className="px-5 py-4 text-xs">{a.attempts}</td>
                      <td
                        className="max-w-md truncate px-5 py-4 font-mono text-[10px] text-warm-stone"
                        title={a.last_error ?? ''}
                      >
                        {a.last_error ?? '—'}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <button
                          type="button"
                          onClick={() => resolveAlert(a.id)}
                          className="rounded-lg border border-warm-stone/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-copper-400"
                        >
                          Mark resolved
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {alertsCursor && (
            <button
              type="button"
              onClick={() => loadAlerts(alertsCursor, false)}
              disabled={loading}
              className="mt-6 rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-copper-300 border-t-copper-700" />
                  Loading more…
                </span>
              ) : (
                'Load more'
              )}
            </button>
          )}
        </>
      )}
    </section>
  )
}
