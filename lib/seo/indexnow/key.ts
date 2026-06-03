/**
 * IndexNow key utilities.
 *
 * IndexNow ties URL-submissions to a per-site key. The key is a string of
 * 8–128 characters from the set [a-zA-Z0-9-]; the site proves ownership by
 * serving the key as plain UTF-8 text at `https://<host>/<key>.txt` (the body
 * is EXACTLY the key, nothing else).
 *
 * Everything here is ISOMORPHIC — it runs unchanged in Node 18+, the Edge
 * runtime, and the browser. We deliberately use the Web Crypto API
 * (`crypto.getRandomValues`) and never import `node:crypto`, so the module can
 * be pulled into an Edge middleware / route handler without a runtime split.
 */

/** Registry-accepted key shape: 8–128 chars of [a-zA-Z0-9-]. */
const KEY_REGEX = /^[a-zA-Z0-9-]{8,128}$/

/**
 * The IndexNow ingestion engines this codebase pings. Defined HERE (the lower
 * module) so {@link ENDPOINTS} can be typed `Record<Engine, string>` — TS then
 * forces the endpoint map and this union to stay in lock-step, instead of the
 * old hand-listed key set drifting from `submit.ts`'s separate `Engine`. The
 * submit module imports + re-exports this type, so existing
 * `import { Engine } from './submit'` callers are unaffected.
 */
export type Engine = 'indexnow' | 'bing' | 'yandex' | 'seznam' | 'naver'

/**
 * IndexNow ingestion endpoints (host names only — callers append the
 * `/indexnow` path). Submitting to ANY one of these shares the URL with the
 * whole IndexNow network, but engines that consume directly still benefit from
 * an explicit ping, so we enumerate them.
 *
 * NOTE: DuckDuckGo and Yahoo are intentionally absent — they do NOT consume
 * IndexNow directly, they ride Bing's index. Inventing endpoints for them would
 * just produce dead requests.
 */
export const ENDPOINTS: Record<Engine, string> = {
  indexnow: 'api.indexnow.org',
  bing: 'www.bing.com',
  yandex: 'yandex.com',
  seznam: 'search.seznam.cz',
  naver: 'searchadvisor.naver.com',
}

/**
 * Generate a fresh IndexNow key: 32 lowercase-hex characters.
 *
 * 32 hex chars = 128 bits of entropy, comfortably inside the 8–128 length
 * window and using only `[0-9a-f]` (a subset of the allowed `[a-zA-Z0-9-]`),
 * so the result always satisfies {@link isValidIndexNowKey}.
 */
export function generateIndexNowKey(): string {
  const bytes = new Uint8Array(16) // 16 bytes -> 32 hex chars
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0')
  }
  return out
}

/** True iff `k` matches the IndexNow registry key shape (8–128 of [a-zA-Z0-9-]). */
export function isValidIndexNowKey(k: string): boolean {
  return typeof k === 'string' && KEY_REGEX.test(k)
}

/**
 * The exact body of the key file served at `/<key>.txt`. IndexNow requires the
 * file to contain ONLY the key (UTF-8, no trailing newline, no whitespace).
 */
export function keyFileContent(key: string): string {
  return key
}
