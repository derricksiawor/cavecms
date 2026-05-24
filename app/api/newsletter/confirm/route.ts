import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { NEWSLETTER_TOKEN_RE } from '@/lib/auth/newsletterToken'

// POST /api/newsletter/confirm — completes the double-opt-in.
//
// Method matters: GET-on-token-in-path was previously here, but
// email-client link prefetchers (Gmail, Outlook SafeLinks, Slack
// unfurl) auto-fetch any GET URL in an inbound message — auto-
// confirming a subscription that the recipient never clicked. The
// POST gate forces the recipient to interact with the rendered
// page at /newsletter/confirm/[token].
//
// Rate-limited per IP to cap CPU spend on no-match UPDATE probes.

const limit = rateLimit('newsletter_confirm', { limit: 60, windowSec: 60 })

function htmlResponse(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1a1a1a">${body}</body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Confirmation results must never be indexed — the URL
        // carries a single-purpose token that should not appear
        // in search.
        'x-robots-tag': 'noindex, nofollow',
        // Defense-in-depth CSP: the body is server-generated with
        // no interpolated user data today, but a future maintainer
        // could naïvely append a token / message and create a
        // reflected XSS. Lock the response down to a static-text
        // surface — inline style (we set one on <body>) is the
        // only thing this body relies on.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
      },
    },
  )
}

interface UpdateResult {
  affectedRows: number
}

export const POST = withError(async (req: Request) => {
  const headerObj: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) {
    return htmlResponse(
      '<h1>Subscription</h1><p>Please try again in a moment.</p>',
      429,
    )
  }
  // Body-size pre-cap — token is at most ~60 chars; 16KB ceiling
  // prevents memory-pressure DoS where an attacker streams an oversized
  // multipart body before the route can reject it. The rate limiter
  // (60/min/IP) caps frequency; this caps the per-attempt cost.
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > 16 * 1024) {
    return htmlResponse(
      '<h1>Subscription</h1><p>Bad request.</p>',
      413,
    )
  }
  const form = await req.formData()
  const token = String(form.get('token') ?? '')
  if (!NEWSLETTER_TOKEN_RE.test(token)) {
    return htmlResponse(
      '<h1>Subscription</h1><p>This link is invalid or has expired.</p>',
    )
  }
  // Promotes pending_confirmation → active. The WHERE clause's
  // status guard makes this a no-op on already-active rows and on
  // unsubscribed rows (the unsubscribe POST rotates the token, so
  // a stale confirm link can't reactivate someone who explicitly
  // unsubscribed).
  const [res] = (await db.execute(sql`
    UPDATE newsletter_subscribers
    SET status = 'active'
    WHERE unsubscribe_token = ${token}
      AND status = 'pending_confirmation'
  `)) as unknown as [UpdateResult]
  if (res.affectedRows === 0) {
    // Either already-active (idempotent re-click) or token rotated
    // by an intervening unsubscribe. Both render the same friendly
    // page so a bot can't probe state from the response shape.
    return htmlResponse(
      '<h1>Subscription</h1><p>This link is no longer active. ' +
        'If you meant to subscribe, request a fresh confirmation ' +
        'from the footer of any page.</p>',
    )
  }
  return htmlResponse(
    "<h1>Subscription confirmed</h1><p>Thanks — you'll now receive updates from Best World Properties.</p>",
  )
})
