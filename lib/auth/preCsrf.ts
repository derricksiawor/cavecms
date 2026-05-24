import 'server-only'
import { randomBytes } from 'node:crypto'

const MAX_ENTRIES = 50_000
const TTL_MS = 15 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

// LRU via insertion-order Map iteration. Pinned to globalThis so dev-mode
// HMR doesn't replace the Map between page render (issuePreCsrf) and the
// form POST (consumePreCsrf).
declare global {
  var __bwcPreCsrf: Map<string, number> | undefined
  var __bwcPreCsrfSweep: NodeJS.Timeout | undefined
}
const store: Map<string, number> = globalThis.__bwcPreCsrf ?? new Map<string, number>()
globalThis.__bwcPreCsrf = store

function sweepExpired(): void {
  const now = Date.now()
  for (const [k, exp] of store) {
    if (exp <= now) store.delete(k)
    else break
  }
}

function evictOverflow(): void {
  if (store.size <= MAX_ENTRIES) return
  const overflow = store.size - MAX_ENTRIES
  let removed = 0
  for (const k of store.keys()) {
    store.delete(k)
    if (++removed > overflow) break
  }
}

// Background sweep, not on hot path. .unref() so it doesn't keep Node alive.
//
// Guard against `next build` import side-effects — see the matching
// comment in lib/auth/rateLimit.ts. Without the gate the sweep timer
// fires once during the build's metadata extraction pass.
const __isBuildPhase = process.env['NEXT_PHASE'] === 'phase-production-build'
if (
  process.env['NEXT_RUNTIME'] === 'nodejs' &&
  !__isBuildPhase &&
  !globalThis.__bwcPreCsrfSweep
) {
  globalThis.__bwcPreCsrfSweep = setInterval(() => {
    sweepExpired()
    evictOverflow()
  }, SWEEP_INTERVAL_MS)
  globalThis.__bwcPreCsrfSweep.unref()
}

export function issuePreCsrf(): string {
  const v = randomBytes(24).toString('base64url')
  store.set(v, Date.now() + TTL_MS)
  // Cheap on-path eviction only when we cross the cap, not every call.
  if (store.size > MAX_ENTRIES) evictOverflow()
  return v
}

export function consumePreCsrf(value: string): boolean {
  // O(1) Map lookup. The value is server-issued randomness from issuePreCsrf,
  // so there is no timing oracle to defend against — knowing the value already
  // means the attacker authored or stole the request.
  const exp = store.get(value)
  if (exp === undefined) return false
  store.delete(value)
  if (exp <= Date.now()) return false
  return true
}

export function _resetPreCsrfMap(): void { store.clear() }
