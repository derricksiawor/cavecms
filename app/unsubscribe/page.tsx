import { NEWSLETTER_TOKEN_RE } from '@/lib/auth/newsletterToken'

// One-click unsubscribe confirmation page. Per CAN-SPAM and Google's
// 2024 sender requirements, the unsubscribe link MUST land on a page
// that completes the request — but a GET that flips state opens a
// classic "preview pane" risk where Gmail/Outlook's link preview
// fetcher would auto-unsubscribe everyone the day a newsletter ships.
//
// Compromise: the GET renders a confirmation page with a POST form;
// one click completes the unsubscribe. The visible button works
// without JS. Robots are explicitly told not to index.

export const dynamic = 'force-dynamic'

export const metadata = {
  // Confirmation page must never be indexed — the URL carries a
  // single-use token that should not appear in search.
  robots: { index: false, follow: false },
  title: 'Unsubscribe — Best World Properties',
}

type SearchParams = Promise<{ token?: string }>

export default async function Unsubscribe({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const sp = await searchParams
  const token = sp.token ?? ''
  // Render an explicit error page on a malformed/truncated token
  // (e.g. email-client URL wrap at column 76). Previously this
  // path silently redirected to the homepage — confusing UX for
  // the visitor who clicked a legitimate-looking unsubscribe link.
  if (!NEWSLETTER_TOKEN_RE.test(token)) {
    return (
      <main className="py-12 max-w-md mx-auto px-4">
        <h1 className="text-2xl font-semibold tracking-tight mb-4">
          Unsubscribe link looks broken
        </h1>
        <p className="text-warm-stone">
          The link may have been truncated by your email client. Try
          copying the full URL from the source view of the email, or
          reply to the original message to be removed manually.
        </p>
      </main>
    )
  }

  return (
    <main className="py-12 max-w-md mx-auto px-4">
      <h1 className="text-2xl font-semibold tracking-tight mb-4">
        Confirm unsubscribe
      </h1>
      <p className="mb-6 text-warm-stone">
        Click the button below to stop receiving updates from Best World
        Properties.
      </p>
      <form method="post" action="/api/newsletter/unsubscribe">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="bg-copper-700 text-cream-50 px-6 py-2 rounded-full font-medium hover:bg-copper-800 transition"
        >
          Unsubscribe
        </button>
      </form>
    </main>
  )
}
