import 'server-only'

// HTML-escape a string for safe inclusion in an email template's
// inner text. Mirrors lib/seo/escape.ts's safeJsonForScript intent
// — every untrusted value going into a constructed HTML body MUST
// pass through here before concatenation.
//
// The five-character set { & < > " ' } covers the OWASP-recommended
// minimum for HTML body and double-quoted attribute contexts. Email
// clients vary wildly in their HTML parsers; staying conservative
// here means we never depend on a specific MUA's tolerance.
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c)
}

// Strips C0 control chars (U+0000-U+001F) + DEL (U+007F) — the
// SMTP-fatal trio (CR, LF, NUL) lives in that range and would turn a
// header value into an injection vector ("New contact: Joe<CRLF>Bcc:
// attacker@..." smuggles a Bcc into the outgoing envelope). Modern
// nodemailer Q-encodes non-ASCII subjects, but bare ASCII CRLF
// behaviour is version-dependent; stripping at the template boundary
// keeps the invariant local + deterministic. Apply to ANY user-supplied
// fragment that lands in a Subject template literal (lead name, project
// name, etc).
//
// Built via the RegExp constructor with explicit string-form escapes —
// embedding literal NUL/CR/LF inside a regex character class in source
// is fragile (editors, patch tools, and diff parsers mangle them).
const SUBJECT_CONTROL_RE = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g')
export function safeSubjectFragment(s: string): string {
  return s.replace(SUBJECT_CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
}

// Standard email body wrapper. Inline-styles every element because
// every major MUA (Gmail, Outlook, Apple Mail) strips <style> tags
// or sandboxes them aggressively. `footerText` lands inside a
// styled <p> and IS HTML-escaped — callers can pass operator-derived
// brand or tenant names safely. `footerHtml` is rendered RAW after
// the wrapped footer text, so callers that need to include block-
// level HTML (e.g. the newsletter's "Unsubscribe" link in its own
// paragraph) can do so without producing nested <p>…<p>…</p>…</p>
// markup that some MUAs render unpredictably. ANY footerHtml caller
// MUST escape its own dynamic fragments before passing them in.
export function wrap(
  body: string,
  footerText = 'CaveCMS',
  footerHtml = '',
): string {
  return (
    '<!doctype html>' +
    '<html><body style="font-family:system-ui,Helvetica,Arial,sans-serif;line-height:1.5;color:#1a1a1a">' +
    body +
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">' +
    `<p style="font-size:12px;color:#888">${escapeHtml(footerText)}</p>` +
    footerHtml +
    '</body></html>'
  )
}
