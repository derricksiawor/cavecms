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
  /** Ed25519 base64 signature over the zip bytes. The apply route
   *  REQUIRES this for in-app updates — sha256 alone is insufficient
   *  when the manifest origin is also attacker-controlled. Null
   *  surfaces a "release not verifiable" affordance in the UI. */
  signature: string | null
  /** Cap on auto-upgrade jumps. If the running version is older than this,
   *  the operator must step through manually. null = no constraint. */
  minPreviousVersion: string | null
}

import { z } from 'zod'
import { RELEASE_CHANGELOG_MAX_BYTES, RELEASE_FETCH_TIMEOUT_MS, UPDATE_CHECK_TTL_MS } from './constants'

// Zod schema for the /updates/latest.json payload that scripts/release/
// publish.mjs writes. Defence in depth — the CDN, an operator-pinned
// manifest URL, or a tampered fork could serve a malformed body. Failing
// fast here is safer than letting an unverified value flow into snapshot
// path components, download URLs, or version comparisons downstream.
//
// Field shapes track publish.mjs's writeUpdatesManifest exactly. New
// fields added there MUST be added here too — z.object() ignores unknown
// keys by default, but missing-required-key errors surface clearly.
const ManifestSchema = z.object({
  channel: z.string().min(1).max(64).optional(),
  version: z.string().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$/, 'version must be semver'),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i, 'sha must be 7-64 hex chars'),
  publishedAt: z.string().datetime({ offset: true }),
  // Scheme check here closes the gap where z.string().url() would accept
  // ftp:// or file:// — those would pass schema and only fail at the
  // downstream new URL().origin check (which doesn't itself reject them).
  downloadUrl: z.string().max(2048).regex(/^https:\/\//i, 'downloadUrl must be HTTPS'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'sha256 must be 64 hex chars'),
  // Ed25519 base64 signature is ~88 chars including padding. Cap at 256
  // so a manifest that nulls signature can't blow the body either.
  signature: z.string().max(256).nullable().optional(),
  isSecurity: z.boolean().optional(),
  minPreviousVersion: z.string().max(64).nullable().optional(),
  // Cap changelog at 2x the post-fetch trim cap so a malicious manifest
  // can't blow the parsed body even before the slice. The trim at
  // line ~190 still applies for the value we expose to consumers.
  changelog: z.string().max(RELEASE_CHANGELOG_MAX_BYTES * 2).optional(),
  // Some build pipelines write `notes` into the manifest entry (the
  // /manifest.json shape) instead of `changelog` (the /updates/latest.json
  // shape). If the operator's CAVECMS_RELEASE_MANIFEST_URL is pointed at
  // a manifest using the `notes` key, accept it as a fallback below.
  notes: z.string().max(RELEASE_CHANGELOG_MAX_BYTES * 2).optional(),
})

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

  let rawBody: unknown
  try {
    rawBody = await res.json()
  } catch {
    throw new Error('manifest_malformed_json')
  }

  const parsed = ManifestSchema.safeParse(rawBody)
  if (!parsed.success) {
    // Zod issues are detailed but operator-noisy — surface a short
    // machine-readable error tag plus a one-line summary. The check
    // route logs the full Zod issue list at debug level for support.
    const firstIssue = parsed.error.issues[0]
    const path = firstIssue?.path.join('.') || '<root>'
    throw new Error(`manifest_invalid_schema: ${path}: ${firstIssue?.message ?? 'unknown'}`)
  }
  const body = parsed.data
  const sha = body.sha
  const ts = body.publishedAt
  const version = body.version
  const downloadUrl = body.downloadUrl
  const sha256 = body.sha256
  const signature = body.signature ?? null
  // Prefer `changelog` (the /updates/latest.json shape that publish.mjs
  // writes), fall back to `notes` (the /manifest.json shape that
  // build-zip.mjs writes) so an operator who points
  // CAVECMS_RELEASE_MANIFEST_URL at the full manifest still gets copy.
  const rawChangelog = body.changelog ?? body.notes ?? ''
  const minPreviousVersion = body.minPreviousVersion ?? null
  // isSecurity is authoritative from the manifest. We do NOT re-heuristic
  // the changelog body — publishers explicitly mark security releases.
  const isSecurity = body.isSecurity === true

  // Defensive validation of the downloadUrl. Must be HTTPS, and the
  // origin must match the manifest URL's origin OR an operator-pinned
  // allowlist (CAVECMS_RELEASE_DOWNLOAD_ORIGINS, comma-separated). The
  // allowlist is the escape hatch for forks that publish manifest +
  // tarball on different hosts (e.g. CDN-fronted downloads with a
  // separate manifest origin). Default: same-origin required.
  try {
    const manifestOrigin = new URL(url).origin
    const downloadOrigin = new URL(downloadUrl).origin
    if (downloadOrigin !== manifestOrigin) {
      const allowedRaw = process.env.CAVECMS_RELEASE_DOWNLOAD_ORIGINS
      const allowed = allowedRaw
        ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : []
      if (!allowed.includes(downloadOrigin)) {
        throw new Error(`manifest_cross_origin_download`)
      }
    }
    if (!/^https:\/\//i.test(downloadUrl)) {
      throw new Error('manifest_insecure_download_url')
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
    signature,
    minPreviousVersion,
  }
  CACHE.set(cacheKey, { expiresAt: Date.now() + TTL_MS, value })
  return value
}
