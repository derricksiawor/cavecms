'use client'
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Loader2,
  ExternalLink,
  SkipForward,
  Upload,
  X as XIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Wordmark } from '@/components/Wordmark'
import { TEMPLATE_CLIENT_META } from '@/lib/cms/siteTemplates/clientMeta'
import { setInstallToken, installFetch } from './installFetch'

// Single-page multi-step install wizard. Modelled on WordPress's
// install.php flow but expanded to cover the operator-facing settings
// that customers most often want set BEFORE they log in:
//
//   1. Welcome — operator confirms they want to set up
//   2. Admin account — create the first admin user (REQUIRED)
//   3. Site identity — site URL + name (REQUIRED) → settings.site_general
//   4. Branding — brandText + theme (optional) → settings.site_header
//   5. Contact — contact email (optional) → settings.contact_info
//   6. SMTP — host/port/user/password (optional, with test-send) → settings.smtp_config
//   7. Security baseline — custom LOGIN_PATH (optional) → settings.security_login_path
//   8. Done — completion → POST /api/install/complete flips the gate
//
// DB connection is NOT a step here — the CLI wrote it to env.production
// before the app even booted. The wizard's only job is operator-facing
// configuration that lives in the `settings` table.
//
// All endpoints under /api/install/* refuse to run once
// install_state.completedAt is set (see refuseIfInstalled helper).

const STEPS = [
  'welcome',
  'admin',
  'site',
  'template',
  'branding',
  'contact',
  'smtp',
  'security',
  'done',
] as const
type Step = (typeof STEPS)[number]

const STEP_LABELS: Record<Step, string> = {
  welcome: 'Welcome',
  admin: 'Admin',
  site: 'Site',
  template: 'Template',
  branding: 'Branding',
  contact: 'Contact',
  smtp: 'Email',
  security: 'Security',
  done: 'Ready',
}

export function InstallWizard({
  guessedSiteUrl,
  bootstrapToken,
  tokenRequired,
}: {
  guessedSiteUrl: string
  bootstrapToken: string | null
  /** Mirrors the server's requireInstallToken() gate. False in
   *  contributor dev with no INSTALL_BOOTSTRAP_TOKEN — banner stays
   *  hidden so the contributor isn't told to paste a token that the
   *  server isn't going to check anyway. */
  tokenRequired: boolean
}) {
  const [step, setStep] = useState<Step>('welcome')
  const [finalLoginPath, setFinalLoginPath] = useState<string | null>(null)
  // Last template slug the operator applied (initially null). Lifted
  // to the wizard parent so navigating Back → Template restores the
  // previously-picked tile — TemplateStep is unmounted by
  // AnimatePresence between transitions, so its local selection state
  // would otherwise reset on every re-entry. Updated by the template
  // step's onNext / onSkip callbacks.
  const [pickedTemplateSlug, setPickedTemplateSlug] = useState<string | null>(null)

  // Bootstrap-token lifecycle. Three concerns:
  //
  // 1. URL hygiene — strip ?t=… from the address bar so the token
  //    isn't visible in browser history, screenshots, browser sync,
  //    or sent as Referer on same-origin sub-resources.
  // 2. Refresh resilience — if the operator hits Cmd-R after the URL
  //    is stripped, the page re-renders server-side with no `?t=`,
  //    bootstrapToken arrives as `null`, and the wizard would brick.
  //    We stash the token in sessionStorage on first mount and read
  //    it back when bootstrapToken arrives null.
  // 3. Multi-tab — module-level token state in installFetch.ts is
  //    per-tab (each tab has its own JS module instance), so cross-tab
  //    interference doesn't apply. But within a tab, do NOT null the
  //    token on unmount (React Strict Mode double-renders would).
  //
  // sessionStorage scope: per-tab, cleared on tab close. Right scope —
  // the token is only needed for the duration of the wizard, and a
  // fresh tab opening /install should require a fresh CLI-printed URL.
  const SS_KEY = 'cavecms.installBootstrapToken'
  const [resolvedToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return bootstrapToken
    if (bootstrapToken) return bootstrapToken
    try {
      return window.sessionStorage.getItem(SS_KEY)
    } catch {
      return null
    }
  })
  useEffect(() => {
    setInstallToken(resolvedToken)
    if (resolvedToken && typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(SS_KEY, resolvedToken)
      } catch {
        /* private-mode / quota — best effort; banner-paste fallback remains */
      }
    }
    if (typeof window !== 'undefined' && window.location.search.includes('t=')) {
      try {
        window.history.replaceState(null, '', '/install')
      } catch {
        /* SSR/hydration race or older browser — best effort */
      }
    }
  }, [resolvedToken])

  // Show a clear "missing token" banner if NO token reached the wizard
  // (URL had no ?t= AND sessionStorage was empty). They probably typed
  // the URL manually — the CLI's printed URL ALWAYS includes the token.
  // Only show when the server actually requires a token. In contributor
  // dev (NODE_ENV !== production AND no INSTALL_BOOTSTRAP_TOKEN env)
  // the server falls through; nagging the contributor would be a UX
  // leak with no security benefit.
  const tokenMissing = tokenRequired && !resolvedToken

  const goTo = (s: Step) => setStep(s)

  // Resolve the step immediately before `s` in the STEPS array, or
  // null when s is the first step (Welcome). Single source of truth
  // for back-navigation — the per-step onBack handlers all flow
  // through this so adding/removing a step only touches the STEPS
  // tuple and this helper stays correct.
  const stepBefore = (s: Step): Step | null => {
    const idx = STEPS.indexOf(s)
    if (idx <= 0) return null
    return STEPS[idx - 1] ?? null
  }
  // Curried wrapper — passes the Back callback to each step. When the
  // previous step doesn't exist (welcome / done), returns undefined
  // so the step renders without a Back affordance.
  const backTo = (s: Step): (() => void) | undefined => {
    const prev = stepBefore(s)
    if (!prev) return undefined
    return () => goTo(prev)
  }

  return (
    <main className="min-h-screen bg-cream py-12 px-4">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-center pb-8">
          <Wordmark label="CaveCMS" tone="dark" />
        </div>

        {tokenMissing && (
          <TokenRecoveryBanner />
        )}

        <ol className="mb-10 flex items-center justify-center gap-2 flex-wrap">
          {STEPS.map((s, i) => {
            const isCurrent = s === step
            const stepIdx = STEPS.indexOf(step)
            const isDone = i < stepIdx
            return (
              <li
                key={s}
                className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.22em]"
              >
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full border ${
                    isDone
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : isCurrent
                        ? 'border-copper-500 bg-copper-50 text-copper-700'
                        : 'border-warm-stone/30 bg-cream-50 text-warm-stone'
                  }`}
                >
                  {isDone ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span
                  className={`hidden md:inline ${
                    isCurrent
                      ? 'text-copper-700'
                      : isDone
                        ? 'text-emerald-700'
                        : 'text-warm-stone'
                  }`}
                >
                  {STEP_LABELS[s]}
                </span>
                {i < STEPS.length - 1 && (
                  <span aria-hidden="true" className="h-px w-3 bg-warm-stone/30" />
                )}
              </li>
            )
          })}
        </ol>

        <article className="overflow-hidden rounded-3xl border border-warm-stone/20 bg-cream-50/80 p-8 shadow-[0_30px_80px_-30px_rgba(15,15,15,0.15)] backdrop-blur-sm sm:p-12">
          <AnimatePresence mode="wait">
            <StepMotion key={step}>
              {step === 'welcome' && <WelcomeStep onNext={() => goTo('admin')} />}
              {step === 'admin' && (
                <AdminStep onNext={() => goTo('site')} onBack={backTo('admin')} />
              )}
              {step === 'site' && (
                <SiteStep
                  defaultUrl={guessedSiteUrl}
                  onNext={() => goTo('template')}
                  onBack={backTo('site')}
                />
              )}
              {step === 'template' && (
                <TemplateStep
                  onNext={(slug) => {
                    setPickedTemplateSlug(slug)
                    goTo('branding')
                  }}
                  onSkip={(slug) => {
                    setPickedTemplateSlug(slug)
                    goTo('branding')
                  }}
                  onBack={backTo('template')}
                  initialSlug={pickedTemplateSlug}
                />
              )}
              {step === 'branding' && (
                <BrandingStep
                  onNext={() => goTo('contact')}
                  onSkip={() => goTo('contact')}
                  onBack={backTo('branding')}
                />
              )}
              {step === 'contact' && (
                <ContactStep
                  onNext={() => goTo('smtp')}
                  onSkip={() => goTo('smtp')}
                  onBack={backTo('contact')}
                />
              )}
              {step === 'smtp' && (
                <SmtpStep
                  onNext={() => goTo('security')}
                  onSkip={() => goTo('security')}
                  onBack={backTo('smtp')}
                />
              )}
              {step === 'security' && (
                <SecurityStep
                  onNext={(loginPath) => {
                    if (loginPath) setFinalLoginPath(loginPath)
                    goTo('done')
                  }}
                  onSkip={() => goTo('done')}
                  onBack={backTo('security')}
                />
              )}
              {step === 'done' && <DoneStep loginPath={finalLoginPath} />}
            </StepMotion>
          </AnimatePresence>
        </article>
      </div>
    </main>
  )
}

function TokenRecoveryBanner() {
  // Inline recovery for the operator who lost the CLI's printed URL
  // (closed the terminal, copy-pasted only the bare /install link,
  // etc.). They can retrieve the token from env.production on the
  // server: `cat /opt/cavecms/env.production | grep INSTALL_BOOTSTRAP_TOKEN`
  // (VPS) or the equivalent on laptop/cPanel.
  const [pasted, setPasted] = useState('')
  const apply = () => {
    const t = pasted.trim()
    if (!t) return
    setInstallToken(t)
    try {
      window.sessionStorage.setItem('cavecms.installBootstrapToken', t)
    } catch {
      /* best effort */
    }
    window.location.reload()
  }
  return (
    <div className="mb-8 rounded-xl border border-amber-300 bg-amber-50/60 px-4 py-4 text-sm text-amber-900">
      <p className="font-medium">Missing install token.</p>
      <p className="mt-1 text-amber-800">
        Reopen the URL the installer printed (it includes{' '}
        <code className="rounded bg-amber-100/80 px-1 font-mono">?t=…</code>),
        OR paste the token below. On your server it&rsquo;s at{' '}
        <code className="rounded bg-amber-100/80 px-1 font-mono">env.production</code>{' '}
        under <code className="rounded bg-amber-100/80 px-1 font-mono">INSTALL_BOOTSTRAP_TOKEN</code>.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="password"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste your INSTALL_BOOTSTRAP_TOKEN"
          className="flex-1 rounded-lg border border-amber-400 bg-white px-3 py-2 text-near-black focus:outline-none focus:ring-2 focus:ring-amber-500/30"
        />
        <button
          type="button"
          onClick={apply}
          disabled={!pasted.trim()}
          className="rounded-lg bg-amber-700 px-4 py-2 text-cream-50 text-[11px] font-semibold uppercase tracking-[0.18em] disabled:opacity-50"
        >
          Use this token
        </button>
      </div>
    </div>
  )
}

function StepMotion({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}

// ─── Shared form bits ─────────────────────────────────────────────

function FormLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block">
      <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700">
        {children}
      </span>
    </label>
  )
}

const inputClass =
  'mt-2 block w-full rounded-xl border border-warm-stone/30 bg-white px-4 py-3 text-base text-near-black focus:border-copper-500 focus:outline-none focus:ring-2 focus:ring-copper-500/20'

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-xl border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-800">
      {children}
    </p>
  )
}

function StepHeader({
  kicker,
  title,
  lede,
  onBack,
  backDisabled,
}: {
  kicker: string
  title: string
  lede?: string
  /** When provided, renders a small "← Back" link above the kicker.
   *  Welcome (no previous step) and Done (terminal) omit this prop;
   *  every other step passes it in so the operator can revisit
   *  earlier choices without abandoning the wizard. */
  onBack?: () => void
  /** Greys the Back affordance while the step has a POST in flight.
   *  Closes the race where the operator clicks Back mid-submit — the
   *  AnimatePresence unmount would leave the request to land on
   *  server state the operator thinks they abandoned (especially
   *  bad for AdminStep, whose endpoint is one-way). */
  backDisabled?: boolean
}) {
  return (
    <>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          disabled={backDisabled}
          className="-ml-1 mb-4 inline-flex min-h-[28px] items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-medium text-warm-stone transition-colors hover:text-near-black focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-500/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-warm-stone"
          aria-label="Go back to the previous step"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
      )}
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        {kicker}
      </p>
      <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-near-black">
        {title}
      </h1>
      {lede && <p className="mt-3 text-sm text-warm-stone">{lede}</p>}
    </>
  )
}

// ─── Step 1: Welcome ──────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">Welcome</p>
      <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-near-black sm:text-4xl">
        Let&rsquo;s set up your CaveCMS
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-warm-stone">
        We&rsquo;ll walk through a few quick steps to brand your site and unlock
        the operator features you&rsquo;ll need. Most optional steps can be skipped
        and configured from the dashboard later.
      </p>
      <ul className="mt-6 space-y-3 text-sm text-near-black">
        {[
          ['Admin account', 'Required — your login to the dashboard'],
          ['Site identity', 'Required — site URL + name'],
          ['Template', 'Pick a starting layout — (Optional)'],
          ['Branding', 'Brand text + theme + logo — (Optional)'],
          ['Contact', 'Lead-notification email — (Optional)'],
          ['Email (SMTP)', 'Outbound email with a live test — (Optional)'],
          ['Security', 'A memorable hidden admin URL — (Optional)'],
        ].map(([label, hint]) => (
          <li key={label} className="flex items-start gap-3">
            <span className="mt-1 inline-flex h-1.5 w-1.5 rounded-full bg-copper-500" />
            <span>
              <span className="font-medium">{label}</span>{' '}
              <span className="text-warm-stone">— {hint}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-warm-stone">3-5 minutes.</p>
      <div className="mt-8 flex justify-end">
        <Button type="button" onClick={onNext}>
          Get started <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </>
  )
}

// ─── Step 2: Admin account ────────────────────────────────────────

function AdminStep({ onNext, onBack }: { onNext: () => void; onBack?: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Distinct state from `error` — when the database already has an
  // admin, "refresh to go to login" is the wrong message (the operator
  // was clearly trying to install, not log in). We render a richer
  // info panel below instead of a single-line error.
  const [alreadyInstalled, setAlreadyInstalled] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    if (password.length < 12) {
      setError('Use at least 12 characters for your password.')
      return
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match. Try again.")
      return
    }
    setSubmitting(true)
    try {
      const r = await installFetch('/api/install/admin-create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name, password }),
      })
      if (r.status === 410) {
        setAlreadyInstalled(true)
        return
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? "Couldn't create the account. Try again.")
        return
      }
      onNext()
    } finally {
      setSubmitting(false)
    }
  }

  if (alreadyInstalled) {
    return (
      <div>
        {/* No `onBack` on this branch — the panel is terminal for
            THIS database. Going back to Welcome → Continue would
            just bounce the operator straight back here, which is
            confusing. The operator's real next moves live in the
            actionable list below (sign in, reset DB, contact ops). */}
        <StepHeader
          kicker="Already set up"
          title="This database already has an admin."
          lede="An admin account was created for this install earlier. CaveCMS allows one wizard-created admin per database — fresh installs need their own database."
        />
        <div className="mt-8 rounded-2xl border border-copper-500/20 bg-copper-500/5 p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-warm-stone">
            What you can do
          </p>
          <ul className="mt-4 space-y-4 text-sm leading-relaxed text-near-black">
            <li className="flex items-start gap-3">
              <span className="mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-copper-500" />
              <span>
                <strong className="font-semibold">If you remember the credentials,</strong>{' '}
                sign in at the hidden admin URL. The path is the{' '}
                <code className="rounded bg-warm-stone/10 px-1.5 py-0.5 text-xs font-mono">
                  LOGIN_PATH
                </code>{' '}
                value in{' '}
                <code className="rounded bg-warm-stone/10 px-1.5 py-0.5 text-xs font-mono">
                  env.production
                </code>{' '}
                on the server — your installer printed it, or your hosting operator can read it
                for you.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-copper-500" />
              <span>
                <strong className="font-semibold">If you forgot the password,</strong> your
                server admin can reset it from the host with the password-reset script bundled
                in this install.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-copper-500" />
              <span>
                <strong className="font-semibold">If you wanted a fresh install,</strong> this
                database isn&rsquo;t empty &mdash; re-running the installer against the same DB
                hits this guard. <strong className="font-semibold">For a real new site, point
                the installer at a different database name</strong> &mdash; that&rsquo;s the safe
                answer.
                <span className="mt-3 block rounded-lg border border-rose-400/30 bg-rose-500/5 p-3 text-[13px] leading-relaxed text-rose-200">
                  <strong className="font-semibold">Only as a last resort &mdash; on a TEST
                  database you can afford to wipe:</strong> log in to mysql and explicitly select
                  your CaveCMS database before deleting. Names like{' '}
                  <code className="rounded bg-warm-stone/20 px-1 py-0.5 text-[11px] font-mono">
                    users
                  </code>{' '}
                  and{' '}
                  <code className="rounded bg-warm-stone/20 px-1 py-0.5 text-[11px] font-mono">
                    settings
                  </code>{' '}
                  exist in many apps &mdash; running these statements against the wrong database
                  destroys data you can&rsquo;t recover.
                  <span className="mt-2 block overflow-x-auto rounded bg-near-black/40 p-2 font-mono text-[11px] leading-relaxed text-cream-50/85">
                    {`mysql --database=<your_cavecms_db_name> \\
  -u <your_cavecms_db_user> -p \\
  -e "DELETE FROM users; DELETE FROM settings;"`}
                  </span>
                </span>
              </span>
            </li>
          </ul>
        </div>
        <p className="mt-6 text-xs text-warm-stone">
          The wizard is intentionally one-shot per database &mdash; this guard exists so two
          operators hitting the install URL at the same time can&rsquo;t create two competing
          admins.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepHeader
        kicker="Step 1"
        title="Create your admin account"
        lede="This is the account you'll use to sign in to the dashboard."
        onBack={onBack}
        backDisabled={submitting}
      />
      <div className="mt-8 space-y-5">
        <div>
          <FormLabel>Email</FormLabel>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>Your name</FormLabel>
          <input
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>Password (12+ characters)</FormLabel>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>Confirm password</FormLabel>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mt-8 flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating…
            </>
          ) : (
            <>
              Create account <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Step 3: Site identity ────────────────────────────────────────

function SiteStep({
  defaultUrl,
  onNext,
  onBack,
}: {
  defaultUrl: string
  onNext: () => void
  onBack?: () => void
}) {
  const [siteUrl, setSiteUrl] = useState(defaultUrl.replace(/^http:/, 'https:'))
  const [siteName, setSiteName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const r = await installFetch('/api/install/site-init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteUrl: siteUrl.replace(/\/+$/, ''), siteName }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? "Couldn't save site settings. Try again.")
        return
      }
      onNext()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepHeader
        kicker="Step 2"
        title="Your site"
        lede="Used in email links, search-engine sitemaps, and brand emails."
        onBack={onBack}
        backDisabled={submitting}
      />
      <div className="mt-8 space-y-5">
        <div>
          <FormLabel>Site URL</FormLabel>
          <input
            type="url"
            required
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://www.yoursite.com"
            className={inputClass}
          />
          <span className="mt-2 block text-xs text-warm-stone">
            Must start with https. No trailing slash.
          </span>
        </div>
        <div>
          <FormLabel>Site name</FormLabel>
          <input
            type="text"
            required
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="My CaveCMS Site"
            className={inputClass}
          />
        </div>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mt-8 flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              Continue <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Step 4 (NEW): Pick a template (optional) ─────────────────────

function TemplateStep({
  onNext,
  onSkip,
  onBack,
  initialSlug,
}: {
  /** Receives the slug just applied — parent wizard stashes it so a
   *  Back → re-enter cycle restores the same tile selection. */
  onNext: (slug: string) => void
  onSkip: (slug: string) => void
  onBack?: () => void
  /** Pre-selected tile when the operator navigates Back into this
   *  step after a prior selection. Persists across step transitions
   *  via the parent wizard's state — without it the AnimatePresence
   *  unmount/remount would lose the selection. */
  initialSlug?: string | null
}) {
  // Default to 'default-welcome' — the no-op tile. If the operator
  // skips the step entirely or picks this tile, the install ends up
  // identical to the pre-template-chooser default (CaveCMS welcome
  // one-pager, empty nav, empty footer columns). Submitting the
  // default IS the no-regression path.
  // Hydrate from `initialSlug` so revisiting this step via the Back
  // button restores the previously-picked tile. Falls back to
  // 'default-welcome' on first visit so the no-regression default is
  // pre-selected.
  const [selected, setSelected] = useState<string>(initialSlug ?? 'default-welcome')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [alreadyInstalled, setAlreadyInstalled] = useState(false)
  // Re-entrancy guard: React strict-mode double-renders the wizard's
  // step components and an over-eager double-click could fire two
  // applyTemplate POSTs ~16ms apart, both passing the `submitting`
  // check before either commits its state. The /api/install/template
  // endpoint already has a server-side busyToken, but mirroring the
  // pattern here means the UI doesn't even attempt the second call.
  const inFlightRef = useRef(false)

  async function applyTemplate(slug: string): Promise<boolean> {
    if (inFlightRef.current) return false
    inFlightRef.current = true
    setError(null)
    setSubmitting(true)
    try {
      const r = await installFetch('/api/install/template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateSlug: slug }),
      })
      if (r.status === 410) {
        // Install was completed by another tab / a stale-tab race.
        // Show a clear "already finished" message and stop the wizard
        // — operator should sign in via the hidden admin URL.
        setAlreadyInstalled(true)
        return false
      }
      if (r.status === 429) {
        setError('Another wizard tab is already saving — wait a few seconds and try again.')
        return false
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        const code = body?.error
        if (code === 'unknown_template') {
          setError("We couldn't find that template — pick another and try again.")
        } else if (code === 'template_has_no_home_page' || code === 'template_has_multiple_home_pages' || code === 'template_has_no_pages' || code === 'template_page_slug_duplicate' || code === 'template_page_slug_collides_with_preserved') {
          setError("This template is mis-configured — try a different one.")
        } else {
          // Don't render raw server error tokens to the operator.
          setError("Couldn't seed the template. Skip or try again.")
          if (code) {
            console.warn('[install/template] server error:', code)
          }
        }
        return false
      }
      return true
    } finally {
      setSubmitting(false)
      inFlightRef.current = false
    }
  }

  async function handleContinue() {
    if (submitting) return
    const ok = await applyTemplate(selected)
    if (ok) onNext(selected)
  }

  async function handleSkip() {
    if (submitting) return
    // Skip preserves whatever the operator visibly picked. The button
    // copy is "Skip" but the operator's framing on this step is "I'm
    // not going to customise further — use whatever I selected". Until
    // 0.1.37 this unconditionally forced 'default-welcome', which
    // silently wiped the operator's Hotel Solenne / Studio Folio /
    // etc tile pick if they clicked Skip after selecting one (e.g.
    // they came back to this step and tapped Skip thinking it advanced
    // their selection). The seed-the-default contract still holds for
    // the truly-untouched path because `selected` starts at
    // 'default-welcome'.
    const ok = await applyTemplate(selected)
    if (ok) onSkip(selected)
  }

  return (
    <div>
      <StepHeader
        kicker="Step 3 — optional"
        title="Pick a starting template"
        lede="A template seeds your pages, navigation, and footer with a layout that fits your industry. You can edit every block afterwards, or replace pages entirely."
        onBack={onBack}
        backDisabled={submitting}
      />

      <div
        role="radiogroup"
        aria-label="Site template"
        className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {TEMPLATE_CLIENT_META.map((t) => {
          const isSelected = selected === t.slug
          return (
            <button
              key={t.slug}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(t.slug)}
              disabled={submitting}
              className={`group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border bg-cream-50 text-left transition-all focus:outline-none focus:ring-2 focus:ring-copper-500/40 disabled:cursor-not-allowed disabled:opacity-50 ${
                isSelected
                  ? 'border-copper-500 ring-2 ring-copper-500/30 shadow-[0_18px_40px_-22px_rgba(176,116,56,0.55)]'
                  : 'border-warm-stone/30 shadow-[0_4px_16px_-8px_rgba(15,15,15,0.10)] hover:border-copper-300 hover:shadow-[0_8px_24px_-10px_rgba(176,116,56,0.25)]'
              }`}
            >
              {/* Visual mini-preview — palette swatch + tagline rendered IN
                  the template's own colours. Not a real screenshot, but
                  enough to communicate the vibe without dragging real
                  assets into the wizard. The `border-b` is the visual
                  break between the palette-preview top half and the
                  description bottom half — without it, light-themed
                  palettes (cream backgrounds) blend into the also-cream
                  page background AND the cream-50 tile background, so
                  the operator sees a "floating" description with no
                  clear top-section boundary. The hairline border fixes
                  that on every theme. */}
              <div
                className="h-28 border-b border-warm-stone/25 px-4 py-3"
                style={{ background: t.themePalette.bg, color: t.themePalette.fg }}
                aria-hidden="true"
              >
                <p
                  className="text-[9px] font-semibold uppercase tracking-[0.22em]"
                  style={{ color: t.themePalette.accent }}
                >
                  {t.kind}
                </p>
                <p
                  className="mt-2 font-serif text-base font-semibold leading-tight"
                  style={{ color: t.themePalette.fg }}
                >
                  {t.name}
                </p>
                <p
                  className="mt-1 text-[10px] leading-snug"
                  style={{ color: t.themePalette.muted }}
                >
                  {t.tagline}
                </p>
                <div
                  className="mt-3 h-px w-10"
                  style={{ background: t.themePalette.accent }}
                />
              </div>
              <div className="flex flex-1 flex-col bg-cream-50/90 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black">
                  {t.name}
                </p>
                <p className="mt-1 text-[11px] leading-snug text-warm-stone">
                  {t.description}
                </p>
                {isSelected && (
                  <p className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-copper-700">
                    <CheckCircle2 className="h-3 w-3" /> Selected
                  </p>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {alreadyInstalled && (
        <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-4 text-sm text-emerald-900">
          <p className="font-medium">This install is already set up.</p>
          <p className="mt-1 text-emerald-800">
            Sign in at the hidden admin URL the installer printed.
          </p>
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={handleSkip} disabled={submitting || alreadyInstalled}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
        <Button type="button" onClick={handleContinue} disabled={submitting || alreadyInstalled}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Seeding…
            </>
          ) : (
            <>
              Continue <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

// ─── Step 5: Branding (optional) ──────────────────────────────────

function BrandingStep({
  onNext,
  onSkip,
  onBack,
}: {
  onNext: () => void
  onSkip: () => void
  onBack?: () => void
}) {
  const [brandText, setBrandText] = useState('')
  const [theme, setTheme] = useState<'cream' | 'obsidian' | 'ivory'>('cream')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Logo upload state. Lives in this step (not its own step) so the
  // operator sees "Brand your site" as a single decision — text + colour
  // + mark — rather than a wizard that splits the brand into pieces.
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  // Re-entrancy guard for the multipart upload — see TemplateStep's
  // inFlightRef for rationale. Sharp pipelines on a slow CPU can take
  // 10s+; double-clicks on the file picker would otherwise queue two
  // 5MB POSTs which is wasteful even when the server-side busyToken
  // rejects the second one.
  const uploadFlightRef = useRef(false)

  async function handleLogoFile(file: File) {
    if (uploadFlightRef.current) return
    uploadFlightRef.current = true
    setLogoError(null)
    // 5 MB cap matches the server-side check; local rejection saves a
    // round-trip.
    if (file.size > 5 * 1024 * 1024) {
      setLogoError('Logo must be under 5 MB.')
      uploadFlightRef.current = false
      return
    }
    setUploading(true)
    // Hard timeout on the upload: a hung sharp pipeline on the server
    // would otherwise keep the spinner indefinitely. 60s is generous
    // for the heaviest 5MB AVIF; longer than that = something's wrong.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 60_000)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append(
        'alt',
        (brandText || file.name.replace(/\.[^.]+$/, '') || 'Site logo').slice(0, 320),
      )
      let r: Response
      try {
        r = await installFetch('/api/install/logo', {
          method: 'POST',
          body: fd,
          signal: ac.signal,
        })
      } catch (err) {
        if (ac.signal.aborted) {
          setLogoError('Upload took too long. Try a smaller image.')
        } else {
          setLogoError("Couldn't upload the logo. Try again.")
          if (err instanceof Error) console.warn('[install/logo] fetch error:', err.message)
        }
        return
      }
      if (r.status === 410) {
        setLogoError('This install is already set up.')
        return
      }
      if (r.status === 429) {
        setLogoError('Another upload is in progress — wait a few seconds and try again.')
        return
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        const code = body?.error
        if (code === 'mime_rejected' || code === 'mime_format_mismatch' || code === 'mime_unknown') {
          setLogoError('PNG, JPEG, WebP, or AVIF only.')
        } else if (code === 'too_large') {
          setLogoError('Logo must be under 5 MB.')
        } else if (code === 'alt_required') {
          setLogoError('Logo needs descriptive text. Add a brand name first.')
        } else {
          setLogoError("Couldn't upload the logo. Try again.")
          if (code) console.warn('[install/logo] server error:', code)
        }
        return
      }
      const j = (await r.json().catch(() => null)) as {
        variants?: { md?: string }
      } | null
      if (j?.variants?.md) setLogoPreview(j.variants.md)
    } finally {
      clearTimeout(timer)
      setUploading(false)
      uploadFlightRef.current = false
    }
  }

  async function handleRemoveLogo() {
    if (removing) return
    setRemoving(true)
    setLogoError(null)
    // Same timeout discipline as the upload path — a hung backend
    // shouldn't leave the X button spinner stuck. 15s is generous
    // for a settings update + one media UPDATE.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    try {
      try {
        const r = await installFetch('/api/install/logo', {
          method: 'DELETE',
          signal: ac.signal,
        })
        // Even if the DELETE fails (server transient), clear the local
        // preview — the operator pressed X. The wizard's next step
        // will re-confirm settings state; a stale logo binding is
        // recoverable by re-uploading.
        if (!r.ok && r.status !== 410) {
          console.warn('[install/logo DELETE] server status', r.status)
        }
      } catch (err) {
        if (ac.signal.aborted) {
          setLogoError('Remove took too long — try again.')
        } else if (err instanceof Error) {
          console.warn('[install/logo DELETE] fetch error:', err.message)
        }
      }
      setLogoPreview(null)
    } finally {
      clearTimeout(timer)
      setRemoving(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const r = await installFetch('/api/install/branding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brandText, theme }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? "Couldn't save branding. Skip or try again.")
        return
      }
      onNext()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepHeader
        kicker="Step 4 — optional"
        title="Brand your site"
        lede="Shown in the site header. You can refine this anytime under Settings → Branding."
        onBack={onBack}
        backDisabled={submitting || uploading || removing}
      />
      <div className="mt-8 space-y-5">
        <div>
          <FormLabel>Brand text</FormLabel>
          <input
            type="text"
            value={brandText}
            onChange={(e) => setBrandText(e.target.value)}
            placeholder="Acme Co."
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>Header theme</FormLabel>
          <div className="mt-2 grid grid-cols-3 gap-3">
            {(['cream', 'obsidian', 'ivory'] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTheme(t)}
                className={`rounded-xl border px-4 py-3 text-sm font-medium capitalize transition-all ${
                  theme === t
                    ? 'border-copper-500 bg-copper-50 text-copper-800'
                    : 'border-warm-stone/30 bg-white text-near-black hover:border-copper-300'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div>
          <FormLabel>Logo (optional)</FormLabel>
          <div className="mt-2 flex items-start gap-4">
            {logoPreview ? (
              <div className="relative flex h-24 w-24 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-warm-stone/30 bg-cream-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoPreview}
                  alt="Uploaded logo preview"
                  className="max-h-20 max-w-20 object-contain"
                />
                <button
                  type="button"
                  onClick={() => void handleRemoveLogo()}
                  disabled={removing}
                  className="absolute -right-1 -top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-near-black text-cream-50 shadow disabled:opacity-50"
                  aria-label="Remove logo"
                >
                  {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <XIcon className="h-3.5 w-3.5" />}
                </button>
              </div>
            ) : (
              <label
                className={`flex h-24 w-24 flex-shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-warm-stone/40 bg-cream-50/40 text-warm-stone transition-all hover:border-copper-300 hover:text-copper-700 ${
                  uploading ? 'cursor-wait opacity-60' : ''
                }`}
              >
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void handleLogoFile(f)
                    // Reset so re-picking the same file refires onChange
                    e.target.value = ''
                  }}
                  disabled={uploading}
                  className="hidden"
                />
                {uploading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    <Upload className="h-5 w-5" />
                    <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em]">
                      Upload
                    </span>
                  </>
                )}
              </label>
            )}
            <div className="flex-1 text-xs leading-relaxed text-warm-stone">
              <p>PNG, JPEG, WebP, or AVIF. 5 MB max.</p>
              <p className="mt-1">
                {logoPreview
                  ? 'Logo uploaded. It will replace the brand text in the site header.'
                  : 'Once uploaded, the logo replaces the brand text in the header. Skip if you only want a wordmark for now.'}
              </p>
            </div>
          </div>
          {logoError && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-800">
              {logoError}
            </p>
          )}
        </div>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onSkip}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
        <Button type="submit" disabled={submitting || !brandText}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              Continue <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Step 5: Contact (optional) ───────────────────────────────────

function ContactStep({
  onNext,
  onSkip,
  onBack,
}: {
  onNext: () => void
  onSkip: () => void
  onBack?: () => void
}) {
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const r = await installFetch('/api/install/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, ...(phone ? { phone } : {}) }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? "Couldn't save contact info. Skip or try again.")
        return
      }
      onNext()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepHeader
        kicker="Step 5 — optional"
        title="Contact info"
        lede="Powers the contact form and lead notifications. You can add address + hours later."
        onBack={onBack}
        backDisabled={submitting}
      />
      <div className="mt-8 space-y-5">
        <div>
          <FormLabel>Contact email</FormLabel>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="hello@yoursite.com"
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>Phone (optional)</FormLabel>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 123 4567"
            className={inputClass}
          />
        </div>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onSkip}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
        <Button type="submit" disabled={submitting || !email}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              Continue <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Step 6: SMTP (optional, with test send) ──────────────────────

function SmtpStep({
  onNext,
  onSkip,
  onBack,
}: {
  onNext: () => void
  onSkip: () => void
  onBack?: () => void
}) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [secure, setSecure] = useState(false)
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [fromAddress, setFromAddress] = useState('')
  const [fromName, setFromName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState<'ok' | 'failed' | null>(null)

  function payload(testOnly: boolean) {
    return {
      host,
      port: Number(port),
      secure,
      user,
      password,
      fromAddress,
      fromName: fromName || undefined,
      testOnly,
    }
  }

  async function handleTest() {
    if (testing) return
    setError(null)
    setTesting(true)
    setTested(null)
    try {
      const r = await installFetch('/api/install/smtp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload(true)),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: string; reason?: string }
          | null
        setError(body?.reason ?? body?.error ?? "Couldn't verify the SMTP credentials.")
        setTested('failed')
        return
      }
      setTested('ok')
    } finally {
      setTesting(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const r = await installFetch('/api/install/smtp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload(false)),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: string; reason?: string }
          | null
        setError(body?.reason ?? body?.error ?? "Couldn't save the SMTP settings.")
        return
      }
      onNext()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepHeader
        kicker="Step 6 — optional"
        title="Outbound email (SMTP)"
        lede="Powers password reset, lead notifications, and update alerts. Test before saving."
        onBack={onBack}
        backDisabled={submitting}
      />
      <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormLabel>SMTP host</FormLabel>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>Port</FormLabel>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 pb-3 text-sm text-near-black">
            <input
              type="checkbox"
              checked={secure}
              onChange={(e) => setSecure(e.target.checked)}
              className="h-4 w-4 rounded border-warm-stone/40 text-copper-600"
            />
            Use implicit TLS (port 465)
          </label>
        </div>
        <div>
          <FormLabel>Username</FormLabel>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>Password</FormLabel>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>From address</FormLabel>
          <input
            type="email"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="noreply@yoursite.com"
            className={inputClass}
          />
        </div>
        <div>
          <FormLabel>From name (optional)</FormLabel>
          <input
            type="text"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="Your Site"
            className={inputClass}
          />
        </div>
      </div>
      {tested === 'ok' && (
        <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-800">
          ✓ SMTP credentials verified.
        </p>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onSkip}>
          <SkipForward className="h-4 w-4" /> Skip
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={testing || !host || !user || !password || !fromAddress}
          onClick={handleTest}
        >
          {testing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Testing…
            </>
          ) : (
            'Test connection'
          )}
        </Button>
        <Button
          type="submit"
          disabled={submitting || !host || !user || !password || !fromAddress}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              Save + continue <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Step 7: Security baseline (optional) ─────────────────────────

function SecurityStep({
  onNext,
  onSkip,
  onBack,
}: {
  onNext: (loginPath: string | null) => void
  onSkip: () => void
  onBack?: () => void
}) {
  const [loginPath, setLoginPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    if (!/^[a-z0-9-]{6,32}$/.test(loginPath)) {
      setError('Use 6-32 lowercase letters, digits, or dashes.')
      return
    }
    setSubmitting(true)
    try {
      const r = await installFetch('/api/install/security-baseline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loginPath }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? "Couldn't save the login path. Skip or try again.")
        return
      }
      const data = (await r.json().catch(() => null)) as { loginPath?: string } | null
      onNext(data?.loginPath ?? loginPath)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <StepHeader
        kicker="Step 7 — optional"
        title="Pick a memorable login URL"
        lede="The installer generated a random one — replacing it with something you'll remember is fine. Keep it secret."
        onBack={onBack}
        backDisabled={submitting}
      />
      <div className="mt-8 space-y-5">
        <div>
          <FormLabel>Hidden admin URL segment</FormLabel>
          <div className="mt-2 flex items-center gap-2">
            <span className="rounded-lg bg-warm-stone/10 px-3 py-3 text-sm text-warm-stone">
              /
            </span>
            <input
              type="text"
              value={loginPath}
              onChange={(e) => setLoginPath(e.target.value.toLowerCase())}
              placeholder="my-cave"
              className={inputClass}
            />
          </div>
          <span className="mt-2 block text-xs text-warm-stone">
            6-32 lowercase letters / digits / dashes. Visit it directly to sign
            in. Treat it as a second password — don&rsquo;t put it in URLs you
            share.
          </span>
        </div>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onSkip}>
          <SkipForward className="h-4 w-4" /> Skip (keep the generated one)
        </Button>
        <Button type="submit" disabled={submitting || !loginPath}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              Continue <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Step 8: Done (calls /complete to flip the gate) ──────────────

function DoneStep({ loginPath }: { loginPath: string | null }) {
  const [completing, setCompleting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // `completedAt` is captured for future use (timestamp on the
  // success screen, telemetry on first-login analytics). Setter only
  // for now — read-side wiring lives in a follow-up. Prefixed with
  // _ so the no-unused-vars rule passes.
  const [, setCompletedAt] = useState<string | null>(null)
  const firedRef = useRef(false)

  // Completion runs once on mount via useEffect — NOT inside the render
  // body. React Strict Mode + concurrent rendering would otherwise
  // double-fire the POST. The firedRef + AbortController together
  // guarantee at-most-once + clean cancellation on unmount.
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    const ac = new AbortController()
    void (async () => {
      try {
        const r = await installFetch('/api/install/complete', {
          method: 'POST',
          signal: ac.signal,
        })
        if (r.ok || r.status === 410) {
          // Both "we just flipped it" (200) and "someone else flipped
          // it already" (410) are success outcomes from the wizard's
          // perspective — install is complete.
          if (r.ok) {
            const j = (await r.json().catch(() => null)) as { completedAt?: string } | null
            setCompletedAt(j?.completedAt ?? new Date().toISOString())
          } else {
            setCompletedAt(new Date().toISOString())
          }
          // Install is done — drop the bootstrap token from
          // sessionStorage so a browser-back or tab-revisit doesn't
          // try to re-fire install API calls (which would 410 with
          // confusing copy). Also scrubs the secret from persistent
          // storage now that it's served its purpose.
          try {
            window.sessionStorage.removeItem('cavecms.installBootstrapToken')
          } catch {
            /* best-effort */
          }
          setInstallToken(null)
        } else {
          setError('Almost done — couldn\'t flip the install-complete flag. You can still log in.')
        }
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          setError('Almost done — couldn\'t flip the install-complete flag. You can still log in.')
        }
      } finally {
        setCompleting(false)
      }
    })()
    return () => ac.abort()
  }, [])

  return (
    <>
      <div className="flex justify-center">
        <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 ring-2 ring-emerald-500/30">
          {completing ? (
            <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
          ) : (
            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
          )}
        </span>
      </div>
      <h1 className="mt-6 text-center font-serif text-3xl font-bold tracking-tight text-near-black sm:text-4xl">
        You&rsquo;re all set
      </h1>
      <p className="mt-3 text-center text-sm leading-relaxed text-warm-stone">
        Your CaveCMS site is ready to use. Sign in to the dashboard to start
        publishing.
      </p>
      {loginPath && (
        <div className="mt-6 rounded-xl border border-copper-300 bg-copper-50/60 px-4 py-4 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-700">
            Your hidden admin URL
          </p>
          <p className="mt-2 font-mono text-sm text-near-black">
            /{loginPath}
          </p>
          <p className="mt-1 text-xs text-warm-stone">
            Write this down — it&rsquo;s the only place we&rsquo;ll show it.
          </p>
        </div>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="mt-10 flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="inline-flex items-center gap-2 rounded-full bg-near-black px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-cream-50 transition-all hover:bg-copper-700 hover:-translate-y-px"
        >
          Visit your site
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <p className="text-xs text-warm-stone">
          Sign in at the hidden admin URL above (or the random one printed by
          the installer if you skipped step 6).
        </p>
      </div>
    </>
  )
}
