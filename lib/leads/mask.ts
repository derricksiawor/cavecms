// Server-side PII masking for the viewer role. Admin/editor see the
// full lead (their workflow needs the original email + phone to
// follow up). Viewer is a read-only role for sales managers /
// analytics — they get aggregates and trends, not contact details.
//
// Why this lives outside the route handlers: both /api/admin/leads
// (list) and the CSV export (if ever exposed to a viewer) must apply
// the same transform. Keeping it pure + role-typed + unit-tested
// guards against a route handler accidentally serving raw PII when a
// new endpoint is added later.

import 'server-only'

type Role = 'admin' | 'editor' | 'viewer'

interface MaskableLead {
  name?: string | null
  email?: string | null
  phone?: string | null
  message?: string | null
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
// Loose-but-effective phone regex: optional +, then a digit, then 6+
// digits/spaces/dashes. Matches international and local formats. Not
// strict E.164 — the goal is "looks like a phone number in this
// message body", not validation.
const PHONE_RE = /\+?\d[\d\s-]{6,}/g

const MESSAGE_PREVIEW_MAX = 80

// Helper: the masking regex requires at least one local-part char,
// an `@`, and at least one domain char. `"@x"`, `"foo@"`, `"@"`
// all return false and trigger the full-redact path.
function isMaskableEmail(s: string): boolean {
  const at = s.indexOf('@')
  return at > 0 && at < s.length - 1
}

// Single source of truth for "first character of local + *** + @domain"
// masking. Both maskLead (multi-field lead row) and
// maskNewsletterEmail (single-field subscriber row) delegate here so
// a future privacy review can audit the rule in one place.
function maskEmailValue(email: string): string {
  if (!isMaskableEmail(email)) return '***'
  return email.replace(/^(.).*?(@.*)$/, '$1***$2')
}

export function maskLead<T extends MaskableLead>(l: T, role: Role): T {
  if (role !== 'viewer') return l

  // Initials: split on whitespace, first character of each chunk,
  // upper-cased, capped at 3. "John Doe Smith" → "JDS"; "Cher" → "C";
  // null → "" (so the UI renders an empty cell rather than the string
  // "null").
  const initials = (l.name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 3)
    .toUpperCase()

  // Email: first character of local + *** + @domain. "john.doe@x.io"
  // → "j***@x.io". Preserves the domain so the operator can still
  // group viewer queries by domain (corporate vs gmail).
  //
  // Malformed-email guard: a value without a non-empty local part
  // (no `@`, `@` at index 0, `@` at the end, etc.) can't be split
  // cleanly. The original regex falls through and returns the raw
  // string, leaking it to viewers. Reject any shape where `@` isn't
  // at position 1+ and followed by at least one more char. The leads
  // form already validates incoming emails so this only fires for
  // legacy / hand-edited rows.
  const email = l.email ? maskEmailValue(l.email) : null

  // Phone: last 4 digits with *** prefix. Aligns with US/Canadian
  // expectations ("call ***1234"). For international numbers we
  // still expose the last 4 since the country code in the suffix
  // doesn't reveal more than the operator already knows.
  const phone = l.phone ? '***' + l.phone.slice(-4) : null

  // Message body: strip emails + phones AGAIN (a viewer mustn't read
  // contact details a lead pasted into the message field), then cap
  // at MESSAGE_PREVIEW_MAX. The cap is short enough that pasted
  // multi-line bios stay collapsed but long enough to keep the gist
  // ("interested in flat 3B in jamestown — call mornings...").
  const message = (l.message ?? '')
    .replace(EMAIL_RE, '[email]')
    .replace(PHONE_RE, '[phone]')
    .slice(0, MESSAGE_PREVIEW_MAX)

  return { ...l, name: initials, email, phone, message }
}

// Single-field email mask for the newsletter subscriber list. The leads
// table carries name/phone/message in addition to email, so maskLead
// has to compose four fields; newsletter rows only ever expose email
// to the operator UI. Keeps the masking rules in one file so a future
// privacy review can audit both surfaces together.
export function maskNewsletterEmail(
  email: string | null,
  role: Role,
): string | null {
  if (role !== 'viewer') return email
  if (!email) return null
  return maskEmailValue(email)
}
