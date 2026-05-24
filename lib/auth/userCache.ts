import 'server-only'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'

interface CachedUser {
  id: number
  email: string
  role: 'admin' | 'editor' | 'viewer'
  active: boolean
  mustRotatePassword: boolean
  tokensValidAfterMs: number
  cachedAt: number
}

const TTL_MS = 30_000
const MAX_ENTRIES = 10_000

// Insertion-order Map gives FIFO eviction. Pinned to globalThis so dev HMR
// doesn't reset the cache mid-request.
declare global {
  var __bwcUserCache: Map<number, CachedUser> | undefined
}
const cache: Map<number, CachedUser> = globalThis.__bwcUserCache ?? new Map()
globalThis.__bwcUserCache = cache

export type { CachedUser }

export async function getUser(id: number): Promise<CachedUser | null> {
  const c = cache.get(id)
  if (c && Date.now() - c.cachedAt < TTL_MS) return c
  const [row] = await db.select().from(users).where(eq(users.id, id))
  if (!row) {
    cache.delete(id)
    return null
  }
  // NOTE: passwordHash is intentionally excluded from the cache. Login route
  // reads the user fresh from the DB (it has to anyway, to grab the latest
  // hash for verifyPassword). Caching the hash here would expose every cached
  // admin's hash in a heap dump.
  const u: CachedUser = {
    id: row.id,
    email: row.email,
    role: row.role as CachedUser['role'],
    active: row.active,
    mustRotatePassword: row.mustRotatePassword,
    tokensValidAfterMs: row.tokensValidAfter.getTime(),
    cachedAt: Date.now(),
  }
  cache.set(id, u)
  if (cache.size > MAX_ENTRIES) {
    // Evict exactly `overflow` oldest entries (FIFO via Map
    // insertion order) so size returns to MAX_ENTRIES. Previously
    // used `++removed > overflow` which dropped overflow+1 entries
    // (off-by-one) — the loop deletes one entry, increments to 1,
    // 1 > 1 is false, deletes a second, then 2 > 1 breaks. The
    // correct gate is `>= overflow`.
    const overflow = cache.size - MAX_ENTRIES
    let removed = 0
    for (const k of cache.keys()) {
      cache.delete(k)
      if (++removed >= overflow) break
    }
  }
  return u
}

export function invalidateUser(id: number): void {
  cache.delete(id)
}
