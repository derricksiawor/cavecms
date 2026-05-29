import 'server-only'

interface Bucket { count: number; windowStart: number; lastSeen: number }
const MAX_ENTRIES = 100_000

// Pinned to globalThis so HMR doesn't reset rate-limit state between requests in dev.
declare global {
  var __cavecmsRateLimitStores: Map<string, Map<string, Bucket>> | undefined
}
const stores: Map<string, Map<string, Bucket>> = globalThis.__cavecmsRateLimitStores ?? new Map()
globalThis.__cavecmsRateLimitStores = stores

function getStore(bucket: string): Map<string, Bucket> {
  let s = stores.get(bucket)
  if (!s) {
    s = new Map()
    stores.set(bucket, s)
  }
  return s
}

function evict(store: Map<string, Bucket>): void {
  const need = Math.ceil(store.size * 0.1)
  let removed = 0
  for (const k of store.keys()) {
    store.delete(k)
    if (++removed >= need) break
  }
}

export function rateLimit(
  bucket: string,
  opts: { limit: number; windowSec: number },
) {
  const store = getStore(bucket)
  return (key: string): boolean => {
    const now = Date.now()
    const b = store.get(key)
    if (!b || now - b.windowStart > opts.windowSec * 1000) {
      store.set(key, { count: 1, windowStart: now, lastSeen: now })
      if (store.size > MAX_ENTRIES) evict(store)
      return true
    }
    b.lastSeen = now
    if (b.count >= opts.limit) return false
    b.count += 1
    return true
  }
}

// Dynamic-opts variant: same bucket store as rateLimit() (sharing
// state by bucket name is the contract — a static + dynamic caller
// against the same bucket name see each other's writes), but the
// per-call `opts` come from the operator's editable
// security_login_thresholds row. Used by the login route so changing
// the limit/window in admin UI takes effect on the next request.
//
// Concurrency note: opts are read once per call, not captured in a
// closure. A PATCH that lowers `limit` while a request is mid-flight
// has no race — the in-flight request finishes against whichever
// opts it read; the next request sees the new opts.
export function rateLimitDyn(
  bucket: string,
  key: string,
  opts: { limit: number; windowSec: number },
): boolean {
  return rateLimitDynInfo(bucket, key, opts).allowed
}

// Richer variant: same store + same accounting as rateLimitDyn(), but
// returns whether the call was allowed AND — when it was NOT — how many
// whole seconds remain until the offending bucket's window resets. The
// caller surfaces that as a `Retry-After` so a throttled operator can be
// told how long to wait. `retryAfter` is undefined on the allowed path
// (no wait needed). rateLimitDyn() delegates here so the two share one
// code path and can never drift.
export function rateLimitDynInfo(
  bucket: string,
  key: string,
  opts: { limit: number; windowSec: number },
): { allowed: boolean; retryAfter?: number } {
  const store = getStore(bucket)
  const now = Date.now()
  const b = store.get(key)
  if (!b || now - b.windowStart > opts.windowSec * 1000) {
    store.set(key, { count: 1, windowStart: now, lastSeen: now })
    if (store.size > MAX_ENTRIES) evict(store)
    return { allowed: true }
  }
  b.lastSeen = now
  if (b.count >= opts.limit) {
    // Window resets `windowSec` after it started; clamp to >= 1s so a
    // sub-second remainder still tells the operator "wait a moment"
    // rather than "0".
    const msLeft = opts.windowSec * 1000 - (now - b.windowStart)
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(msLeft / 1000)) }
  }
  b.count += 1
  return { allowed: true }
}

// Periodic sweep (5 min) to drop entries whose window is way past.
// Pinned to globalThis so dev-mode HMR doesn't stack timers on every reload.
//
// Guard against `next build` import side-effects: `next build` imports
// every route module to extract metadata, which transitively loads this
// file. Without the build-phase suppression, a timer fires once during
// build and the Edge analyser also stumbles on the import side-effect.
// Mirror the same guard `lib/email/queue.ts` uses for its sweep timer.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000
const ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000
declare global {
  var __cavecmsRateLimitSweep: NodeJS.Timeout | undefined
}
const __isBuildPhase = process.env['NEXT_PHASE'] === 'phase-production-build'
if (
  process.env['NEXT_RUNTIME'] === 'nodejs' &&
  !__isBuildPhase &&
  !globalThis.__cavecmsRateLimitSweep
) {
  globalThis.__cavecmsRateLimitSweep = setInterval(() => {
    const now = Date.now()
    for (const store of stores.values()) {
      for (const [k, b] of store) {
        if (now - b.lastSeen > ENTRY_MAX_AGE_MS) store.delete(k)
      }
    }
  }, SWEEP_INTERVAL_MS)
  globalThis.__cavecmsRateLimitSweep.unref()
}
