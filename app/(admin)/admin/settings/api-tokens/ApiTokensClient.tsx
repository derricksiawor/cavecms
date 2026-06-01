'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  KeyRound,
  Copy,
  Check,
  Trash2,
  RotateCw,
  Sparkles,
  BookOpen,
  FileCode2,
  ArrowUpRight,
} from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import {
  SCOPE_RESOURCES,
  SCOPE_ACTIONS,
  type ScopeResource,
  type ScopeAction,
} from '@/lib/auth/apiTokenScope'
import { CfSafeMailto } from '@/components/CfSafeMailto'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PasswordPromptModal } from '@/components/admin/PasswordPromptModal'
import { usePasswordReauth } from '@/hooks/usePasswordReauth'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { useToast } from '@/components/inline-edit/Toast'

export type TokenStatus = 'active' | 'expired' | 'revoked'

export interface TokenListItem {
  id: number
  name: string
  token_prefix: string
  role: string
  // null = unrestricted within role; else the per-resource grant array.
  scopes: string[] | null
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
  created_by_email: string | null
  // Derived SERVER-SIDE (page.tsx) so SSR and the first client paint agree —
  // computing expiry from the client clock during render risks a sub-second
  // hydration mismatch (React #418). Real expiry is enforced server-side in
  // verifyApiToken regardless; this is only the cosmetic badge.
  status: TokenStatus
}

// Expiry presets. `undefined` = never expires.
const EXPIRY_OPTIONS: { label: string; days: number | undefined }[] = [
  { label: 'Never', days: undefined },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
]

const day = (v: string | null): string =>
  v ? new Date(v).toISOString().slice(0, 10) : '—'

// Human-readable "last used" relative time — "Just now", "5 mins ago",
// "2 hours ago", "1 day ago". Beyond a month an exact date reads better than
// "47 days ago", so it falls back to `day()`. The exact timestamp is always
// available as the cell's title (hover) tooltip. Computed from Date.now(), so
// the rendering span MUST carry suppressHydrationWarning — the SSR clock and
// the client clock differ by the request/hydrate gap, which would otherwise
// trip a React #418 text-content hydration mismatch on a fresh token.
const relativeUsed = (v: string): string => {
  const then = new Date(v).getTime()
  if (Number.isNaN(then)) return '—'
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return 'Just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return day(v)
}

// Public HTTP API reference + agent-onboarding destinations.
const API_DOCS_URL = 'https://cavecms.derricksiawor.com/docs/api'

// After the secret is shown, the reveal flow walks three steps:
//   token     — copy the one-time secret (the existing screen)
//   assistant — "are you wiring this into an AI assistant?" (optional fork)
//   setup     — hand the assistant the docs + AGENTS.md + a paste-ready brief
type RevealStage = 'token' | 'assistant' | 'setup'

// A ready-to-paste prompt the operator drops into Claude Code / Cursor / any
// AI tool. It carries everything the assistant needs to edit THIS install:
// its own API base (the admin origin), the Bearer scheme, the HTTP reference,
// the AGENTS.md pointer, and — per the operator's choice — the live token, so
// it's a single paste with zero follow-up. The whole purpose of the token is
// to be handed to this assistant; this is the handoff channel they asked for.
function buildAssistantBriefing(token: string): string {
  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'https://your-cavecms-site.example'
  return `I'm using CaveCMS (https://cavecms.derricksiawor.com) to run my website. Please help me edit its content through the CaveCMS HTTP API.

Setup
- API base URL: ${origin}
- Authentication: send the header  Authorization: Bearer <token>  on every request. No cookie or CSRF header is needed.
- MCP server (best for AI agents): connect your MCP client to  ${origin}/api/cms/mcp  with that same Authorization header — e.g.  claude mcp add --transport http cavecms ${origin}/api/cms/mcp --header "Authorization: Bearer <token>"
- API reference: ${API_DOCS_URL} — read this for the endpoints and request shapes.
- If you have this project's source code on disk, read the AGENTS.md file at its root FIRST — it spells out exactly what you may and may not change.

Ground rules
- CaveCMS is a third-party CMS. Do NOT modify its source code (app/, components/, lib/, db/, scripts/, config files).
- Build my site by creating and editing pages, blocks, posts, and branding THROUGH the API only.

My token (treat it like a password): ${token}`
}

function StatusBadge({ status }: { status: TokenStatus }) {
  const [label, cls] =
    status === 'revoked'
      ? ['Revoked', 'bg-warm-stone/15 text-warm-stone']
      : status === 'expired'
        ? ['Expired', 'bg-warm-stone/15 text-warm-stone']
        : ['Active', 'bg-copper-100 text-copper-700']
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${cls}`}
    >
      {label}
    </span>
  )
}

export function ApiTokensClient({ initial }: { initial: TokenListItem[] }) {
  const toast = useToast()
  const router = useRouter()
  const reauthCtl = usePasswordReauth()
  const reauth = reauthCtl.ensureReauth

  const [name, setName] = useState('')
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('editor')
  const [expiryIdx, setExpiryIdx] = useState(0)
  // Access mode: 'full' = unrestricted within role (scopes omitted); 'custom'
  // = the per-resource grant grid below. Highest action per resource wins.
  const [scopeMode, setScopeMode] = useState<'full' | 'custom'>('full')
  const [scopeGrants, setScopeGrants] = useState<
    Record<ScopeResource, ScopeAction | 'none'>
  >(
    () =>
      Object.fromEntries(SCOPE_RESOURCES.map((r) => [r, 'none'])) as Record<
        ScopeResource,
        ScopeAction | 'none'
      >,
  )
  const [createError, setCreateError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The freshly-minted plaintext token, shown exactly once.
  const [revealed, setRevealed] = useState<{
    token: string
    name: string
    role: string
  } | null>(null)
  const [copied, setCopied] = useState(false)
  // Which step of the reveal flow is on screen (only meaningful while
  // `revealed` is set).
  const [stage, setStage] = useState<RevealStage>('token')
  const [briefingCopied, setBriefingCopied] = useState(false)

  const [pendingRevoke, setPendingRevoke] = useState<TokenListItem | null>(null)
  const [pendingRotate, setPendingRotate] = useState<TokenListItem | null>(null)

  // Client-side pagination — keeps a long token list from running off the
  // bottom of the page. Controls only appear past one page (PAGE_SIZE).
  const PAGE_SIZE = 8
  const [page, setPage] = useState(1)

  // Tick once a minute so the "Last used" relative labels stay fresh while
  // the page sits open — the state bump alone re-renders; relativeUsed()
  // recomputes from Date.now() each render. Interval-only (no mount bump):
  // the first paint already reflects request-time, and a mount setState would
  // be a wasted re-render. Cleared on unmount.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (reauthCtl.fatal === 'rate_limited') {
      toast.error('Too many tries — wait a moment and try again.')
      reauthCtl.clearFatal()
    } else if (reauthCtl.fatal === 'http') {
      toast.error("We couldn't verify your password. Try again.")
      reauthCtl.clearFatal()
    }
  }, [reauthCtl, reauthCtl.fatal, toast])

  async function create() {
    if (busy) return
    setCreateError(null)
    if (name.trim().length === 0) {
      setCreateError('Give the token a name so you can recognise it later.')
      return
    }
    setBusy(true)
    try {
      // reauth() never throws — usePasswordReauth settles its own state and
      // returns false on a network/timeout failure (surfacing a fatal toast).
      if (!(await reauth())) return
      // 'full' → omit scopes (unrestricted within role). 'custom' → one
      // "<resource>:<action>" grant per resource the operator gave access to.
      const scopes =
        scopeMode === 'full'
          ? undefined
          : SCOPE_RESOURCES.flatMap((res) =>
              scopeGrants[res] === 'none' ? [] : [`${res}:${scopeGrants[res]}`],
            )
      let r: Response
      try {
        r = await csrfFetch('/api/admin/api-tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            role,
            expiresInDays: EXPIRY_OPTIONS[expiryIdx]!.days,
            scopes,
          }),
        })
      } catch {
        // Failed before the server responded — the token was NOT created.
        setCreateError(
          "We couldn't reach the server. Check your connection and try again.",
        )
        return
      }
      if (r.status >= 500) {
        // 5xx (e.g. 504 handler_timeout) AFTER the request was sent: the
        // mint+audit transaction MAY have committed even though we got no
        // usable response. Tell the operator to check for + revoke any
        // unexpected row, and refresh so a phantom token becomes visible.
        setCreateError(
          'The server timed out. A token may have been created — check the list below and revoke any unexpected one, then try again.',
        )
        router.refresh()
        return
      }
      if (!r.ok) {
        setCreateError("We couldn't create that token. Try again in a moment.")
        return
      }
      // From here the token WAS created on the server. The secret is shown
      // only in THIS response — if we can't parse/display it, the operator
      // must revoke the just-created token and make a new one (it's not
      // recoverable). Reload so that token row appears for revoking.
      let token: string | undefined
      let roleOut: string | undefined
      try {
        const j = (await r.json()) as { token?: unknown; role?: unknown }
        if (typeof j.token === 'string' && j.token.length > 0) token = j.token
        if (typeof j.role === 'string') roleOut = j.role
      } catch {
        /* fall through to the lost-token guard below */
      }
      if (!token) {
        setCreateError(
          'Your token was created but we couldn’t display it. Revoke the most recent token in the list below, then create a new one.',
        )
        // router.refresh() re-fetches the server component (the new revocable
        // row appears) WITHOUT a full navigation, so the recovery message
        // above actually PAINTS — window.location.reload() would tear down
        // the React tree before React commits the setCreateError update.
        router.refresh()
        return
      }
      setCopied(false)
      setBriefingCopied(false)
      setStage('token')
      setRevealed({ token, name: name.trim(), role: roleOut ?? role })
      setName('')
    } finally {
      setBusy(false)
    }
  }

  async function copyToken() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.token)
      setCopied(true)
    } catch {
      toast.error('Copy failed — select the token and copy it manually.')
    }
  }

  async function copyBriefing() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(buildAssistantBriefing(revealed.token))
      setBriefingCopied(true)
    } catch {
      toast.error('Copy failed — select the briefing and copy it manually.')
    }
  }

  // Closing the whole reveal flow: drop the plaintext from memory and reload
  // in place so the new token row appears in the list. router.refresh()
  // re-fetches the server component WITHOUT a full navigation, so no white
  // flash and any pending toast survives.
  function finishFlow() {
    setRevealed(null)
    setStage('token')
    setCopied(false)
    setBriefingCopied(false)
    router.refresh()
  }

  async function onConfirmRevoke() {
    if (!pendingRevoke || busy) return
    const target = pendingRevoke
    // Close the confirm modal BEFORE the reauth prompt opens — otherwise the
    // two dialogs stack and the confirm overlay occludes the reauth modal's
    // Continue button, making revoke impossible to complete.
    setPendingRevoke(null)
    setBusy(true)
    try {
      // reauth() never throws (see create()).
      if (!(await reauth())) return
      let r: Response
      try {
        r = await csrfFetch(`/api/admin/api-tokens/${target.id}`, {
          method: 'DELETE',
        })
      } catch {
        // Network error before a response — the token is still active.
        // Don't reload; keep it visible so the operator can retry.
        toast.error(
          "We couldn't reach the server. Check your connection and try again.",
        )
        return
      }
      if (!r.ok && r.status !== 204) {
        toast.error('Revoke failed — refresh and try again.')
        return
      }
      toast.success(`"${target.name}" revoked.`)
      // Refresh in place so the success toast survives to be seen.
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function onConfirmRotate() {
    if (!pendingRotate || busy) return
    const target = pendingRotate
    setPendingRotate(null)
    setBusy(true)
    try {
      if (!(await reauth())) return
      let r: Response
      try {
        r = await csrfFetch(`/api/admin/api-tokens/${target.id}/rotate`, {
          method: 'POST',
        })
      } catch {
        toast.error(
          "We couldn't reach the server. Check your connection and try again.",
        )
        return
      }
      if (!r.ok) {
        toast.error('Rotate failed — refresh and try again.')
        return
      }
      // The new secret is in THIS response only — drop into the same one-time
      // reveal flow so the operator copies it (and can re-brief their agent).
      let token: string | undefined
      try {
        const j = (await r.json()) as { token?: unknown }
        if (typeof j.token === 'string' && j.token.length > 0) token = j.token
      } catch {
        /* fall through */
      }
      if (!token) {
        toast.error(
          'Rotated, but the new secret could not be shown. Rotate again to get a fresh one.',
        )
        router.refresh()
        return
      }
      setCopied(false)
      setBriefingCopied(false)
      setStage('token')
      setRevealed({ token, name: target.name, role: target.role })
    } finally {
      setBusy(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(initial.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = initial.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <section className="mt-10">
      {/* Create */}
      <div className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-warm-stone">
          Create a token
        </p>
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-near-black">
              Name
            </span>
            <Input
              placeholder="e.g. “Content bot”"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoComplete="off"
              className="w-full"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-near-black">
                Role
              </span>
              <select
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as 'admin' | 'editor' | 'viewer')
                }
                disabled={busy}
                className="w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
                aria-label="Role"
              >
                <option value="viewer">Viewer (read-only)</option>
                <option value="editor">Editor (edit content)</option>
                <option value="admin">Admin (content + branding)</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-near-black">
                Expires
              </span>
              <select
                value={expiryIdx}
                onChange={(e) => setExpiryIdx(Number(e.target.value))}
                disabled={busy}
                className="w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
                aria-label="Expires"
              >
                {EXPIRY_OPTIONS.map((o, i) => (
                  <option key={o.label} value={i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* Access — visual per-resource scope picker (not a list of names). */}
          <div className="block">
            <span className="mb-1.5 block text-xs font-medium text-near-black">
              Access
            </span>
            <div className="flex gap-2">
              {(['full', 'custom'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setScopeMode(m)}
                  disabled={busy}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                    scopeMode === m
                      ? 'bg-copper-600 text-cream-50'
                      : 'bg-cream-100 text-warm-stone hover:bg-cream-200'
                  }`}
                >
                  {m === 'full' ? 'Full access' : 'Custom scopes'}
                </button>
              ))}
            </div>
            {scopeMode === 'full' ? (
              <p className="mt-2 text-xs text-warm-stone">
                The token can do anything its role allows, across all content.
              </p>
            ) : (
              <div className="mt-3 space-y-1.5 rounded-lg border border-warm-stone/20 bg-cream-50/60 p-3">
                <p className="mb-2 text-[11px] leading-relaxed text-warm-stone">
                  Grant the least each resource needs. Write includes read;
                  delete includes write.
                </p>
                {SCOPE_RESOURCES.map((res) => (
                  <div
                    key={res}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="text-xs font-medium capitalize text-near-black">
                      {res}
                    </span>
                    <div className="flex gap-1">
                      {(['none', ...SCOPE_ACTIONS] as const).map((act) => (
                        <button
                          key={act}
                          type="button"
                          onClick={() =>
                            setScopeGrants((g) => ({ ...g, [res]: act }))
                          }
                          disabled={busy}
                          aria-pressed={scopeGrants[res] === act}
                          className={`rounded-md px-2 py-1 text-[11px] font-semibold capitalize transition-colors disabled:opacity-50 ${
                            scopeGrants[res] === act
                              ? 'bg-copper-600 text-cream-50'
                              : 'bg-cream-100 text-warm-stone hover:bg-cream-200'
                          }`}
                        >
                          {act}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex">
            <Button
              onClick={create}
              disabled={busy}
              className="w-full sm:w-fit"
            >
              Generate token
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-warm-stone">
          The token is shown once, right after you create it. Store it
          somewhere safe — you won&rsquo;t be able to see it again.
        </p>
      </div>

      {createError && (
        <p className="mt-4 text-sm font-medium text-copper-700">{createError}</p>
      )}

      {/* List */}
      {initial.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-warm-stone/20 bg-cream-50/40 px-4 py-12 text-center text-sm text-warm-stone">
          No tokens yet. Create one above to start editing via the API.
        </div>
      ) : (
        <>
          {/* Desktop / tablet — full table (md and up) */}
          <div className="mt-6 hidden overflow-hidden rounded-2xl border border-warm-stone/20 md:block">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-cream-50/80 text-[10px] font-semibold uppercase tracking-[0.14em] text-warm-stone">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Token</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Last used</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="hidden px-4 py-3 lg:table-cell">Created by</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((t) => {
                  const inactive = t.revoked_at !== null
                  return (
                    <tr
                      key={t.id}
                      className={`border-t border-warm-stone/15 text-xs ${
                        inactive ? 'opacity-55' : ''
                      }`}
                    >
                      <td className="px-4 py-3 font-medium text-near-black">
                        {t.name}
                      </td>
                      <td className="px-4 py-3 font-mono text-warm-stone">
                        {t.token_prefix}&middot;&middot;&middot;&middot;
                      </td>
                      <td className="px-4 py-3 text-near-black">
                        <span className="capitalize">{t.role}</span>
                        {t.scopes !== null && (
                          <span
                            title={
                              t.scopes.length
                                ? t.scopes.join(', ')
                                : 'no grants'
                            }
                            className="ml-1.5 inline-block rounded-full bg-warm-stone/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-warm-stone"
                          >
                            scoped
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-warm-stone">
                        {t.last_used_at ? (
                          <span
                            suppressHydrationWarning
                            title={day(t.last_used_at)}
                          >
                            {relativeUsed(t.last_used_at)}
                          </span>
                        ) : (
                          'Never'
                        )}
                      </td>
                      <td className="px-4 py-3 text-warm-stone">
                        {t.expires_at ? day(t.expires_at) : 'Never'}
                      </td>
                      <td className="hidden px-4 py-3 text-warm-stone lg:table-cell">
                        {t.created_by_email ? (
                          <CfSafeMailto
                            email={t.created_by_email}
                            linked={false}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!inactive && (
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => setPendingRotate(t)}
                              disabled={busy}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-near-black hover:bg-cream-100 disabled:opacity-50"
                              aria-label={`Rotate ${t.name}`}
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                              Rotate
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingRevoke(t)}
                              disabled={busy}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-copper-700 hover:bg-copper-50 disabled:opacity-50"
                              aria-label={`Revoke ${t.name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Revoke
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile — stacked cards (below md) so nothing is clipped or hidden */}
          <div className="mt-6 space-y-3 md:hidden">
            {pageItems.map((t) => {
              const inactive = t.revoked_at !== null
              return (
                <div
                  key={t.id}
                  className={`rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4 ${
                    inactive ? 'opacity-55' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-near-black">
                        {t.name}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-warm-stone">
                        {t.token_prefix}&middot;&middot;&middot;&middot;
                      </p>
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div>
                      <dt className="text-[10px] uppercase tracking-[0.14em] text-warm-stone">
                        Role
                      </dt>
                      <dd className="mt-0.5 text-near-black">
                        <span className="capitalize">{t.role}</span>
                        {t.scopes !== null && (
                          <span
                            title={
                              t.scopes.length ? t.scopes.join(', ') : 'no grants'
                            }
                            className="ml-1.5 inline-block rounded-full bg-warm-stone/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-warm-stone"
                          >
                            scoped
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-[0.14em] text-warm-stone">
                        Last used
                      </dt>
                      <dd className="mt-0.5 text-near-black">
                        {t.last_used_at ? (
                          <span
                            suppressHydrationWarning
                            title={day(t.last_used_at)}
                          >
                            {relativeUsed(t.last_used_at)}
                          </span>
                        ) : (
                          'Never'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-[0.14em] text-warm-stone">
                        Expires
                      </dt>
                      <dd className="mt-0.5 text-near-black">
                        {t.expires_at ? day(t.expires_at) : 'Never'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[10px] uppercase tracking-[0.14em] text-warm-stone">
                        Created by
                      </dt>
                      <dd className="mt-0.5 truncate text-near-black">
                        {t.created_by_email ? (
                          <CfSafeMailto
                            email={t.created_by_email}
                            linked={false}
                          />
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                  </dl>
                  {!inactive && (
                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        onClick={() => setPendingRotate(t)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-warm-stone/30 px-3 py-1.5 text-xs font-semibold text-near-black hover:bg-cream-100 disabled:opacity-50"
                        aria-label={`Rotate ${t.name}`}
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        Rotate
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingRevoke(t)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-copper-300/60 px-3 py-1.5 text-xs font-semibold text-copper-700 hover:bg-copper-50 disabled:opacity-50"
                        aria-label={`Revoke ${t.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Revoke
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Pagination — only past one page */}
          {pageCount > 1 && (
            <div className="mt-4 flex flex-col items-start gap-3 text-xs text-warm-stone sm:flex-row sm:items-center sm:justify-between">
              <span>
                Page {safePage} of {pageCount} &middot; {initial.length} tokens
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="rounded-md border border-warm-stone/30 px-3 py-1.5 font-medium text-near-black transition-colors hover:bg-cream-50 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={safePage >= pageCount}
                  className="rounded-md border border-warm-stone/30 px-3 py-1.5 font-medium text-near-black transition-colors hover:bg-cream-50 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Reveal flow: token → assistant? → assistant setup */}
      {revealed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={
            stage === 'token'
              ? 'Your new API token'
              : stage === 'assistant'
                ? 'Use this token with an AI assistant?'
                : 'Set up your AI assistant'
          }
        >
          {/* Step 1 — one-time token reveal */}
          {stage === 'token' && (
            <div className="w-full max-w-lg rounded-2xl border border-warm-stone/20 bg-cream-50 p-7 shadow-2xl">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-copper-100 text-copper-700">
                  <KeyRound className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="font-serif text-2xl font-bold text-near-black">
                    Token created
                  </h2>
                  <p className="text-xs text-warm-stone">
                    {revealed.name} &middot;{' '}
                    <span className="capitalize">{revealed.role}</span>
                  </p>
                </div>
              </div>

              <p className="mt-5 text-sm font-medium text-near-black">
                Copy your token now — you won&rsquo;t be able to see it again.
                Treat it like a password.
              </p>

              <div className="mt-3 flex items-stretch gap-2">
                <code className="flex-1 overflow-x-auto rounded-lg border border-warm-stone/30 bg-cream-100 px-3 py-2.5 font-mono text-xs text-near-black">
                  {revealed.token}
                </code>
                <button
                  type="button"
                  onClick={copyToken}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-copper-600 px-3 text-xs font-semibold text-cream-50 hover:bg-copper-700"
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" /> Copy
                    </>
                  )}
                </button>
              </div>

              <p className="mt-4 rounded-lg bg-copper-50 px-3 py-2 text-xs leading-relaxed text-copper-800">
                Send it as{' '}
                <code className="font-mono">
                  Authorization: Bearer &lt;token&gt;
                </code>{' '}
                to the CaveCMS API. No cookie or CSRF header is needed.
              </p>

              <div className="mt-6 flex justify-end">
                <Button onClick={() => setStage('assistant')}>Done</Button>
              </div>
            </div>
          )}

          {/* Step 2 — optional fork: wiring this into an AI assistant? */}
          {stage === 'assistant' && (
            <div className="w-full max-w-md rounded-2xl border border-warm-stone/20 bg-cream-50 p-7 shadow-2xl">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-copper-100 text-copper-700">
                  <Sparkles className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="font-serif text-2xl font-bold text-near-black">
                    One more thing
                  </h2>
                  <p className="text-xs text-warm-stone">
                    {revealed.name} is ready to use
                  </p>
                </div>
              </div>

              <p className="mt-5 text-sm font-medium text-near-black">
                Using this token with an AI assistant?
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-warm-stone">
                We&rsquo;ll point Claude&nbsp;Code, Cursor, or any AI tool at
                this site — and hand it everything it needs to edit your
                content for you.
              </p>

              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={finishFlow}>
                  No, I&rsquo;m all set
                </Button>
                <Button onClick={() => setStage('setup')}>
                  Yes, set it up
                </Button>
              </div>
            </div>
          )}

          {/* Step 3 — assistant setup: docs + AGENTS.md + paste-ready brief */}
          {stage === 'setup' && (
            <div className="w-full max-w-lg rounded-2xl border border-warm-stone/20 bg-cream-50 p-7 shadow-2xl">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-copper-100 text-copper-700">
                  <Sparkles className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="font-serif text-2xl font-bold text-near-black">
                    Set up your AI assistant
                  </h2>
                  <p className="text-xs text-warm-stone">
                    Two things, and it can edit this site
                  </p>
                </div>
              </div>

              <p className="mt-5 text-sm leading-relaxed text-near-black">
                Point your assistant at these, and it will know exactly what to
                call and how.
              </p>

              <div className="mt-4 space-y-3">
                {/* API reference */}
                <div className="flex items-start gap-3 rounded-xl border border-warm-stone/20 bg-cream-100/50 p-4">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-copper-100 text-copper-700">
                    <BookOpen className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-near-black">
                      API reference
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-warm-stone">
                      The full HTTP API — endpoints, auth, and copy-paste
                      examples.
                    </p>
                  </div>
                  <a
                    href={API_DOCS_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warm-stone/30 px-3 py-1.5 text-[11px] font-semibold text-near-black transition-colors hover:border-copper-400 hover:bg-cream-50 hover:text-copper-700"
                  >
                    Open docs
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </a>
                </div>

                {/* AGENTS.md */}
                <div className="flex items-start gap-3 rounded-xl border border-warm-stone/20 bg-cream-100/50 p-4">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-copper-100 text-copper-700">
                    <FileCode2 className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-near-black">
                      <code className="font-mono text-[13px]">AGENTS.md</code>
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-warm-stone">
                      Coding assistants — Claude&nbsp;Code, Cursor, Windsurf,
                      Codex — read the <code className="font-mono">AGENTS.md</code>{' '}
                      at your project&rsquo;s root automatically. It tells them
                      exactly what they may and may not touch.
                    </p>
                  </div>
                </div>
              </div>

              {/* Paste-ready briefing — the one-tap handoff */}
              <div className="mt-5 rounded-xl border border-copper-200/70 bg-copper-50/70 p-4">
                <p className="text-sm font-semibold text-near-black">
                  Hand it everything in one paste
                </p>
                <p className="mt-1 text-xs leading-relaxed text-warm-stone">
                  Copy a ready-made prompt with your API URL, this token, and
                  the links above — then paste it into your assistant to begin.
                </p>
                <button
                  type="button"
                  onClick={copyBriefing}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-copper-600 px-5 py-2.5 text-xs font-semibold text-cream-50 transition-colors hover:bg-copper-700 sm:w-fit"
                >
                  {briefingCopied ? (
                    <>
                      <Check className="h-4 w-4" /> Briefing copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" /> Copy assistant briefing
                    </>
                  )}
                </button>
                <p className="mt-2.5 text-[11px] leading-relaxed text-copper-800">
                  Includes your token — treat the briefing like a password.
                </p>
              </div>

              <div className="mt-6 flex justify-end">
                <Button onClick={finishFlow}>Done</Button>
              </div>
            </div>
          )}
        </div>
      )}

      <PasswordPromptModal {...reauthCtl.modalProps} />
      <ConfirmModal
        open={pendingRevoke !== null}
        title="Revoke this token?"
        description={
          pendingRevoke
            ? `"${pendingRevoke.name}" will stop working immediately. Any tool or assistant using it will lose access. This can't be undone — you'd create a new token instead.`
            : ''
        }
        confirmLabel="Revoke"
        destructive
        busy={busy}
        onConfirm={onConfirmRevoke}
        onCancel={() => {
          if (!busy) setPendingRevoke(null)
        }}
      />
      <ConfirmModal
        open={pendingRotate !== null}
        title="Rotate this token?"
        description={
          pendingRotate
            ? `A fresh secret will be issued for "${pendingRotate.name}" and the current one stops working immediately. Any tool or assistant using the old secret must be updated with the new one. The role and scopes stay the same.`
            : ''
        }
        confirmLabel="Rotate"
        busy={busy}
        onConfirm={onConfirmRotate}
        onCancel={() => {
          if (!busy) setPendingRotate(null)
        }}
      />
    </section>
  )
}
