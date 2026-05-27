'use client'

import { useEffect, useState } from 'react'

// Renders an email as a client-only `<a href="mailto:…">` so Cloudflare's
// Email Address Obfuscation (Scrape Shield) can't see the `mailto:` href
// or the plain-text email in the SSR HTML. Two problems EAO causes when
// it CAN see them:
//   1. CF rewrites our `<a>` text to `[email protected]` and injects
//      `/cdn-cgi/scripts/email-decode.min.js` to decode it on the client.
//      The injected script carries no nonce → our `strict-dynamic` CSP
//      blocks it → users see `[email protected]` gibberish.
//   2. The rewritten SSR HTML disagrees with what React's hydration would
//      render (the un-rewritten email) → React error #418 hydration text
//      mismatch fires on every page that renders contact emails.
//
// Strategy: SSR renders an empty span (CF sees no email pattern, doesn't
// rewrite, doesn't inject). After hydration, useEffect flips `mounted`
// and the real anchor renders on the client where CF can't reach it.
// `useState(false)` is the same initial value on server + client, so
// hydration never sees a mismatch on this subtree.
//
// Tradeoff: no-JS visitors see the empty placeholder instead of the
// email. CF's own EAO behaves the same way (it replaces the email with
// `[email protected]` and decodes via JS), so we're not worse off than
// the CF-default behavior — and we keep the CSP intact.
export function CfSafeMailto({
  email,
  className,
  ariaLabel,
}: {
  email: string
  className?: string
  ariaLabel?: string
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  if (!mounted) {
    return (
      <span
        className={className}
        aria-label={ariaLabel ?? 'Email address'}
      />
    )
  }
  return (
    <a
      href={`mailto:${email}`}
      className={className}
      aria-label={ariaLabel}
    >
      {email}
    </a>
  )
}
