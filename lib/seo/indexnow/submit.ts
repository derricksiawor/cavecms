/**
 * IndexNow multi-engine batch submission.
 *
 * Given a host, its IndexNow key, the key-file location, and a list of URLs,
 * this module dedupes + validates the URLs, chunks them into IndexNow's
 * 10,000-URL-per-POST ceiling, and POSTs each chunk to every selected engine's
 * `/indexnow` endpoint.
 *
 * Design constraints (all enforced here):
 *  - ISOMORPHIC: uses global `fetch` + Web Crypto only (no node:* imports), so
 *    it runs in Node 18+, Edge, and the browser. Tests inject a mock `fetch`
 *    via `fetchImpl` — the network is NEVER touched.
 *  - RESILIENT: one engine being down (network error / hang / 5xx) must NEVER
 *    fail the others. Every request is wrapped in try/catch and a per-request
 *    AbortController timeout; failures are RECORDED, never thrown.
 *  - The function returns a structured {@link SubmitReport} describing exactly
 *    what was submitted, what was skipped (and why), and the per-engine,
 *    per-chunk outcome.
 */

import { ENDPOINTS, isValidIndexNowKey, type Engine } from './key'

// `Engine` is defined in `./key` (alongside ENDPOINTS, so TS keeps the map +
// the union in lock-step). Re-exported here so existing
// `import { Engine } from './submit'` callers (incl. the submit tests) stay
// working without an import-site churn.
export type { Engine }

export interface SubmitArgs {
  /** The site host these URLs belong to, e.g. "example.com". */
  host: string
  /** The IndexNow key for `host`. */
  key: string
  /** Absolute URL of the key file, e.g. "https://example.com/<key>.txt". */
  keyLocation: string
  /** URLs to submit. Deduped + validated before submission. */
  urls: string[]
  /** Which engines to POST to. */
  engines: Engine[]
  /** Injectable fetch (tests pass a mock). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms (AbortController). Defaults to 8000. */
  timeoutMs?: number
}

export interface SubmitResult {
  engine: Engine
  /** HTTP status, or the literal 'error' for a network/timeout failure. */
  status: number | 'error'
  /** Zero-based index of the URL chunk this result is for. */
  chunk: number
  /** Present only when `status === 'error'`. */
  error?: string
}

export interface SubmitReport {
  /** Count of unique, valid URLs actually submitted (in at least one POST). */
  submitted: number
  /** URLs that were dropped, each with a machine-readable reason. */
  skipped: { url: string; reason: string }[]
  /** One entry per (engine × chunk) POST attempted. */
  results: SubmitResult[]
}

/** IndexNow hard cap: at most 10,000 URLs per POST. */
export const MAX_URLS_PER_POST = 10000

/** Default per-request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 8000

/** Split `arr` into consecutive slices of at most `size` elements. */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be > 0')
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

/**
 * De-duplicate URLs, preserving first-seen order. Comparison is exact-string
 * (IndexNow treats URLs as opaque), so callers should normalize beforehand if
 * they consider e.g. trailing-slash variants equivalent.
 */
export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    if (seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}

/**
 * Extract the lowercased hostname from an absolute URL, or `null` if the string
 * is not a parseable absolute URL.
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Validate URLs against `host`: each must be an absolute URL whose hostname
 * matches `host` (case-insensitive). Returns the accepted URLs plus a list of
 * skipped URLs with reasons. IndexNow rejects (422) a POST whose `urlList`
 * contains a URL outside the declared `host`, so we filter proactively.
 */
function partitionUrls(
  urls: string[],
  host: string,
): { valid: string[]; skipped: { url: string; reason: string }[] } {
  const normalizedHost = host.trim().toLowerCase()
  const valid: string[] = []
  const skipped: { url: string; reason: string }[] = []
  for (const u of urls) {
    const h = hostOf(u)
    if (h === null) {
      skipped.push({ url: u, reason: 'not-absolute-url' })
      continue
    }
    if (h !== normalizedHost) {
      skipped.push({ url: u, reason: 'host-mismatch' })
      continue
    }
    valid.push(u)
  }
  return { valid, skipped }
}

/**
 * POST one chunk of URLs to one engine. NEVER throws — any network failure,
 * timeout, or non-2xx is captured and returned as a {@link SubmitResult}.
 */
async function postChunk(
  engine: Engine,
  chunkIndex: number,
  body: { host: string; key: string; keyLocation: string; urlList: string[] },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SubmitResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const endpoint = `https://${ENDPOINTS[engine]}/indexnow`
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return { engine, status: res.status, chunk: chunkIndex }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'timeout'
          : err.message
        : String(err)
    return { engine, status: 'error', chunk: chunkIndex, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Submit `urls` to every engine in `engines`.
 *
 * Pipeline: dedupe → validate against `host` (drop+report cross-host /
 * non-absolute) → chunk at {@link MAX_URLS_PER_POST} → POST each chunk to each
 * engine, recording every outcome. Resolves with a {@link SubmitReport}; never
 * rejects on a network/HTTP error (those are recorded as `status: 'error'`).
 *
 * Short-circuits (no requests sent) when there are no valid URLs to submit.
 */
export async function submitUrls(args: SubmitArgs): Promise<SubmitReport> {
  const {
    host,
    key,
    keyLocation,
    urls,
    engines,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = args

  // Validate the key shape up front — a malformed key would be rejected by
  // every engine (403/422), so we don't waste requests on it.
  if (!isValidIndexNowKey(key)) {
    return {
      submitted: 0,
      skipped: urls.map((url) => ({ url, reason: 'invalid-key' })),
      results: [],
    }
  }

  const deduped = dedupeUrls(urls)
  const { valid, skipped } = partitionUrls(deduped, host)

  // Empty / all-invalid list: short-circuit, send nothing.
  if (valid.length === 0) {
    return { submitted: 0, skipped, results: [] }
  }

  const chunks = chunk(valid, MAX_URLS_PER_POST)

  // Fan out across (engine × chunk). Each task is independently resilient, so a
  // hung or erroring engine can't reject the Promise.all.
  const tasks: Promise<SubmitResult>[] = []
  for (const engine of engines) {
    chunks.forEach((urlList, chunkIndex) => {
      tasks.push(
        postChunk(
          engine,
          chunkIndex,
          { host, key, keyLocation, urlList },
          fetchImpl,
          timeoutMs,
        ),
      )
    })
  }

  const results = await Promise.all(tasks)

  return {
    submitted: valid.length,
    skipped,
    results,
  }
}
