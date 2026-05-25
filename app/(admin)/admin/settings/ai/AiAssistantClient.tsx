'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { PasswordPromptModal } from '@/components/admin/PasswordPromptModal'
import { usePasswordReauth } from '@/hooks/usePasswordReauth'
import { AI_MODEL_IDS } from '@/lib/cms/aiModelIds'

interface InitialRow {
  key: 'ai_config'
  value: unknown
  version: number
  updatedAt: string
  keyOnFile: boolean
}

interface AiConfigDraft {
  enabled: boolean
  provider: 'gemini'
  apiKey?: string | null
  apiKeyLast4?: string
  models?: { inline?: string; chat?: string }
  inlineEnabled: boolean
  chatEnabled: boolean
  voicePreset:
    | 'default'
    | 'editorial'
    | 'friendly'
    | 'professional'
    | 'playful'
    | 'custom'
  customVoiceNotes?: string
  verifiedAt?: string
}

const MODEL_LABELS: Record<(typeof AI_MODEL_IDS)[number], string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash — fast, GA',
  'gemini-2.5-pro': 'Gemini 2.5 Pro — capable, GA',
  'gemini-3-flash-preview': 'Gemini 3 Flash — preview',
  'gemini-3.1-pro-preview': 'Gemini 3 Pro — preview',
  'gemini-3.5-flash': 'Gemini 3.5 Flash — newest, GA',
}

const VOICE_LABELS: Record<AiConfigDraft['voicePreset'], string> = {
  default: 'Default — no specific tone',
  editorial: 'Editorial — polished, considered',
  friendly: 'Friendly — warm, conversational',
  professional: 'Professional — clear, business-appropriate',
  playful: 'Playful — light, witty',
  custom: 'Custom — describe your own voice',
}

export function AiAssistantClient({ initial }: { initial: InitialRow }) {
  const toast = useToast()
  const reauthCtl = usePasswordReauth(
    'Enter your password to save AI settings',
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

  const initialForm = useMemo<AiConfigDraft>(
    () => ({
      enabled: false,
      provider: 'gemini',
      inlineEnabled: false,
      chatEnabled: false,
      voicePreset: 'default',
      ...(initial.value && typeof initial.value === 'object'
        ? (initial.value as Partial<AiConfigDraft>)
        : {}),
      // apiKey is write-only — never echo whatever the server sent.
      apiKey: '',
    }),
    [initial.value],
  )

  const [form, setForm] = useState<AiConfigDraft>(initialForm)
  const [pristine, setPristine] = useState<AiConfigDraft>(initialForm)
  const [version, setVersion] = useState(initial.version)
  const [keyOnFile, setKeyOnFile] = useState(initial.keyOnFile)
  const [keyLast4, setKeyLast4] = useState<string | undefined>(
    initialForm.apiKeyLast4,
  )
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<
    | { kind: 'ok'; latencyMs: number; model: string }
    | { kind: 'error'; message: string }
    | null
  >(null)

  const dirty = useMemo(
    () => !structuralEqual(form, pristine),
    [form, pristine],
  )

  const setField = useCallback(
    <K extends keyof AiConfigDraft>(key: K, value: AiConfigDraft[K]) => {
      setForm((f) => ({ ...f, [key]: value }))
    },
    [],
  )

  const setModel = useCallback(
    (surface: 'inline' | 'chat', value: string) => {
      setForm((f) => ({
        ...f,
        models: { ...(f.models ?? {}), [surface]: value },
      }))
    },
    [],
  )

  const handleSave = useCallback(async () => {
    if (saving || !dirty) return
    setSaving(true)
    try {
      if (!(await reauth())) return
      // Empty apiKey field means "keep stored." Send undefined so the
      // server-side merge preserves the existing envelope. A non-empty
      // string is sent verbatim (server encrypts).
      const payload: Record<string, unknown> = { ...form }
      if (payload.apiKey === '' || payload.apiKey === undefined) {
        delete payload.apiKey
      }
      // Server derives apiKeyLast4 from plaintext — never trust client.
      delete payload.apiKeyLast4
      // Server sets verifiedAt only on successful verify — never trust client.
      delete payload.verifiedAt
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'ai_config', value: payload, version }),
      })
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      // Reflect the just-saved state. apiKey input clears so the field
      // returns to its "key on file" affordance; if the operator typed
      // a new plaintext, last4 updates to the new tail.
      const justSavedPlaintext =
        typeof form.apiKey === 'string' && form.apiKey.trim().length > 0
      if (justSavedPlaintext) {
        setKeyOnFile(true)
        setKeyLast4(form.apiKey!.trim().slice(-4))
      }
      const next: AiConfigDraft = { ...form, apiKey: '' }
      setForm(next)
      setPristine(next)
      setVersion((v) => v + 1)
      // A saved-plaintext rotation invalidates the prior verifiedAt
      // server-side; mirror that locally so the green-check pill clears.
      if (justSavedPlaintext) setVerifyResult(null)
      toast.success('AI settings saved.')
    } finally {
      setSaving(false)
    }
  }, [saving, dirty, form, version, toast, reauth])

  const handleVerify = useCallback(async () => {
    if (verifying) return
    setVerifying(true)
    setVerifyResult(null)
    try {
      const payload: Record<string, unknown> = {}
      // Send fresh plaintext ONLY if the operator just typed one.
      // Server refuses arbitrary plaintexts when a key is on file
      // (arbitrary_key_refused) — that's the right call; UI just
      // omits the field.
      if (typeof form.apiKey === 'string' && form.apiKey.trim().length > 0) {
        payload.apiKey = form.apiKey.trim()
      }
      if (form.models?.inline) {
        payload.model = form.models.inline
      }
      const r = await csrfFetch('/api/admin/ai/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (r.status === 422) {
        const body = (await r.json().catch(() => null)) as
          | { detail?: string; error?: string }
          | null
        setVerifyResult({
          kind: 'error',
          message:
            body?.detail ??
            "We couldn't reach Gemini. Check the key and try again.",
        })
        return
      }
      if (r.status === 429) {
        setVerifyResult({
          kind: 'error',
          message: 'Slow down — only 5 verify checks per minute.',
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
      const body = (await r.json().catch(() => null)) as
        | { ok: true; model: string; latencyMs: number }
        | null
      setVerifyResult({
        kind: 'ok',
        model: body?.model ?? 'unknown',
        latencyMs: body?.latencyMs ?? 0,
      })
    } finally {
      setVerifying(false)
    }
  }, [verifying, form])

  return (
    <section className="mt-10 space-y-6">
      <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        <header>
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Provider
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
            Gemini (BYOK)
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-warm-stone">
            Get a free API key at{' '}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-copper-700 underline"
            >
              aistudio.google.com/apikey
            </a>
            . Stored encrypted at rest. Never logged. Never shipped to your
            visitors&apos; browsers.
          </p>
        </header>

        <div className="mt-6 space-y-4">
          <label className="block">
            <span className="block text-sm font-medium text-near-black">
              Gemini API key
            </span>
            <Input
              type="password"
              autoComplete="off"
              placeholder={
                keyOnFile && keyLast4
                  ? `Key on file — ends in •••${keyLast4}. Paste a new key to replace.`
                  : 'AIzaSy…'
              }
              value={typeof form.apiKey === 'string' ? form.apiKey : ''}
              onChange={(e) => setField('apiKey', e.target.value)}
              className="mt-2"
            />
            <span className="mt-1 block text-[11px] text-warm-stone">
              {keyOnFile
                ? 'Leave blank to keep the saved key, or paste a new one to replace it.'
                : 'Paste your key and click Save.'}
            </span>
          </label>

          <fieldset className="rounded-xl border border-warm-stone/20 p-4">
            <legend className="px-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-copper-600">
              Surfaces
            </legend>
            <div className="space-y-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setField('enabled', e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-warm-stone/40 text-copper-600 focus:ring-copper-300"
                />
                <span>
                  <span className="block text-sm font-medium text-near-black">
                    Enable AI features
                  </span>
                  <span className="block text-[11px] text-warm-stone">
                    Master switch. AI surfaces only appear when this is on AND
                    a key is saved.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={form.inlineEnabled}
                  onChange={(e) => setField('inlineEnabled', e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-warm-stone/40 text-copper-600 focus:ring-copper-300"
                  disabled={!form.enabled}
                />
                <span>
                  <span className="block text-sm font-medium text-near-black">
                    Inline sparkle on every section
                  </span>
                  <span className="block text-[11px] text-warm-stone">
                    Hover a block in edit mode → sparkle icon → Rewrite,
                    Translate, Suggest, Fill in.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={form.chatEnabled}
                  onChange={(e) => setField('chatEnabled', e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-warm-stone/40 text-copper-600 focus:ring-copper-300"
                  disabled={!form.enabled}
                />
                <span>
                  <span className="block text-sm font-medium text-near-black">
                    Page Assistant (bottom-left chatbot)
                  </span>
                  <span className="block text-[11px] text-warm-stone">
                    Cross-block edits on the current page. Still scoped to
                    CMS-block content only.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <fieldset className="rounded-xl border border-warm-stone/20 p-4">
            <legend className="px-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-copper-600">
              Models
            </legend>
            <p className="text-[11px] text-warm-stone">
              No fallback default — pick a model for each surface you enable.
              Costs come straight from your Google AI account.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="block text-sm font-medium text-near-black">
                  Inline sparkle
                </span>
                <select
                  className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[44px]"
                  value={form.models?.inline ?? ''}
                  onChange={(e) => setModel('inline', e.target.value)}
                >
                  <option value="">— pick a model —</option>
                  {AI_MODEL_IDS.map((id) => (
                    <option key={id} value={id}>
                      {MODEL_LABELS[id]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-near-black">
                  Page Assistant
                </span>
                <select
                  className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[44px]"
                  value={form.models?.chat ?? ''}
                  onChange={(e) => setModel('chat', e.target.value)}
                >
                  <option value="">— pick a model —</option>
                  {AI_MODEL_IDS.map((id) => (
                    <option key={id} value={id}>
                      {MODEL_LABELS[id]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset className="rounded-xl border border-warm-stone/20 p-4">
            <legend className="px-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-copper-600">
              Voice
            </legend>
            <p className="text-[11px] text-warm-stone">
              How rewrites and suggestions should sound. CaveCMS is generic —
              vertical-specific tones go in Custom.
            </p>
            <div className="mt-4 space-y-2">
              {(Object.keys(VOICE_LABELS) as Array<keyof typeof VOICE_LABELS>).map(
                (preset) => (
                  <label key={preset} className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="voicePreset"
                      value={preset}
                      checked={form.voicePreset === preset}
                      onChange={() => setField('voicePreset', preset)}
                      className="h-4 w-4 border-warm-stone/40 text-copper-600 focus:ring-copper-300"
                    />
                    <span className="text-sm text-near-black">{VOICE_LABELS[preset]}</span>
                  </label>
                ),
              )}
            </div>
            {form.voicePreset === 'custom' && (
              <label className="mt-4 block">
                <span className="block text-sm font-medium text-near-black">
                  Custom voice notes (max 800 chars)
                </span>
                <textarea
                  className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[120px]"
                  maxLength={800}
                  value={form.customVoiceNotes ?? ''}
                  onChange={(e) => setField('customVoiceNotes', e.target.value)}
                  placeholder="Describe your brand voice in your own words. e.g. 'Warm but precise. Use concrete nouns. Avoid hype words.'"
                />
                <span className="mt-1 block text-[11px] text-warm-stone">
                  {(form.customVoiceNotes ?? '').length} / 800
                </span>
              </label>
            )}
          </fieldset>
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
            disabled={
              verifying ||
              (!keyOnFile &&
                (typeof form.apiKey !== 'string' || form.apiKey.trim().length === 0))
            }
            title={
              !keyOnFile && !form.apiKey
                ? 'Paste your Gemini key first.'
                : 'Probes Gemini with the key (stored or just-typed) without saving.'
            }
          >
            {verifying ? 'Testing…' : 'Test connection'}
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
                Connection works — Gemini responded with{' '}
                <span className="font-mono text-[12px]">{verifyResult.model}</span>{' '}
                in {verifyResult.latencyMs} ms.
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
