import 'server-only'
import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '@/lib/env'

// nodemailer transporter singleton. Cached on globalThis so HMR /
// route handler recompiles don't open a fresh SMTP pool on every
// edit. The pool itself reuses connections across sendMail calls
// (pool: true), so the per-request cost is one short keep-alive
// round-trip.
//
// Returns null when SMTP_HOST is unset — the queue runner uses this
// to short-circuit claim attempts in dev so pending_emails rows
// pile up harmlessly instead of generating ECONNREFUSED log spam.

declare global {
  var __bwcMailTransporter: Transporter | null | undefined
}

export function getTransporter(): Transporter | null {
  if (globalThis.__bwcMailTransporter !== undefined) {
    return globalThis.__bwcMailTransporter
  }
  if (!env.SMTP_HOST) {
    globalThis.__bwcMailTransporter = null
    return null
  }
  const port = env.SMTP_PORT
  globalThis.__bwcMailTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 is STARTTLS (requireTLS); 25 falls
    // back to plain (only sane on a trusted internal relay).
    secure: port === 465,
    requireTLS: port === 587,
    // SMTP_USER ⇒ SMTP_PASS is validated at boot (lib/env.ts superRefine),
    // so by the time we hit this branch both are non-empty strings.
    // The `??` fallback that used to live here was removed because an
    // empty-pass AUTH PLAIN against a permissive relay can succeed
    // unexpectedly and against a strict one trips the breaker.
    auth: env.SMTP_USER
      ? { user: env.SMTP_USER, pass: env.SMTP_PASS as string }
      : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  })
  return globalThis.__bwcMailTransporter
}

// CRLF stripping for header-bearing fields (subject, addresses).
// MIME headers terminate on CR/LF; embedding either byte lets an
// attacker inject extra headers (e.g. an additional BCC for
// data exfiltration). The lead routes route untrusted data into
// the SUBJECT line only when it's been HTML-escaped first, but
// belt-and-braces — every callsite that builds a subject from a
// lead's `name` should pipe through here.
export function stripCrLf(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}
