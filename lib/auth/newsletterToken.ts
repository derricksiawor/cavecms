import 'server-only'
import { randomBytes } from 'node:crypto'

// Newsletter confirmation + unsubscribe token. Single column
// (newsletter_subscribers.unsubscribe_token) serves both flows; the
// URL path determines which action the token enables (/api/newsletter/
// confirm vs /unsubscribe). Rotated on every status change so a stale
// link from the inbox can't replay after the user has acted.
//
// Shape: 32 random bytes → base64url (43 chars, no padding).
// ~256 bits of entropy. Schema column is varchar(64).
//
// Centralized here so the byte-width, alphabet, and regex stay in
// lockstep across the 3 callers (newsletter signup, unsubscribe page,
// confirm route).
const TOKEN_BYTES = 32

export const NEWSLETTER_TOKEN_RE = /^[A-Za-z0-9_-]{43,64}$/

export function newNewsletterToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}
