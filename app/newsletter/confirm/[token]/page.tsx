import { NEWSLETTER_TOKEN_RE } from '@/lib/auth/newsletterToken'

// Newsletter confirmation page. The signup route emails a link to
// `/newsletter/confirm/<token>`; this page renders a tiny confirm
// form that POSTs to /api/newsletter/confirm with the token. The
// POST handler is the only path that mutates state — keeping GET
// here as a pure render prevents Gmail / Outlook / corporate
// SafeLinks prefetchers from auto-clicking the confirmation link
// for the recipient and silently subscribing them.
//
// Idempotency: clicking the button a second time POSTs the same
// token; the API's status guard returns 0-rows-updated and renders
// the same "already confirmed" page.

export const dynamic = 'force-dynamic'

export const metadata = {
  // Confirmation pages must never be indexed — the URL carries a
  // single-purpose token that should not appear in search.
  robots: { index: false, follow: false },
  title: 'Confirm subscription — CaveCMS',
}

type Params = Promise<{ token: string }>

export default async function ConfirmSubscription({
  params,
}: {
  params: Params
}) {
  const { token } = await params
  if (!NEWSLETTER_TOKEN_RE.test(token)) {
    // Email clients sometimes truncate long URLs at column 76
    // (format=flowed). Show an actionable error page rather than
    // a silent redirect — mirrors the /unsubscribe page so a
    // visitor whose link arrived broken sees the same recovery
    // path on both flows.
    return (
      <main className="py-12 max-w-md mx-auto px-4">
        <h1 className="text-2xl font-semibold tracking-tight mb-4">
          Confirmation link looks broken
        </h1>
        <p className="text-warm-stone">
          The link may have been truncated by your email client. Try
          copying the full URL from the source view of the message,
          or sign up again from the footer of any page.
        </p>
      </main>
    )
  }

  return (
    <main className="py-12 max-w-md mx-auto px-4">
      <h1 className="text-2xl font-semibold tracking-tight mb-4">
        Confirm your subscription
      </h1>
      <p className="mb-6 text-warm-stone">
        Click the button below to finish subscribing to updates from this site.
      </p>
      <form method="post" action="/api/newsletter/confirm">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="bg-copper-700 text-cream-50 px-6 py-2 rounded-full font-medium hover:bg-copper-800 transition"
        >
          Confirm subscription
        </button>
      </form>
    </main>
  )
}
