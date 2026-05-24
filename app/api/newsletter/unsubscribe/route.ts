import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import {
  NEWSLETTER_TOKEN_RE,
  newNewsletterToken,
} from '@/lib/auth/newsletterToken'

// POST /api/newsletter/unsubscribe. Marks the matching subscriber
// as unsubscribed AND rotates the token so a forwarded confirmation
// or subscribe link can't reactivate a row the user just opted out
// of. Idempotent — repeated unsubscribes for the same token after
// rotation simply update zero rows.
//
// Higher per-IP rate-limit than lead routes because legitimate email
// list managers may click many unsub links from the same office IP.
// 60/min is generous; the action is harmless to legitimate users
// (the row simply stays unsubscribed).

const limit = rateLimit('unsub', { limit: 60, windowSec: 60 })

function htmlResponse(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1a1a1a">${body}</body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        // Defense-in-depth CSP for inline server-generated HTML —
        // see app/api/newsletter/confirm/route.ts for rationale.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
      },
    },
  )
}

export const POST = withError(async (req: Request) => {
  const headerObj: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) {
    return htmlResponse(
      '<h1>Too many requests</h1><p>Please try again in a moment.</p>',
      429,
    )
  }
  // Body-size pre-cap — token is short; 16KB ceiling stops a multipart
  // memory-pressure attack before req.formData() buffers the whole body.
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > 16 * 1024) {
    return htmlResponse(
      '<h1>Unsubscribe</h1><p>Bad request.</p>',
      413,
    )
  }
  const form = await req.formData()
  const token = String(form.get('token') ?? '')
  if (!NEWSLETTER_TOKEN_RE.test(token)) {
    return htmlResponse(
      '<h1>Unsubscribe</h1><p>This link is invalid or has expired.</p>',
    )
  }
  // Rotate to a fresh token so the old link (now visible in the
  // user's inbox indefinitely) can't be re-clicked to reactivate
  // a subscription after a future re-subscribe flow. The new
  // token is intentionally not surfaced anywhere — its only
  // purpose is to invalidate the prior one.
  const rotated = newNewsletterToken()
  await db.execute(sql`
    UPDATE newsletter_subscribers
    SET status = 'unsubscribed',
        unsubscribe_token = ${rotated}
    WHERE unsubscribe_token = ${token}
  `)
  return htmlResponse(
    '<h1>Unsubscribed</h1><p>You will no longer receive updates from Best World Properties.</p>',
  )
})
