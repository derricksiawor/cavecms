import 'server-only'

// Normalize a submitted email for storage + uniqueness comparisons.
// MariaDB's default collation (utf8mb4_0900_ai_ci) is case-insensitive
// but does NOT collapse whitespace, so 'a@x.com', 'A@x.com', and
// 'a@x.com\t' end up as distinct rows in newsletter_subscribers'
// UNIQUE(email) — an attacker can bypass per-email rate-limits and
// flood a victim's inbox with N confirmation emails per IP window.
//
// We lower-case + trim every public-form email at the route boundary
// before INSERTs. Display-case preservation (e.g. for the auto-reply
// salutation) intentionally happens elsewhere with the visitor's
// supplied casing; the DB column always stores the normalized form.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
