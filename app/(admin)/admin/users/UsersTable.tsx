'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, ShieldOff, ShieldCheck } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { CfSafeMailto } from '@/components/CfSafeMailto'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PasswordPromptModal } from '@/components/admin/PasswordPromptModal'
import { usePasswordReauth } from '@/hooks/usePasswordReauth'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { useToast } from '@/components/inline-edit/Toast'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'
import { RowActionsMenu } from '@/components/admin/RowActionsMenu'

interface UserRow {
  id: number
  email: string
  name: string | null
  role: 'admin' | 'editor' | 'viewer'
  active: number
  must_rotate_password: number
  last_login_at: Date | string | null
  created_at: Date | string
}

const ROLES = ['admin', 'editor', 'viewer'] as const

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin (full access)',
  editor: 'Editor (can edit content)',
  viewer: 'Viewer (read-only)',
}

const toEpoch = (v: Date | string | null): number | null => {
  if (v === null) return null
  // `Date.parse('0000-00-00 00:00:00')` returns NaN; guard so the
  // value tail-sorts like a real null instead of polluting the
  // string-fallback branch with the literal 'nan'.
  const ms = typeof v === 'string' ? Date.parse(v) : v.getTime()
  return Number.isFinite(ms) ? ms : null
}

// Step-up reauth flow lives entirely client-side: the table prompts
// for the password right before each mutation, POSTs it to
// /api/auth/reauth, and only on 200 fires the actual write. For bulk
// actions, the reauth cookie's freshness window means one prompt
// covers every csrfFetch in the batch.

export function UsersTable({
  initial,
  selfId,
}: {
  initial: UserRow[]
  selfId: number
}) {
  const toast = useToast()
  const { items, bulkUpdate, bulkRemove, removeRow, updateRow } =
    useListMutations<UserRow>(initial)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('editor')
  const [password, setPassword] = useState('')
  // Inline-validation banner for the invite form only. Mid-flight
  // mutation failures (PATCH/DELETE) toast instead.
  const [createError, setCreateError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<UserRow | null>(null)

  const reauthCtl = usePasswordReauth()
  const reauth = reauthCtl.ensureReauth

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
    if (!email.includes('@')) {
      setCreateError('Please enter a valid email address.')
      return
    }
    if (password.length < 12) {
      setCreateError('The starter password must be at least 12 characters long.')
      return
    }
    setBusy(true)
    try {
      if (!(await reauth())) return
      const r = await csrfFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          role,
          password,
        }),
      })
      if (r.status === 409) {
        setCreateError('Someone is already using that email address.')
        return
      }
      if (!r.ok) {
        setCreateError("We couldn't add that user. Try again in a moment.")
        return
      }
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  async function patchOne(
    u: UserRow,
    body: { role?: string; active?: boolean; name?: string },
  ): Promise<void> {
    const r = await csrfFetch(`/api/admin/users/${u.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.status === 409) {
      const j = (await r.json().catch(() => ({ error: 'conflict' }))) as {
        error?: string
      }
      if (j.error === 'last_admin_required') {
        throw new Error("Can't change the last admin.")
      }
      if (j.error === 'cannot_modify_self') {
        throw new Error("Can't modify your own account here.")
      }
      throw new Error('Conflict — refresh and try again.')
    }
    if (!r.ok) throw new Error(`Save failed (${r.status})`)
  }

  async function deleteOne(u: UserRow): Promise<void> {
    const r = await csrfFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' })
    if (r.status === 409) {
      const j = (await r.json().catch(() => ({ error: 'conflict' }))) as {
        error?: string
      }
      if (j.error === 'last_admin_required') {
        throw new Error("Can't remove the last admin.")
      }
      if (j.error === 'cannot_modify_self') {
        throw new Error("Can't remove your own account.")
      }
      throw new Error('Conflict — refresh and try again.')
    }
    if (!r.ok && r.status !== 204) throw new Error(`Failed (${r.status})`)
  }

  async function patchUser(
    u: UserRow,
    body: { role?: string; active?: boolean; name?: string },
  ) {
    if (busy) return
    setBusy(true)
    try {
      if (!(await reauth())) return
      await patchOne(u, body)
      updateRow(u.id, (row) => ({
        ...row,
        role: (body.role as UserRow['role'] | undefined) ?? row.role,
        active:
          body.active === undefined ? row.active : body.active ? 1 : 0,
        name: body.name ?? row.name,
      }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setBusy(false)
    }
  }

  async function onConfirmRemove() {
    if (!pendingRemove || busy) return
    setBusy(true)
    try {
      if (!(await reauth())) return
      await deleteOne(pendingRemove)
      removeRow(pendingRemove.id)
      toast.success(`${pendingRemove.email} removed.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Remove failed.')
    } finally {
      setBusy(false)
      setPendingRemove(null)
    }
  }

  // Capture patchUser in a ref so the columns memo (below) doesn't
  // rebuild on every parent render — the column cells call into the
  // ref's current value, which always points at the latest closure.
  const patchUserRef = useRef(patchUser)
  patchUserRef.current = patchUser
  const callPatchUser = useCallback(
    (u: UserRow, body: { role?: string; active?: boolean; name?: string }) =>
      patchUserRef.current(u, body),
    [],
  )

  // ───────────────────────────────────────── columns
  const columns: AdminTableColumn<UserRow>[] = useMemo(() => [
    {
      key: 'email',
      label: 'Email',
      sortable: true,
      sortAccessor: (r) => r.email.toLowerCase(),
      cell: (r) => (
        <span className="text-xs font-medium text-near-black">
          <CfSafeMailto email={r.email} linked={false} />
          {r.id === selfId && (
            <span className="ml-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-copper-600">
              you
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      sortAccessor: (r) => (r.name ?? '').toLowerCase(),
      cell: (r) => (
        <span className="text-xs text-warm-stone">{r.name ?? '—'}</span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      sortAccessor: (r) => r.role,
      cell: (r) => {
        const isSelf = r.id === selfId
        return (
          <select
            defaultValue={r.role}
            disabled={busy || isSelf}
            onChange={(e) => callPatchUser(r, { role: e.target.value })}
            className="rounded border border-warm-stone/30 bg-cream-50 px-2 py-1 text-xs text-near-black disabled:opacity-50"
            aria-label={`Role for ${r.email}`}
          >
            {ROLES.map((rr) => (
              <option key={rr} value={rr}>
                {ROLE_LABELS[rr] ?? rr}
              </option>
            ))}
          </select>
        )
      },
    },
    {
      key: 'active',
      label: 'Can sign in',
      sortable: true,
      sortAccessor: (r) => r.active,
      cell: (r) => (
        <span className="text-xs">{r.active ? 'Yes' : 'No'}</span>
      ),
    },
    {
      key: 'last_login_at',
      label: 'Last signed in',
      sortable: true,
      sortAccessor: (r) => toEpoch(r.last_login_at),
      cell: (r) => (
        <span className="text-xs text-warm-stone">
          {r.last_login_at
            ? new Date(r.last_login_at).toISOString().slice(0, 10)
            : '—'}
        </span>
      ),
      hideOnMobile: true,
    },
  ], [busy, selfId, callPatchUser])

  // Self row is excluded via `isRowSelectable` on the AdminTable
  // below, so bulk handlers never receive it — the server would
  // refuse with cannot_modify_self anyway, but the UI shouldn't let
  // the operator pick a row that will silently no-op.
  const bulkActions: AdminTableBulkAction<UserRow>[] = useMemo(
    () => [
      {
        id: 'disable',
        label: (n) => `Disable ${n} access`,
        icon: ShieldOff,
        confirm: {
          title: 'Disable access?',
          description: (n) =>
            `These ${n} ${n === 1 ? 'user' : 'users'} won't be able to sign in until you re-enable them. Their account stays in this list — use Remove to delete it.`,
          confirmLabel: 'Disable',
        },
        run: async (selected) => {
          if (!(await reauth())) return { ok: 0, failed: [] }
          return bulkUpdate(
            selected,
            async (u) => {
              await patchOne(u, { active: false })
            },
            (u) => ({ ...u, active: 0 }),
          )
        },
      },
      {
        id: 'enable',
        label: (n) => `Allow ${n} access`,
        icon: ShieldCheck,
        confirm: {
          title: 'Allow access?',
          description: (n) =>
            `These ${n} ${n === 1 ? 'user' : 'users'} will be able to sign in again.`,
          confirmLabel: 'Allow',
        },
        run: async (selected) => {
          if (!(await reauth())) return { ok: 0, failed: [] }
          return bulkUpdate(
            selected,
            async (u) => {
              await patchOne(u, { active: true })
            },
            (u) => ({ ...u, active: 1 }),
          )
        },
      },
      {
        id: 'remove',
        label: (n) => `Remove ${n}`,
        icon: Trash2,
        destructive: true,
        confirm: {
          title: 'Remove these users?',
          description: (n) =>
            `These ${n} ${n === 1 ? 'user' : 'users'} will be permanently removed. Their work history (drafts they edited, audit-log actions) stays in place but the actor is anonymised.`,
          confirmLabel: 'Remove',
        },
        run: async (selected) => {
          if (!(await reauth())) return { ok: 0, failed: [] }
          return bulkRemove(selected, async (u) => {
            await deleteOne(u)
          })
        },
      },
    ],
    // reauth identity changes per render; the rest are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const rowActions = (u: UserRow) => {
    const isSelf = u.id === selfId
    if (isSelf) return null
    return (
      <RowActionsMenu
        ariaLabel={`Actions for ${u.email}`}
        items={[
          {
            id: 'toggle',
            icon: u.active ? ShieldOff : ShieldCheck,
            label: u.active ? 'Disable access' : 'Allow access',
            description: u.active
              ? "They won't be able to sign in"
              : 'Lets them sign in again',
            disabled: busy,
            onSelect: () => patchUser(u, { active: u.active === 0 }),
          },
          {
            id: 'remove',
            icon: Trash2,
            label: 'Remove user',
            description: 'Revoke access; history is preserved',
            disabled: busy,
            destructive: true,
            onSelect: () => setPendingRemove(u),
          },
        ]}
      />
    )
  }

  return (
    <section className="mt-10">
      <div className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-warm-stone">
          Invite a teammate
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
          <Input
            placeholder="Email address"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
          <Input
            placeholder="Their name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
          <select
            value={role}
            onChange={(e) =>
              setRole(e.target.value as 'admin' | 'editor' | 'viewer')
            }
            disabled={busy}
            className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
            aria-label="Role"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r] ?? r}
              </option>
            ))}
          </select>
          <Input
            placeholder="Starter password (12+ characters)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="new-password"
          />
          <Button onClick={create} disabled={busy}>
            Send invite
          </Button>
        </div>
        <p className="mt-3 text-xs text-warm-stone">
          The new user will be asked to choose their own password the first
          time they sign in.
        </p>
      </div>

      {createError && (
        <p className="mt-4 text-sm font-medium text-copper-700">{createError}</p>
      )}

      <div className="mt-6">
        <AdminTable<UserRow>
          rows={items}
          getId={(u) => u.id}
          columns={columns}
          bulkActions={bulkActions}
          rowActions={rowActions}
          isRowSelectable={(u) => u.id !== selfId}
          mobileRowHeader={(u) => (
            <span className="text-base font-semibold text-near-black">
              {u.email}
            </span>
          )}
          emptyState={<p className="text-sm text-warm-stone">No users yet.</p>}
          defaultSort={{ column: 'last_login_at', direction: 'desc' }}
          selectionLabel="selected on this page"
        />
      </div>

      <PasswordPromptModal {...reauthCtl.modalProps} />
      <ConfirmModal
        open={pendingRemove !== null}
        title="Remove this user?"
        description={
          pendingRemove
            ? `${pendingRemove.email} will be permanently removed. Their work history (drafts they edited, audit-log actions) stays in place but the actor is anonymised.`
            : ''
        }
        confirmLabel="Remove"
        destructive
        busy={busy}
        onConfirm={onConfirmRemove}
        onCancel={() => {
          if (!busy) setPendingRemove(null)
        }}
      />
    </section>
  )
}
