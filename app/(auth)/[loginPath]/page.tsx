import { notFound } from 'next/navigation'
import { timingSafeEqual } from 'node:crypto'
import { issuePreCsrf } from '@/lib/auth/preCsrf'
import { getResolvedLoginPath } from '@/lib/security/getResolvedLoginPath'
import { getRecaptchaServerConfig } from '@/lib/security/recaptcha'
import { LoginForm } from './LoginForm'

export const dynamic = 'force-dynamic'

export function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

export default async function LoginPage({
  params,
}: {
  params: Promise<{ loginPath: string }>
}) {
  const { loginPath } = await params
  // DB-resolved (with env fallback). Timing-safe compare so a
  // mismatch returns notFound() without leaking which char differed
  // through response-time variance. Lengths are upper-bounded by the
  // Zod regex (6..32 chars) — Buffer.alloc on user input wouldn't
  // amplify the timing channel.
  const resolved = await getResolvedLoginPath()
  const a = Buffer.from(loginPath)
  const b = Buffer.from(resolved)
  if (a.length !== b.length || !timingSafeEqual(a, b)) notFound()

  // Pre-auth CSRF nonce: single-use, embedded in form, consumed by
  // /api/auth/login. The preCsrf store is bounded (50k FIFO, 15-min
  // TTL).
  const preNonce = issuePreCsrf()

  // reCAPTCHA config for the LOGIN scope. Returns null when
  // enabledOnLogin=false OR (untouched DB + no env keys). Login form
  // branches v2-widget vs v3-execute on `version`.
  const cfg = await getRecaptchaServerConfig('login')

  return (
    <LoginForm
      csrf={preNonce}
      action="/api/auth/login"
      recaptchaSiteKey={cfg?.siteKey ?? ''}
      recaptchaVersion={cfg?.version ?? 'v3'}
    />
  )
}
