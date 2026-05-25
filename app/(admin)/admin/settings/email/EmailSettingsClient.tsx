'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { ZodForm } from '@/components/inline-edit/ZodForm'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { SETTINGS_SHAPES, SETTINGS_HELP } from '@/lib/cms/settings-shapes'
import { PasswordPromptModal } from '@/components/admin/PasswordPromptModal'
import { usePasswordReauth } from '@/hooks/usePasswordReauth'

interface SettingRow {
  key: 'smtp_config'
  value: unknown
  version: number
  updatedAt: string
  passwordOnFile: boolean
}

export function EmailSettingsClient({ initial }: { initial: SettingRow }) {
  const toast = useToast()
  // Step-up reauth — SMTP password is credential-class and gated by
  // `REAUTH_KEYS` on the server. Without this, every Save returns
  // 401 reauth_required. Mirrors the IntegrationsForm pattern.
  const reauthCtl = usePasswordReauth(
    'Enter your password to save email settings',
  )
  const reauth = reauthCtl.ensureReauth

  const reauthFatal = reauthCtl.fatal
  const reauthClearFatal = reauthCtl.clearFatal
  useEffect(() => {
    if (reauthFatal === 'rate_limited') {
      toast.error('Too many tries — wait a moment and try again.')
      reauthClearFatal()
    } else if (reauthFatal === 'http') {
      toast.error("We couldn't verify your password. Try again.")
      reauthClearFatal()
    }
  }, [reauthFatal, reauthClearFatal, toast])

  const initialForm = useMemo(
    () =>
      initial.value && typeof initial.value === 'object'
        ? (initial.value as Record<string, unknown>)
        : {},
    [initial.value],
  )
  const [form, setForm] = useState<Record<string, unknown>>(initialForm)
  const [pristine, setPristine] = useState<Record<string, unknown>>(initialForm)
  const [version, setVersion] = useState(initial.version)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [verifying, setVerifying] = useState(false)
  // Most recent connection-test outcome. Drives the inline
  // success/failure pill next to the Test button + helps the
  // operator know whether the toggle can be safely flipped.
  const [verifyResult, setVerifyResult] = useState<
    | { kind: 'ok' }
    | { kind: 'error'; message: string }
    | null
  >(null)
  const dirty = useMemo(
    () => !structuralEqual(form, pristine),
    [form, pristine],
  )

  const handleSave = useCallback(async () => {
    if (saving || !dirty) return
    setSaving(true)
    try {
      // Reauth gate — server-side `REAUTH_KEYS` requires a fresh
      // password verification before accepting any smtp_config write.
      if (!(await reauth())) return
      // Strip the password field IF it's empty AND we have one on
      // file — empty-string-when-saved means "keep the existing
      // password" per the server-side credential-preserving merge
      // (app/api/admin/settings/route.ts).
      const payload: Record<string, unknown> = { ...form }
      if (
        initial.passwordOnFile &&
        (payload.password === '' || payload.password === undefined)
      ) {
        delete payload.password
      }
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'smtp_config', value: payload, version }),
      })
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (r.status === 422) {
        // Server-side SMTP verify gate failed — show the friendly
        // reason next to the form so the operator knows exactly what
        // to fix.
        const body = (await r.json().catch(() => null)) as
          | { detail?: string; error?: string }
          | null
        const detail =
          body?.detail ??
          "We couldn't connect to your SMTP server. Check your credentials."
        setVerifyResult({ kind: 'error', message: detail })
        toast.error(detail)
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      setVersion((v) => v + 1)
      setPristine(form)
      setVerifyResult({ kind: 'ok' })
      toast.success('Email settings saved.')
    } finally {
      setSaving(false)
    }
  }, [saving, dirty, form, version, toast, initial.passwordOnFile, reauth])

  // Test connection — probes SMTP credentials WITHOUT saving. Lets
  // the operator validate before flipping the Enable toggle (which
  // the server will block anyway if verify fails).
  const handleVerify = useCallback(async () => {
    if (verifying) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const payload: Record<string, unknown> = { ...form }
      if (
        initial.passwordOnFile &&
        (payload.password === '' || payload.password === undefined)
      ) {
        delete payload.password
      }
      const r = await csrfFetch('/api/admin/email/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (r.status === 422) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        setVerifyResult({
          kind: 'error',
          message:
            body?.error ??
            "We couldn't connect to your SMTP server. Check your credentials.",
        })
        return
      }
      if (!r.ok) {
        setVerifyResult({
          kind: 'error',
          message: "We couldn't run the connection test. Try again.",
        })
        return
      }
      setVerifyResult({ kind: 'ok' })
    } finally {
      setVerifying(false)
    }
  }, [verifying, form, initial.passwordOnFile])

  // Send-test: hits /api/admin/email/test which uses the SMTP config
  // to send a test email to the currently-logged-in admin.
  const handleTest = useCallback(async () => {
    if (testing) return
    setTesting(true)
    try {
      const r = await csrfFetch('/api/admin/email/test', { method: 'POST' })
      if (r.status === 422) {
        toast.error(
          'Email isn’t set up yet — fill in the form and save first.',
        )
        return
      }
      if (!r.ok) {
        toast.error('Test send failed. Check your SMTP credentials.')
        return
      }
      toast.success('Test email sent. Check your inbox.')
    } finally {
      setTesting(false)
    }
  }, [testing, toast])

  const shapes = SETTINGS_SHAPES.smtp_config ?? []
  const help = SETTINGS_HELP.smtp_config

  return (
    <section className="mt-10 space-y-6">
      <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            SMTP
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
            Outbound email
          </h2>
          {help && (
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-warm-stone">
              {help}
            </p>
          )}
        </header>

        <div className="mt-6">
          <ZodForm shapes={shapes} value={form} onChange={setForm} />
          {initial.passwordOnFile && form.password === '' && (
            <p className="mt-2 text-[11px] text-warm-stone">
              A password is saved. Leave blank to keep it, or type a new one
              to replace it.
            </p>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleVerify()}
            disabled={verifying || !form.host}
            title={
              !form.host
                ? 'Fill in the SMTP server first.'
                : 'Probes the SMTP server with these credentials without sending an email.'
            }
          >
            {verifying ? 'Testing…' : 'Test connection'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleTest()}
            disabled={testing || dirty || !initial.passwordOnFile}
            title={
              dirty
                ? 'Save your changes before sending a test.'
                : !initial.passwordOnFile
                  ? 'Configure SMTP first.'
                  : undefined
            }
          >
            {testing ? 'Sending…' : 'Send test email'}
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setForm(pristine)}
              disabled={saving}
            >
              Undo changes
            </Button>
          )}
          {dirty && (
            <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-copper-700">
              <span className="inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper" />
              Unsaved changes
            </span>
          )}
        </div>

        {verifyResult && (
          <div
            className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
              verifyResult.kind === 'ok'
                ? 'border-emerald-200 bg-emerald-50/60 text-emerald-900'
                : 'border-red-200 bg-red-50/60 text-red-900'
            }`}
          >
            {verifyResult.kind === 'ok' ? (
              <p className="font-medium">
                Connection works — you can turn on outbound email and save.
              </p>
            ) : (
              <>
                <p className="font-medium">Connection failed</p>
                <p className="mt-1 text-xs text-red-800">{verifyResult.message}</p>
              </>
            )}
          </div>
        )}
      </article>
      <PasswordPromptModal {...reauthCtl.modalProps} />
    </section>
  )
}
