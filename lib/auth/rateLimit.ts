import 'server-only'

interface Bucket { count: number; windowStart: number; lastSeen: number }
const MAX_ENTRIES = 100_000

// Pinned to globalThis so HMR doesn't reset rate-limit state between requests in dev.
declare global {
  var __bwcRateLimitStores: Map<string, Map<string, Bucket>> | undefined
}
const stores: Map<string, Map<string, Bucket>> = globalThis.__bwcRateLimitStores ?? new Map()
globalThis.__bwcRateLimitStores = stores

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
  const store = getStore(bucket)
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
  var __bwcRateLimitSweep: NodeJS.Timeout | undefined
}
const __isBuildPhase = process.env['NEXT_PHASE'] === 'phase-production-build'
if (
  process.env['NEXT_RUNTIME'] === 'nodejs' &&
  !__isBuildPhase &&
  !globalThis.__bwcRateLimitSweep
) {
  globalThis.__bwcRateLimitSweep = setInterval(() => {
    const now = Date.now()
    for (const store of stores.values()) {
      for (const [k, b] of store) {
        if (now - b.lastSeen > ENTRY_MAX_AGE_MS) store.delete(k)
      }
    }
  }, SWEEP_INTERVAL_MS)
  globalThis.__bwcRateLimitSweep.unref()
}
