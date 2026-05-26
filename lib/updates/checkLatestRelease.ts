// Query the static release manifest at cavecms.derricksiawor.com/updates/latest.json
// for the current stable-channel release and decide whether it represents a
// newer revision than what's running locally.
//
// Strategy notes:
// - The manifest is updated by scripts/release/publish.mjs whenever a new
//   zip is built + signed + uploaded to timemacro. Every CaveCMS install in
//   the wild polls the same static endpoint, so a single release push
//   propagates to every operator on the next scheduler tick (12h default).
// - We DON'T poll GitHub commits/tags directly anymore — every push to main
//   would otherwise surface as "Update available" within 12h. The static
//   manifest decouples "code in main" from "release ready for operators".
// - 5-minute in-memory cache keyed by the manifest URL keeps repeated
//   "Check Now" clicks from hammering the origin.
// - For forks running off a different release host, set CAVECMS_RELEASE_MANIFEST_URL
//   to your own /updates/latest.json. The shape MUST match what
//   scripts/release/publish.mjs writes.

export interface LatestRelease {
  /**
   * Full git SHA the release was built from. Compared against
   * `process.env.CAVECMS_COMMIT` via `latest.sha.startsWith(current.sha)`
   * to decide "up to date".
   */
  sha: string
  /** ISO timestamp the release was published (manifest's publishedAt). */
  ts: string
  /** Human-readable changelog. Markdown supported by the modal. */
  changelog: string
  /** Heuristic: does the changelog mention security / CVE / vuln? */
  isSecurity: boolean
  /** Semver-ish version string (e.g. "0.1.0", "1.2.3-beta.4"). */
  version: string
  /** Public URL of the release zip. Used by the apply route to set
   *  CAVECMS_UPDATE_TARBALL_URL for the orchestrator. */
  downloadUrl: string
  /** SHA-256 of the zip bytes. Used by the apply route to set
   *  CAVECMS_UPDATE_TARBALL_SHA256 for the orchestrator. */
  sha256: string
  /** Cap on auto-upgrade jumps. If the running version is older than this,
   *  the operator must step through manually. null = no constraint. */
  minPreviousVersion: string | null
}

import { RELEASE_CHANGELOG_MAX_BYTES, RELEASE_FETCH_TIMEOUT_MS, UPDATE_CHECK_TTL_MS } from './constants'

interface CacheEntry {
  expiresAt: number
  value: LatestRelease
}

const CACHE = new Map<string, CacheEntry>()
const TTL_MS = UPDATE_CHECK_TTL_MS

// Test-only escape hatch — the unit suite needs to start from a clean
// cache between cases. NOT exported from the module's normal entry path;
// the suite imports it directly.
export function __resetCacheForTests(): void {
  CACHE.clear()
}

const DEFAULT_MANIFEST_URL = 'https://cavecms.derricksiawor.com/updates/latest.json'

interface ManifestResponse {
  channel?: unknown
  version?: unknown
  sha?: unknown
  publishedAt?: unknown
  downloadUrl?: unknown
  sha256?: unknown
  signature?: unknown
  isSecurity?: unknown
  minPreviousVersion?: unknown
  changelog?: unknown
}

/**
 * Fetch the release manifest from the configured static endpoint.
 *
 * The `owner` + `repo` args are retained for back-compat with the old
 * GitHub-polling shape (callers pass them from env defaults), but they
 * are NOT used — the URL is determined by CAVECMS_RELEASE_MANIFEST_URL
 * or the default. We keep the arguments so the check route's signature
 * doesn't have to change in lockstep.
 */
export async function checkLatestRelease(_ignoredArgs?: {
  owner?: string
  repo?: string
}): Promise<LatestRelease> {
  const url = process.env.CAVECMS_RELEASE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL
  const cacheKey = url
  const hit = CACHE.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    // User-Agent so origin-side log analysis can correlate per-install poll
    // activity if needed.
    'User-Agent': 'CaveCMS-Updates-Check',
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      // No-store on the origin side, but a Cloudflare or other CDN cache
      // could still serve stale. The scheduler tick is 12h so a stale
      // manifest at the edge is bounded — fine for now.
      cache: 'no-store',
      signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    // Distinguish network-class failures so the check route can surface
    // operator-friendly copy. Timeout via AbortSignal manifests as either
    // AbortError or TimeoutError depending on the runtime — both mean
    // "we couldn't reach the release server".
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`manifest_unreachable: ${msg}`)
  }

  if (!res.ok) {
    if (res.status === 404) {
      // The manifest path is misconfigured (operator-controlled env var
      // or upstream dist host moved).
      throw new Error('manifest_not_found')
    }
    throw new Error(`manifest_http_${res.status}`)
  }

  let body: ManifestResponse
  try {
    body = (await res.json()) as ManifestResponse
  } catch {
    throw new Error('manifest_malformed_json')
  }

  const sha = typeof body.sha === 'string' ? body.sha : ''
  const ts = typeof body.publishedAt === 'string' ? body.publishedAt : ''
  const version = typeof body.version === 'string' ? body.version : ''
  const downloadUrl = typeof body.downloadUrl === 'string' ? body.downloadUrl : ''
  const sha256 = typeof body.sha256 === 'string' ? body.sha256 : ''
  const rawChangelog = typeof body.changelog === 'string' ? body.changelog : ''
  const minPreviousVersion =
    typeof body.minPreviousVersion === 'string' ? body.minPreviousVersion : null
  // isSecurity is authoritative from the manifest. We do NOT re-heuristic
  // the changelog body — publishers explicitly mark security releases.
  const isSecurity = body.isSecurity === true

  if (!sha || !ts || !version || !downloadUrl || !sha256) {
    throw new Error('manifest_malformed_fields')
  }

  // Defensive validation of the downloadUrl. Must be HTTPS + same-origin
  // family as the manifest URL (eliminates open-redirect-style abuse if
  // an attacker MITMs the manifest endpoint without a valid cert — they'd
  // have to also serve a same-origin attacker-controlled zip).
  try {
    const manifestOrigin = new URL(url).origin
    const downloadOrigin = new URL(downloadUrl).origin
    if (downloadOrigin !== manifestOrigin) {
      throw new Error(`manifest_cross_origin_download`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('manifest_')) throw err
    throw new Error('manifest_invalid_download_url')
  }

  // Defensive validation of the sha256 shape. 64 hex chars.
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('manifest_invalid_sha256')
  }

  // Trim the changelog at the configured cap so a runaway notes blob can't
  // blow the response payload.
  const changelog = rawChangelog.slice(0, RELEASE_CHANGELOG_MAX_BYTES)

  const value: LatestRelease = {
    sha,
    ts,
    changelog,
    isSecurity,
    version,
    downloadUrl,
    sha256,
    minPreviousVersion,
  }
  CACHE.set(cacheKey, { expiresAt: Date.now() + TTL_MS, value })
  return value
}
