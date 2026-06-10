import { headers } from 'next/headers'
import { isInstalled } from '@/lib/install/installState'
import { isLoopbackUrl } from '@/lib/security/hostKind'
import { InstallWizard } from './InstallWizard'

// Public install wizard (no auth — there's no admin user yet).
//
// Reachable ONLY when the middleware install-gate redirected us here
// (fresh deploy, no admin). Once installed, middleware redirects
// /install → /admin permanently. This page is also defensively
// protected at the server side: if isInstalled() returns true (cache
// stale + race), we render a "Already installed" message instead of
// the wizard.

export const dynamic = 'force-dynamic'

export function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

export default async function InstallPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const alreadyInstalled = await isInstalled()
  // Default Site URL hint. Prefer the real domain the CLI captured at install
  // time (written to env.production as CAVECMS_SITE_URL on public surfaces) —
  // the request host is localhost when the operator reaches /install over an
  // SSH tunnel / localhost forward during cPanel setup, which is exactly how
  // installs ended up persisting siteUrl=https://localhost:PORT. Fall back to
  // the request host (correct for laptop dev + any install reached directly).
  const h = await headers()
  const host = h.get('host') ?? 'localhost:3040'
  const proto = h.get('x-forwarded-proto') ?? 'http'
  const requestGuess = `${proto}://${host}`
  const cliSiteUrl = process.env.CAVECMS_SITE_URL
  const guessedSiteUrl =
    cliSiteUrl && /^https?:\/\/.+/.test(cliSiteUrl) ? cliSiteUrl : requestGuess
  // Surface + loopback flag so the wizard knows NOT to pre-fill localhost on a
  // public install (cpanel/vps/pm2). Laptop keeps the localhost prefill.
  const surface = process.env.CAVECMS_RESTART_MODE ?? 'laptop'
  const guessIsLoopback = isLoopbackUrl(guessedSiteUrl)

  // Bootstrap token — the CLI prints a `/install?t=<token>` URL. The
  // server-rendered wizard receives the token via this query param and
  // hands it to the client component, which includes it in every
  // /api/install/* fetch via the X-Install-Token header. The token
  // gates the public-internet window between app-boot and
  // wizard-complete: without it, the install endpoints return 401.
  const tokenParam = (await searchParams)?.t
  const bootstrapToken = typeof tokenParam === 'string' ? tokenParam : null

  // Mirror the server-side gate in requireInstallToken(): the token is
  // only required when (a) we're in production, or (b) the env var is
  // set to a real-looking value. In contributor dev (`pnpm dev` with no
  // INSTALL_BOOTSTRAP_TOKEN in .env.local) the server falls through,
  // so the wizard must NOT show the "Missing install token" banner —
  // it would just confuse the contributor.
  const envToken = process.env.INSTALL_BOOTSTRAP_TOKEN
  const tokenRequired =
    process.env.NODE_ENV === 'production' ||
    (typeof envToken === 'string' && envToken.length >= 32)

  if (alreadyInstalled) {
    return (
      <main className="mx-auto max-w-xl px-6 py-24 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
          CaveCMS
        </p>
        <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
          Already installed
        </h1>
        <p className="mt-4 text-sm text-warm-stone">
          This CaveCMS install was set up earlier. Sign in to the admin
          dashboard to continue.
        </p>
      </main>
    )
  }

  return (
    <InstallWizard
      guessedSiteUrl={guessedSiteUrl}
      surface={surface}
      guessIsLoopback={guessIsLoopback}
      bootstrapToken={bootstrapToken}
      tokenRequired={tokenRequired}
    />
  )
}
