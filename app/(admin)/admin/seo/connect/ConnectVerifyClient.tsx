'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/inline-edit/Switch'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { PasswordPromptModal } from '@/components/admin/PasswordPromptModal'
import { usePasswordReauth } from '@/hooks/usePasswordReauth'
import { generateIndexNowKey } from '@/lib/seo/indexnow/key'
import type { Engine } from '@/lib/seo/indexnow/submit'
import type { SubmitReport } from '@/lib/seo/indexnow/submit'
import { SeoCard } from '@/components/seo/SeoCard'
import { CopyField } from '@/components/seo/CopyField'
import { EngineToggle } from '@/components/seo/EngineToggle'
import { EngineLogo } from '@/components/seo/EngineLogo'
import { SetupGuide, type GuideStep } from '@/components/seo/SetupGuide'
import { EngineExplainer } from '@/components/seo/EngineExplainer'
import { VERIFY_ENGINES } from '@/components/seo/engines'

// ── Types mirroring the (redacted) server payload ──
interface WebmasterValue {
  google?: string
  bing?: string
  yandex?: string
  pinterest?: string
  baidu?: string
  naver?: string
}
interface IndexnowValue {
  enabled?: boolean
  key?: string
  engines?: Engine[]
  submitOnPublish?: boolean
}
interface IndexingApiValue {
  enabled?: boolean
  serviceAccountEmail?: string
}

// Client-safe map of the EXACT <meta name="…"> each console expects.
// Mirrors lib/seo/webmaster/verificationMeta.ts (which is server-only),
// kept here so the form can render the live tag without a server round-
// trip. The verification code charset is locked by the registry schema,
// so it's attribute-safe.
const META_NAME: Record<keyof WebmasterValue, string> = {
  google: 'google-site-verification',
  bing: 'msvalidate.01',
  yandex: 'yandex-verification',
  pinterest: 'p:domain_verify',
  baidu: 'baidu-site-verification',
  naver: 'naver-site-verification',
}

const WEBMASTER_FIELDS: {
  key: keyof WebmasterValue
  name: string
  logo: string | null
  placeholder: string
}[] = [
  { key: 'google', name: 'Google', logo: '/icons/googlesearchconsole.svg', placeholder: 'e.g. abcd1234… (HTML tag method)' },
  { key: 'bing', name: 'Bing', logo: '/icons/bing.svg', placeholder: 'e.g. A1B2C3D4…' },
  { key: 'yandex', name: 'Yandex', logo: '/icons/yandex.svg', placeholder: 'e.g. a1b2c3d4e5…' },
  { key: 'pinterest', name: 'Pinterest', logo: '/icons/pinterest.svg', placeholder: 'e.g. a1b2c3…' },
  { key: 'baidu', name: 'Baidu', logo: '/icons/baidu.svg', placeholder: 'e.g. code from Baidu Ziyuan' },
  { key: 'naver', name: 'Naver', logo: '/icons/naver.svg', placeholder: 'e.g. code from Naver Search Advisor' },
]

export function ConnectVerifyClient({
  webmaster,
  indexnow,
  indexingApi,
  origin,
  defaults,
}: {
  webmaster: { value: unknown; version: number }
  indexnow: { value: unknown; version: number }
  indexingApi: { value: unknown; version: number; keyOnFile: boolean }
  origin: string | null
  /** Registry defaults for the three keys, passed from the server page so
   *  this client never imports the server-only settings registry. The
   *  indexing-api default is redacted server-side (no serviceAccountJson). */
  defaults: {
    seo_webmaster: WebmasterValue
    seo_indexnow: IndexnowValue
    seo_indexing_api: IndexingApiValue
  }
}) {
  const toast = useToast()

  // Normalize each stored value over its registry default so every
  // optional key is present + controlled regardless of the stored row
  // shape (a fresh-install default row omits optional keys). Belt-and-
  // braces with the per-field `?? ''` guards in each card. The `as`
  // casts are kept on the merged object — the merge guarantees the
  // required keys are present, so the cast is now honest, not a wishful
  // contract gap.
  const webmasterValue = {
    ...defaults.seo_webmaster,
    ...((webmaster.value as Partial<WebmasterValue> | null) ?? {}),
  } as WebmasterValue
  const indexnowValue = {
    ...defaults.seo_indexnow,
    ...((indexnow.value as Partial<IndexnowValue> | null) ?? {}),
  } as IndexnowValue
  const indexingApiValue = {
    ...defaults.seo_indexing_api,
    ...((indexingApi.value as Partial<IndexingApiValue> | null) ?? {}),
  } as IndexingApiValue

  return (
    <section className="mt-10 space-y-6">
      <WebmasterCard
        initial={webmasterValue}
        version={webmaster.version}
        origin={origin}
      />
      <IndexNowCard
        initial={indexnowValue}
        version={indexnow.version}
        origin={origin}
        toast={toast}
      />
      <IndexingApiCard
        initial={indexingApiValue}
        version={indexingApi.version}
        keyOnFile={indexingApi.keyOnFile}
      />
      <EngineExplainer />
    </section>
  )
}

// ─────────────────────── Webmaster verification ───────────────────────

function WebmasterCard({
  initial,
  version: initialVersion,
  origin,
}: {
  initial: WebmasterValue
  version: number
  origin: string | null
}) {
  const toast = useToast()
  const [form, setForm] = useState<WebmasterValue>(initial)
  const [pristine, setPristine] = useState<WebmasterValue>(initial)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  const setField = (key: keyof WebmasterValue, v: string) =>
    setForm((f) => ({ ...f, [key]: v }))

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      // Normalise blank inputs to undefined so the schema's "blank → unset"
      // transform applies cleanly.
      const payload: WebmasterValue = {}
      for (const k of Object.keys(form) as (keyof WebmasterValue)[]) {
        const v = (form[k] ?? '').trim()
        if (v.length > 0) payload[k] = v
      }
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_webmaster', value: payload, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('One of those codes looks off — check it and try again.')
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
      // Adopt the AUTHORITATIVE server version (additive field). A no-op
      // save returns 200 WITHOUT bumping the DB version; blindly doing
      // v + 1 here drifted the client ahead of the server and 409'd the
      // NEXT save. Fall back to v + 1 only if the field is absent.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setForm(payload)
      setPristine(payload)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('Verification codes saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  return (
    <SeoCard
      title="Verify ownership"
      eyebrow="Search consoles"
      help={
        <>
          Paste the verification code from each console below. We render it as
          the exact <code className="font-mono text-[12px]">&lt;meta&gt;</code>{' '}
          tag in your site&rsquo;s head — no file uploads, no DNS changes. Then
          confirm in the console.
        </>
      }
      dirty={dirty}
      busy={busy}
      onSave={() => void save()}
      onUndo={() => setForm(pristine)}
    >
      <div className="space-y-6">
        <div className="space-y-5">
          {WEBMASTER_FIELDS.map((field) => {
            const value = (form[field.key] ?? '').trim()
            return (
              <div key={field.key}>
                <label className="block">
                  <span className="flex items-center gap-2 text-sm font-medium text-near-black">
                    <span className="flex h-6 w-6 items-center justify-center">
                      <EngineLogo logo={field.logo} name={field.name} size={18} />
                    </span>
                    {field.name}
                  </span>
                  <Input
                    className="mt-2"
                    value={form[field.key] ?? ''}
                    placeholder={field.placeholder}
                    maxLength={200}
                    onChange={(e) => setField(field.key, e.target.value)}
                  />
                </label>
                {value.length > 0 && (
                  <div className="mt-2">
                    <CopyField
                      label="Meta tag that will render"
                      value={`<meta name="${META_NAME[field.key]}" content="${value}" />`}
                      toastMessage="Meta tag copied."
                      truncate={false}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Per-engine step-by-step guides for the big three. */}
        <div className="space-y-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
            Step-by-step
          </p>
          {VERIFY_ENGINES.map((engine) => (
            <SetupGuide
              key={engine.key}
              title={`Set up ${engine.consoleName}`}
              subtitle={`Verify with the HTML tag method, then submit your sitemap`}
              leading={
                <span className="flex h-6 w-6 items-center justify-center">
                  <EngineLogo logo={engine.logo} name={engine.name} size={18} />
                </span>
              }
              steps={buildConsoleSteps(engine.key, engine.consoleName, engine.consoleUrl, origin)}
            />
          ))}
        </div>
      </div>
    </SeoCard>
  )
}

// Build the numbered guide for one console. Google / Bing / Yandex share
// the same shape (add property → choose HTML-tag verification → paste the
// code above → verify → submit sitemap), with a couple of engine-specific
// shortcuts called out plainly.
function buildConsoleSteps(
  key: 'google' | 'bing' | 'yandex',
  consoleName: string,
  consoleUrl: string,
  origin: string | null,
): GuideStep[] {
  const sitemapUrl = origin ? `${origin}/sitemap.xml` : 'https://your-site.com/sitemap.xml'
  const steps: GuideStep[] = [
    {
      title: `Open ${consoleName}`,
      body: (
        <>
          Sign in and add your site as a new property using your full address.{' '}
          <a
            href={consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-copper-700 underline underline-offset-2"
          >
            {consoleName} →
          </a>
        </>
      ),
    },
    {
      title: 'Choose the “HTML tag” verification method',
      body: 'The console offers several ways to prove ownership. Pick the HTML tag (meta tag) option — it’s the one this page fills in for you.',
    },
    {
      title: 'Copy the code into the field above',
      body: 'The console shows a meta tag with a content value. Paste just that value into this engine’s field above and click Save — we render the full tag in your site’s head automatically.',
    },
    {
      title: 'Click “Verify” in the console',
      body: 'The console reads your homepage, finds the tag, and confirms ownership. If it can’t find it yet, give it a minute and try again.',
    },
    {
      title: 'Submit your sitemap',
      body: 'In the console’s Sitemaps section, submit your sitemap URL so it can discover every page.',
      extra: (
        <CopyField
          value={sitemapUrl}
          toastMessage="Sitemap URL copied."
        />
      ),
    },
  ]
  if (key === 'bing') {
    steps.splice(1, 0, {
      title: 'Shortcut: import from Google',
      body: 'If you already set up Google Search Console, Bing can import everything in one click — choose “Import from Google Search Console” instead of verifying manually.',
    })
  }
  return steps
}

// ─────────────────────────── IndexNow ───────────────────────────

function IndexNowCard({
  initial,
  version: initialVersion,
  origin,
  toast,
}: {
  initial: IndexnowValue
  version: number
  origin: string | null
  toast: ReturnType<typeof useToast>
}) {
  const [form, setForm] = useState<IndexnowValue>({
    enabled: initial.enabled ?? false,
    key: initial.key,
    engines: initial.engines ?? ['indexnow'],
    submitOnPublish: initial.submitOnPublish ?? true,
  })
  const [pristine, setPristine] = useState<IndexnowValue>(form)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  // Turning IndexNow on with no key yet → mint one immediately so the
  // operator always has a key to display + serve. Isomorphic generator.
  function setEnabled(on: boolean) {
    setForm((f) => ({
      ...f,
      enabled: on,
      key: on && !f.key ? generateIndexNowKey() : f.key,
    }))
  }

  function regenerate() {
    setForm((f) => ({ ...f, key: generateIndexNowKey() }))
    toast.info('New key generated — Save to start serving it.')
  }

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      const payload: IndexnowValue = {
        enabled: form.enabled ?? false,
        engines: form.engines ?? ['indexnow'],
        submitOnPublish: form.submitOnPublish ?? true,
      }
      // Only send a key when one exists (schema treats it optional).
      if (form.key) payload.key = form.key
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_indexnow', value: payload, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('Those IndexNow settings look off — check them and try again.')
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
      // Adopt the authoritative server version (additive) — a no-op save
      // doesn't bump the DB version, so blind v + 1 desyncs + 409s next.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setForm(payload)
      setPristine(payload)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('IndexNow settings saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  const submitAll = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      const r = await csrfFetch('/api/admin/seo/indexnow', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = (await r.json().catch(() => null)) as
        | { ok?: true; report?: SubmitReport; error?: string; message?: string }
        | null
      if (!r.ok) {
        toast.error(body?.message ?? "Couldn't submit your URLs right now.")
        return
      }
      const report = body?.report
      const submitted = report?.submitted ?? 0
      // `report.results` is one entry per (engine × chunk), NOT per URL.
      // An engine counts as FAILED only when EVERY chunk it received
      // failed — a partial success (some chunks ok) means that engine did
      // receive the URLs. A chunk is failed on a network/timeout
      // ('error') or any non-2xx HTTP status. Grouping by engine here
      // gives an honest "N of your engines didn't accept the submission"
      // rather than miscounting per-chunk failures as per-URL failures.
      const results = report?.results ?? []
      const isFailedChunk = (status: number | 'error') =>
        status === 'error' || (typeof status === 'number' && (status < 200 || status >= 300))
      const byEngine = new Map<string, { total: number; failed: number }>()
      for (const res of results) {
        const e = byEngine.get(res.engine) ?? { total: 0, failed: 0 }
        e.total += 1
        if (isFailedChunk(res.status)) e.failed += 1
        byEngine.set(res.engine, e)
      }
      let failedEngines = 0
      for (const e of byEngine.values()) {
        if (e.total > 0 && e.failed === e.total) failedEngines += 1
      }
      const urlWord = (n: number) => `${n} URL${n === 1 ? '' : 's'}`
      if (submitted === 0) {
        // No unique URLs went out. Either there's nothing published yet,
        // or every selected engine rejected the submission outright.
        toast.info(
          failedEngines > 0
            ? 'Nothing was submitted — your selected engines didn’t accept the request. Try again in a moment.'
            : 'Nothing to submit yet — publish a page, post, or project first.',
        )
      } else if (failedEngines > 0) {
        toast.success(
          `Submitted ${urlWord(submitted)} — but ${failedEngines} engine${failedEngines === 1 ? '' : 's'} didn’t accept the submission. Try Submit all now again shortly.`,
        )
      } else {
        toast.success(
          `Submitted ${urlWord(submitted)} to your selected engines.`,
        )
      }
    } finally {
      setSubmitting(false)
    }
  }, [submitting, toast])

  const keyTxtUrl = form.key
    ? `${origin ?? 'https://your-site.com'}/${form.key}.txt`
    : null
  const savedKey = pristine.key
  // The key file is only actually served for the SAVED key. A minted /
  // regenerated key that hasn't been saved yet would 404 at /{key}.txt,
  // so the copyable link is suppressed until form.key === the saved key.
  const keyFileLive = !!form.key && form.key === savedKey
  const savedEngineCount = pristine.engines?.length ?? 0
  // "Submit all now" is only meaningful when a saved, enabled config with
  // at least one selected engine exists — submitting a key that isn't yet
  // being served would 404 the engine's verification fetch, and submitting
  // with no engines selected would ping nothing.
  const canSubmit =
    pristine.enabled === true && !!savedKey && savedEngineCount > 0 && !dirty

  return (
    <SeoCard
      title="Instant indexing (IndexNow)"
      eyebrow="Ping engines on change"
      help="One ping notifies Bing, Yandex, Seznam, and Naver the moment a page changes — a head start over waiting for the next crawl. Google doesn’t use IndexNow."
      dirty={dirty}
      busy={busy}
      onSave={() => void save()}
      onUndo={() => setForm(pristine)}
    >
      <div className="space-y-5">
        <Switch
          label="Turn on IndexNow"
          help="Generates a key and starts serving it. Nothing is submitted until you save."
          checked={form.enabled ?? false}
          onChange={setEnabled}
        />

        {form.enabled && (
          <>
            {form.key && (
              <div className="space-y-3 rounded-xl bg-cream-100/40 p-4">
                {/* The key file is served at the site root ONLY for the
                    SAVED key. While a freshly-minted (or regenerated)
                    key is still pending, its /{key}.txt URL would 404 —
                    so we don't hand the operator a copyable link until
                    the key is actually on file. */}
                {keyFileLive ? (
                  <CopyField
                    label="Your key file (we host this automatically)"
                    value={keyTxtUrl ?? ''}
                    toastMessage="Key file URL copied."
                    help="We serve this file at your site’s root for you — there’s nothing to upload. Engines fetch it to confirm the key is yours."
                  />
                ) : (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
                      Your key file
                    </p>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-warm-stone">
                      Available after you save — we’ll then serve it at your
                      site’s root automatically so engines can confirm the key
                      is yours.
                    </p>
                  </div>
                )}
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={regenerate}
                  >
                    Generate a new key
                  </Button>
                  <p className="mt-1.5 text-[11px] text-warm-stone">
                    Only if your current key may have leaked — engines re-learn
                    the new one on the next submit.
                  </p>
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-medium text-near-black">
                Engines to notify
              </p>
              <EngineToggle
                selected={form.engines ?? ['indexnow']}
                onChange={(engines) => setForm((f) => ({ ...f, engines }))}
              />
            </div>

            <Switch
              label="Submit automatically when a page is published or changed"
              help="Leave on for hands-off instant indexing. Turn off if you’d rather submit manually."
              checked={form.submitOnPublish ?? true}
              onChange={(v) => setForm((f) => ({ ...f, submitOnPublish: v }))}
            />

            <div className="rounded-xl border border-warm-stone/20 p-4">
              <p className="text-sm font-medium text-near-black">
                Submit everything now
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-warm-stone">
                Pings every published page, post, and project to your selected
                engines in one go — handy right after first setup or a big
                content import.
              </p>
              <div className="mt-3">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void submitAll()}
                  disabled={submitting || !canSubmit}
                  title={
                    !canSubmit
                      ? 'Save your IndexNow settings (with at least one engine) first, then submit.'
                      : undefined
                  }
                >
                  {submitting ? 'Submitting…' : 'Submit all now'}
                </Button>
                {!canSubmit && (
                  <p className="mt-1.5 text-[11px] text-warm-stone">
                    {dirty
                      ? 'Save your changes first, then submit.'
                      : savedEngineCount === 0
                        ? 'Select at least one engine and save before submitting.'
                        : 'Save your IndexNow settings, then submit.'}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </SeoCard>
  )
}

// ─────────────────────── Google Indexing API ───────────────────────

function IndexingApiCard({
  initial,
  version: initialVersion,
  keyOnFile: initialKeyOnFile,
}: {
  initial: IndexingApiValue
  version: number
  keyOnFile: boolean
}) {
  const toast = useToast()
  const reauthCtl = usePasswordReauth(
    'Enter your password to save your Google service account',
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

  const [enabled, setEnabled] = useState(initial.enabled ?? false)
  const [json, setJson] = useState('')
  const [pristineEnabled, setPristineEnabled] = useState(initial.enabled ?? false)
  const [email, setEmail] = useState(initial.serviceAccountEmail)
  const [keyOnFile, setKeyOnFile] = useState(initialKeyOnFile)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)

  // Dirty when the toggle moved OR a fresh JSON paste is pending.
  const dirty = enabled !== pristineEnabled || json.trim().length > 0

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      if (!(await reauth())) return
      const payload: Record<string, unknown> = { enabled }
      // Empty paste → omit serviceAccountJson so the server preserves the
      // stored envelope; a non-empty paste is sent verbatim (server
      // encrypts + derives serviceAccountEmail).
      const trimmed = json.trim()
      if (trimmed.length > 0) payload.serviceAccountJson = trimmed
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_indexing_api', value: payload, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('That service account JSON looks off — paste the full key file and try again.')
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
      // Adopt the authoritative server version (additive) before mutating
      // local UI state — a no-op save (toggle unchanged, no fresh paste)
      // returns 200 without bumping the DB version, so blind v + 1
      // desyncs + 409s the next save.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      // On a fresh paste the server derives the email; we can't read it
      // back here without a refetch, so reflect "key on file" + clear the
      // textarea. The email display updates on next page load.
      if (trimmed.length > 0) {
        setKeyOnFile(true)
        const derived = deriveClientEmail(trimmed)
        if (derived) setEmail(derived)
      }
      setJson('')
      setPristineEnabled(enabled)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('Google Indexing API saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, enabled, json, version, toast, reauth])

  function undo() {
    setEnabled(pristineEnabled)
    setJson('')
  }

  return (
    <>
      <SeoCard
        title="Google Indexing API"
        eyebrow="Advanced · job posts & live events"
        help={
          <>
            This is Google&rsquo;s instant-indexing API.{' '}
            <strong className="font-semibold text-near-black">
              Google officially supports it only for job-posting and live-event
              (broadcast) pages.
            </strong>{' '}
            For everything else, Google indexes through your sitemap and crawl —
            so most sites can leave this off. Set it up only if you publish job
            listings or live events.
          </>
        }
        dirty={dirty}
        busy={busy}
        onSave={() => void save()}
        onUndo={undo}
      >
        <div className="space-y-5">
          <Switch
            label="Use the Google Indexing API"
            help="Only takes effect for job-posting and live-event pages."
            checked={enabled}
            onChange={setEnabled}
          />

          <label className="block">
            <span className="block text-sm font-medium text-near-black">
              Service account key (JSON)
            </span>
            <textarea
              className="mt-2 min-h-[140px] w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 font-mono text-[12px] leading-relaxed text-near-black hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40"
              placeholder={
                keyOnFile
                  ? 'Key on file. Paste a new JSON key here only to replace it.'
                  : 'Paste the entire service-account JSON key file from Google Cloud here…'
              }
              value={json}
              onChange={(e) => setJson(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="mt-1 block text-[11px] text-warm-stone">
              Stored encrypted at rest. Never logged. Never sent to your
              visitors. We&rsquo;ll ask for your password before saving.
            </span>
          </label>

          {(keyOnFile || email) && (
            <div className="rounded-xl bg-cream-100/40 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
                Service account on file
              </p>
              {email ? (
                <p className="mt-1.5 break-all font-mono text-[12px] text-near-black">
                  {email}
                </p>
              ) : (
                <p className="mt-1.5 text-sm text-warm-stone">
                  A key is saved. Its email shows here after the next page load.
                </p>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-warm-stone">
                Add this email as an <strong>Owner</strong> of your property in
                Google Search Console so the API is allowed to act for your
                site.
              </p>
            </div>
          )}

          <div className="rounded-xl border border-warm-stone/20 p-4">
            <p className="text-sm font-medium text-near-black">
              How to get a key
            </p>
            <ol className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-warm-stone">
              <li>1. In Google Cloud, create a project and enable the “Indexing API”.</li>
              <li>2. Create a <strong>service account</strong> and generate a JSON key.</li>
              <li>3. Paste that JSON above and save.</li>
              <li>
                4. In Search Console, add the service account&rsquo;s email as an
                Owner of your verified property.
              </li>
            </ol>
          </div>
        </div>
      </SeoCard>
      <PasswordPromptModal {...reauthCtl.modalProps} />
    </>
  )
}

// Best-effort client-side derivation of the service account's email from
// a pasted JSON key, ONLY to update the on-file display optimistically
// after save. The SERVER is the source of truth (it re-derives + stores
// client_email); this is display sugar that the next page load overwrites
// with the authoritative value. Never trusted for anything else.
function deriveClientEmail(jsonText: string): string | undefined {
  try {
    const parsed = JSON.parse(jsonText) as { client_email?: unknown }
    return typeof parsed.client_email === 'string'
      ? parsed.client_email
      : undefined
  } catch {
    return undefined
  }
}
