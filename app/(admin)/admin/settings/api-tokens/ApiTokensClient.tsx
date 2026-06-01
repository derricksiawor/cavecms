'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, Copy, Check, Trash2 } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
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
  const [role, setRole] = useState<'admin' | 'editor'>('editor')
  const [expiryIdx, setExpiryIdx] = useState(0)
  const [createError, setCreateError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The freshly-minted plaintext token, shown exactly once.
  const [revealed, setRevealed] = useState<{
    token: string
    name: string
    role: string
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const [pendingRevoke, setPendingRevoke] = useState<TokenListItem | null>(null)

  // Client-side pagination — keeps a long token list from running off the
  // bottom of the page. Controls only appear past one page (PAGE_SIZE).
  const PAGE_SIZE = 8
  const [page, setPage] = useState(1)

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
      let r: Response
      try {
        r = await csrfFetch('/api/admin/api-tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            role,
            expiresInDays: EXPIRY_OPTIONS[expiryIdx]!.days,
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

  // After the operator dismisses the one-time reveal, reload so the new
  // token row appears in the list (and the plaintext leaves memory).
  function dismissReveal() {
    setRevealed(null)
    // Refresh in place (server component re-fetches the list) — the plaintext
    // is already cleared from state above; no full reload / white flash.
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
                onChange={(e) => setRole(e.target.value as 'admin' | 'editor')}
                disabled={busy}
                className="w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
                aria-label="Role"
              >
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
                      <td className="px-4 py-3 capitalize text-near-black">
                        {t.role}
                      </td>
                      <td className="px-4 py-3 text-warm-stone">
                        {t.last_used_at ? day(t.last_used_at) : 'Never'}
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
                      <dd className="mt-0.5 capitalize text-near-black">
                        {t.role}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-[0.14em] text-warm-stone">
                        Last used
                      </dt>
                      <dd className="mt-0.5 text-near-black">
                        {t.last_used_at ? day(t.last_used_at) : 'Never'}
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
                    <button
                      type="button"
                      onClick={() => setPendingRevoke(t)}
                      disabled={busy}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-copper-300/60 px-3 py-1.5 text-xs font-semibold text-copper-700 hover:bg-copper-50 disabled:opacity-50"
                      aria-label={`Revoke ${t.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Revoke
                    </button>
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

      {/* One-time token reveal */}
      {revealed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Your new API token"
        >
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
              <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>{' '}
              to the CaveCMS API. No cookie or CSRF header is needed.
            </p>

            <div className="mt-6 flex justify-end">
              <Button onClick={dismissReveal}>Done</Button>
            </div>
          </div>
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
    </section>
  )
}
