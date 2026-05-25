'use client'
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, ArrowRight, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Wordmark } from '@/components/Wordmark'

// Single-page multi-step install wizard. Modelled on WordPress's
// install.php flow but adapted for CaveCMS:
//
//   1. Welcome — operator confirms they want to set up
//   2. Admin account — create the first admin user (the LAST
//      checkpoint; once this lands, /install is locked by middleware)
//   3. Site identity — site URL + name → seeds settings.site_general
//   4. Email (optional) — SMTP setup; skippable
//   5. Done — log-in CTA
//
// DB connection is NOT a step here because:
//   - Operators deploy with a working DATABASE_URL in their env (the
//     install.sh script writes it). Without a DB the migrations
//     would have failed before this page even loaded.
//   - WordPress shows a DB form because PHP shared hosting routinely
//     leaves wp-config.php absent. CaveCMS deploys via tarball +
//     install.sh which guarantees the env is configured.
//
// All endpoints under /api/install/* refuse to run once an admin
// exists — defence-in-depth in case middleware ever lets a
// post-install /install request through.

const STEPS = ['welcome', 'admin', 'site', 'email', 'done'] as const
type Step = (typeof STEPS)[number]

const STEP_LABELS: Record<Step, string> = {
  welcome: 'Welcome',
  admin: 'Admin account',
  site: 'Your site',
  email: 'Email',
  done: 'Ready',
}

export function InstallWizard({ guessedSiteUrl }: { guessedSiteUrl: string }) {
  const [step, setStep] = useState<Step>('welcome')

  return (
    <main className="min-h-screen bg-cream py-12 px-4">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-center pb-8">
          <Wordmark label="CaveCMS" />
        </div>

        {/* Step indicator */}
        <ol className="mb-10 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => {
            const isCurrent = s === step
            const stepIdx = STEPS.indexOf(step)
            const isDone = i < stepIdx
            return (
              <li
                key={s}
                className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em]"
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
                  {isDone ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={`hidden sm:inline ${
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
                  <span aria-hidden="true" className="h-px w-6 bg-warm-stone/30" />
                )}
              </li>
            )
          })}
        </ol>

        <article className="overflow-hidden rounded-3xl border border-warm-stone/20 bg-cream-50/80 p-8 shadow-[0_30px_80px_-30px_rgba(15,15,15,0.15)] backdrop-blur-sm sm:p-12">
          <AnimatePresence mode="wait">
            {step === 'welcome' && (
              <motion.div
                key="welcome"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <WelcomeStep onNext={() => setStep('admin')} />
              </motion.div>
            )}
            {step === 'admin' && (
              <motion.div
                key="admin"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <AdminStep onNext={() => setStep('site')} />
              </motion.div>
            )}
            {step === 'site' && (
              <motion.div
                key="site"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <SiteStep
                  defaultUrl={guessedSiteUrl}
                  onNext={() => setStep('email')}
                />
              </motion.div>
            )}
            {step === 'email' && (
              <motion.div
                key="email"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <EmailStep onNext={() => setStep('done')} />
              </motion.div>
            )}
            {step === 'done' && (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <DoneStep />
              </motion.div>
            )}
          </AnimatePresence>
        </article>
      </div>
    </main>
  )
}

// ─── Step 1: Welcome ──────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Welcome
      </p>
      <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-near-black sm:text-4xl">
        Let&rsquo;s set up your CaveCMS
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-warm-stone">
        We&rsquo;ll walk through a few quick steps to get your site up and
        running:
      </p>
      <ul className="mt-6 space-y-3 text-sm text-near-black">
        <li className="flex items-start gap-3">
          <span className="mt-1 inline-flex h-1.5 w-1.5 rounded-full bg-copper-500" />
          Create your administrator account
        </li>
        <li className="flex items-start gap-3">
          <span className="mt-1 inline-flex h-1.5 w-1.5 rounded-full bg-copper-500" />
          Tell us your site&rsquo;s public web address and name
        </li>
        <li className="flex items-start gap-3">
          <span className="mt-1 inline-flex h-1.5 w-1.5 rounded-full bg-copper-500" />
          Connect outbound email so we can send password resets and
          notifications (optional — skip if you want)
        </li>
      </ul>
      <p className="mt-6 text-sm text-warm-stone">
        Takes about 3 minutes.
      </p>
      <div className="mt-8 flex justify-end">
        <Button type="button" onClick={onNext}>
          Get started <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </>
  )
}

// ─── Step 2: Admin account ────────────────────────────────────────

function AdminStep({ onNext }: { onNext: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      const r = await fetch('/api/install/admin-create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name, password }),
      })
      if (r.status === 410) {
        setError('This install is already set up. Refresh to go to login.')
        return
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: string }
          | null
        setError(body?.error ?? "Couldn't create the account. Try again.")
        return
      }
      onNext()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Step 1
      </p>
      <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-near-black">
        Create your admin account
      </h1>
      <p className="mt-3 text-sm text-warm-stone">
        This is the account you&rsquo;ll use to sign into the dashboard.
      </p>

      <div className="mt-8 space-y-5">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700">
            Email
          </span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-2 block w-full rounded-xl border border-warm-stone/30 bg-white px-4 py-3 text-base text-near-black focus:border-copper-500 focus:outline-none focus:ring-2 focus:ring-copper-500/20"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700">
            Your name
          </span>
          <input
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-2 block w-full rounded-xl border border-warm-stone/30 bg-white px-4 py-3 text-base text-near-black focus:border-copper-500 focus:outline-none focus:ring-2 focus:ring-copper-500/20"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700">
            Password (12+ characters)
          </span>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2 block w-full rounded-xl border border-warm-stone/30 bg-white px-4 py-3 text-base text-near-black focus:border-copper-500 focus:outline-none focus:ring-2 focus:ring-copper-500/20"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700">
            Confirm password
          </span>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-2 block w-full rounded-xl border border-warm-stone/30 bg-white px-4 py-3 text-base text-near-black focus:border-copper-500 focus:outline-none focus:ring-2 focus:ring-copper-500/20"
          />
        </label>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      )}

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
}: {
  defaultUrl: string
  onNext: () => void
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
      const r = await fetch('/api/install/site-init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteUrl: siteUrl.replace(/\/+$/, ''), siteName }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { error?: string }
          | null
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
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Step 2
      </p>
      <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-near-black">
        Your site
      </h1>
      <p className="mt-3 text-sm text-warm-stone">
        Used in email links, search-engine sitemaps, and brand emails.
      </p>

      <div className="mt-8 space-y-5">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700">
            Site URL
          </span>
          <input
            type="url"
            required
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://www.yoursite.com"
            className="mt-2 block w-full rounded-xl border border-warm-stone/30 bg-white px-4 py-3 text-base text-near-black focus:border-copper-500 focus:outline-none focus:ring-2 focus:ring-copper-500/20"
          />
          <span className="mt-2 block text-xs text-warm-stone">
            Must start with https. No trailing slash.
          </span>
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-700">
            Site name
          </span>
          <input
            type="text"
            required
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="My CaveCMS Site"
            className="mt-2 block w-full rounded-xl border border-warm-stone/30 bg-white px-4 py-3 text-base text-near-black focus:border-copper-500 focus:outline-none focus:ring-2 focus:ring-copper-500/20"
          />
        </label>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      )}

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

// ─── Step 4: Email (optional, skippable) ──────────────────────────

function EmailStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Step 3
      </p>
      <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-near-black">
        Email — optional for now
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-warm-stone">
        Outbound email powers password reset, lead notifications, and update
        alerts. You can set this up now or skip and configure it later from{' '}
        <strong className="font-semibold">Settings → Email</strong>.
      </p>

      <div className="mt-8 rounded-xl border border-warm-stone/20 bg-cream-50/40 p-4">
        <p className="text-sm font-medium text-near-black">
          Most operators paste credentials from a transactional email provider
          (SendGrid, Mailgun, AWS SES, Postmark, etc.) — those work
          out-of-the-box.
        </p>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onNext}>
          Skip for now
        </Button>
        <Button type="button" onClick={onNext}>
          Continue <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </>
  )
}

// ─── Step 5: Done ─────────────────────────────────────────────────

function DoneStep() {
  return (
    <>
      <div className="flex justify-center">
        <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 ring-2 ring-emerald-500/30">
          <CheckCircle2 className="h-8 w-8 text-emerald-600" />
        </span>
      </div>
      <h1 className="mt-6 text-center font-serif text-3xl font-bold tracking-tight text-near-black sm:text-4xl">
        You&rsquo;re all set
      </h1>
      <p className="mt-3 text-center text-sm leading-relaxed text-warm-stone">
        Your CaveCMS site is ready to use. Sign in to the dashboard to start
        publishing.
      </p>
      <div className="mt-10 flex flex-col items-center gap-3">
        {/* Land on the homepage. The admin login URL is the operator's
            obscured `LOGIN_PATH` (e.g. `/baccess`) — we do NOT publish
            it in the wizard's HTML (hidden-admin policy). The operator
            typed the path during deploy and remembers it.
            Hard <a> nav into the public layout group. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="inline-flex items-center gap-2 rounded-full bg-near-black px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-cream-50 transition-all hover:bg-copper-700 hover:-translate-y-px"
        >
          Visit your site
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <p className="text-xs text-warm-stone">
          Sign in at the secret admin URL you set during install.
        </p>
      </div>
    </>
  )
}
