// HTML-escape primitive. Used by every code path that interpolates
// operator- or visitor-controlled text into a server-rendered HTML
// response body (maintenance page, newsletter confirm/unsubscribe
// pages, error pages, etc.).
//
// Single source of truth so a future maintainer can't accidentally
// build a half-escaped variant — the previous implementation lived
// inside middleware.ts as a private function, and the newsletter
// routes (which return their own HTML bodies) had no escape applied
// at all. Today's call sites only interpolate static strings; this
// hoist makes the helper available so the next maintainer who adds a
// dynamic interpolation lands on the right primitive.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
