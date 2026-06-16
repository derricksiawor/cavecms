import 'server-only'
import { randomBytes, createHash } from 'node:crypto'

// Admin-issued password-reset link tokens.
//
// The raw token is a 32-byte random value (base64url, ~43 chars) that
// travels ONLY in the URL / email. We persist solely its SHA-256 hex,
// so a leaked `password_reset_tokens` row can't be turned into a
// working link. Lookup on consume re-hashes the presented raw token
// and matches the stored hash (unique index → single index seek).
//
// SHA-256 is the right primitive here (NOT scrypt): the token is
// high-entropy random, so there is nothing to brute-force — a fast
// hash is fine and keeps the consume path cheap. scrypt is for
// low-entropy human passwords.

// 60-minute validity, set at issue time.
export const RESET_TTL_MS = 60 * 60 * 1000

export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function generateResetToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url')
  return { raw, hash: hashResetToken(raw) }
}
