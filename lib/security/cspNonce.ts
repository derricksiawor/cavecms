import 'server-only'
import { headers } from 'next/headers'
import { randomBytes } from 'node:crypto'

const HEADER = 'x-csp-nonce'

export async function cspNonce(): Promise<string> {
  const h = await headers()
  const n = h.get(HEADER)
  if (n) return n
  // Fallback only — middleware should have stamped one. Not actually retro-installable.
  return randomBytes(16).toString('base64')
}
