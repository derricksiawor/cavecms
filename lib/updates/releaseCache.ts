// Pre-staged release artifact cache for background-downloaded updates.
//
// The background prestage step (lib/updates/prestageRelease.ts) downloads
// + sha256-verifies + Ed25519-verifies a release tarball AFTER the periodic
// checker discovers a new version, and writes it here keyed by version+sha256.
// When the operator later clicks "Update now", the apply route looks the
// artifact up via `findValidStaged` and hands its path to the orchestrator,
// which re-verifies it and skips the (slow) download entirely.
//
// Path safety: an explicit CAVECMS_UPDATE_CACHE_DIR override is allowlist-
// gated (same `<CAVECMS_STATE_DIR>/*` / `/var/lib/cavecms/*` discipline as
// the status file) so a hostile env var can't redirect writes to
// /etc/cron.d/*. The computed fallback (no override) derives from the trusted
// install-state dir / log dir, mirroring the apply route's writable-dir
// cascade — never a writable system path the operator didn't choose.
//
// Atomic-write protocol: prestage writes the tarball to `<final>.tmp.<rand>`
// and rename(2)s onto the deterministic name ONLY after full verify, so a
// half-downloaded artifact is never visible under the name findValidStaged
// keys on. The integrity stamp sidecar is written the same way.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  statSync,
  readdirSync,
  constants as fsConstants,
  accessSync,
} from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ensureAllowedStatusPath,
  getInstallStateDir,
} from '@/lib/backups/statusPath'

/** Directory name for the per-install release cache, under the state dir. */
const RELEASE_CACHE_DIRNAME = 'release-cache'

/** Sidecar suffix for the per-artifact integrity stamp JSON. */
const STAMP_SUFFIX = '.json'

/**
 * Integrity stamp written alongside every cached artifact. The inverse of
 * the orchestrator's ephemeral TARBALL_TMP coupling: a stable record of
 * exactly what was verified, so a later apply can trust the cached bytes
 * (after its own mandatory re-verify) without re-deriving anything.
 */
export interface ReleaseStamp {
  /** Semver of the staged release (e.g. "0.1.76"). */
  version: string
  /** Full target SHA the release was built from. */
  sha: string
  /** SHA-256 (64 hex) of the artifact bytes — verified before staging. */
  sha256: string
  /** Ed25519 base64 signature over the artifact bytes. */
  signature: string
  /** Public URL the artifact was downloaded from. */
  downloadUrl: string
  /** Byte size of the staged artifact (cross-checked against statSync). */
  bytes: number
  /** ISO timestamp the artifact was staged. */
  stagedAt: string
  /** Always true for a written stamp — the artifact is only renamed into
   *  place AFTER sha256 + Ed25519 verification pass. */
  verified: true
}

/**
 * Resolve a WRITABLE base directory for the release cache when no explicit
 * CAVECMS_UPDATE_CACHE_DIR override is set. Mirrors the apply route's
 * resolveWritableLogDir cascade so the cache lands somewhere the runtime
 * user can always write, on every surface:
 *   1. CAVECMS_STATE_DIR (per-install, runtime-user-owned — CLI installs)
 *   2. /var/log/cavecms parent? no — we never use a system log dir as a base
 *   3. <tmpdir> (always writable by the process owner)
 * We deliberately prefer the install-state dir; only fall through to the
 * platform temp dir on a legacy install with neither STATE_DIR nor a usable
 * cwd-derived state dir.
 */
function resolveWritableBaseDir(): string {
  const stateDir = getInstallStateDir()
  const candidates = [
    stateDir ?? undefined,
    process.env.CAVECMS_LOG_DIR,
    resolve(tmpdir(), 'cavecms'),
  ].filter((d): d is string => typeof d === 'string' && d.length > 0)
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      accessSync(dir, fsConstants.W_OK)
      return dir
    } catch {
      // Not creatable/writable — try the next candidate.
    }
  }
  return tmpdir()
}

/**
 * Resolve the release-cache directory.
 *   1. CAVECMS_UPDATE_CACHE_DIR (explicit; allowlist-gated against the same
 *      `<STATE_DIR>/*` / `/var/lib/cavecms/*` prefixes as the status file)
 *   2. <CAVECMS_STATE_DIR>/release-cache (CLI installs — the common case)
 *   3. <writable-fallback>/release-cache (legacy installs)
 */
export function getCacheDir(): string {
  const explicit = process.env.CAVECMS_UPDATE_CACHE_DIR
  if (explicit) {
    // Reuse the status-path allowlist — it permits <STATE_DIR>/*,
    // /var/lib/cavecms/*, and (dev/test only) the temp dir. A hostile
    // override pointing at /etc/cron.d/* throws here.
    return ensureAllowedStatusPath(explicit)
  }
  const stateDir = getInstallStateDir()
  if (stateDir) return join(stateDir, RELEASE_CACHE_DIRNAME)
  return join(resolveWritableBaseDir(), RELEASE_CACHE_DIRNAME)
}

/** mkdir -p the cache dir and return its path. */
export function ensureCacheDir(): string {
  const dir = getCacheDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

// Defensive filename sanitisation. The manifest version is already semver-
// constrained upstream, but a cache filename must never carry a path
// separator or shell-meaningful byte even if a future manifest shape relaxes
// that. Collapse anything outside [A-Za-z0-9._+-] to '_'.
function sanitizeForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._+-]/g, '_')
}

/**
 * Deterministic artifact path for a (version, sha256) pair. Survives across
 * runs so a prior prestage's artifact is found by a later apply. Keyed by
 * BOTH version and the sha256 prefix so two releases sharing a version
 * string (shouldn't happen, but defence-in-depth) can't collide.
 */
export function cachePathFor(version: string, sha256: string): string {
  const v = sanitizeForFilename(version || 'unknown')
  const shaPart = sanitizeForFilename(sha256.toLowerCase()).slice(0, 16)
  return join(getCacheDir(), `cavecms-${v}-${shaPart}.tar.gz`)
}

/** Sidecar stamp path for a given artifact path. */
export function stampPathFor(artifactPath: string): string {
  return `${artifactPath}${STAMP_SUFFIX}`
}

/** Read + validate an integrity stamp. Returns null on any malformation. */
export function readStamp(stampPath: string): ReleaseStamp | null {
  let raw: string
  try {
    raw = readFileSync(stampPath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (
    typeof p.version !== 'string' ||
    typeof p.sha !== 'string' ||
    typeof p.sha256 !== 'string' ||
    typeof p.signature !== 'string' ||
    typeof p.downloadUrl !== 'string' ||
    typeof p.bytes !== 'number' ||
    typeof p.stagedAt !== 'string' ||
    p.verified !== true
  ) {
    return null
  }
  return {
    version: p.version,
    sha: p.sha,
    sha256: p.sha256,
    signature: p.signature,
    downloadUrl: p.downloadUrl,
    bytes: p.bytes,
    stagedAt: p.stagedAt,
    verified: true,
  }
}

/** Atomic 0600 write of an integrity stamp (tmp + rename). */
export function writeStamp(stampPath: string, stamp: ReleaseStamp): void {
  mkdirSync(dirname(stampPath), { recursive: true })
  const tmp = `${stampPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, JSON.stringify(stamp, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  renameSync(tmp, stampPath)
}

// Length-aware prefix match — the longer SHA must start with the shorter,
// both ≥ 7 chars. Mirrors the apply route's isSameSha so a 12-char
// CAVECMS_COMMIT matches the stamp's full 40-char SHA and vice-versa.
function shaMatches(a: string, b: string): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x.length < 7 || y.length < 7) return false
  const [longer, shorter] = x.length >= y.length ? [x, y] : [y, x]
  return longer.startsWith(shorter)
}

/**
 * Find a valid staged artifact for an operator-approved target. Scans the
 * cache dir's stamps (the apply body carries no `version`, only targetSha +
 * sha256), and returns the artifact path IFF:
 *   - a stamp exists whose sha256 === the requested sha256 (exact), AND
 *   - the stamp's sha matches the target (prefix-aware), AND
 *   - the artifact file exists on disk with byte size === stamp.bytes.
 * Returns null otherwise — apply then downloads inline (graceful degradation).
 *
 * The caller (apply route + check route) treats a null return as "nothing
 * staged"; the orchestrator re-verifies sha256 + Ed25519 before extract
 * regardless, so this scan is a fast pre-filter, NOT the security boundary.
 */
export function findValidStaged(opts: {
  targetSha: string
  sha256: string
}): string | null {
  const wantSha256 = opts.sha256.toLowerCase()
  let dir: string
  let names: string[]
  try {
    dir = getCacheDir()
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith(`.tar.gz${STAMP_SUFFIX}`)) continue
    const stampPath = join(dir, name)
    const stamp = readStamp(stampPath)
    if (!stamp) continue
    if (stamp.sha256.toLowerCase() !== wantSha256) continue
    if (!shaMatches(stamp.sha, opts.targetSha)) continue
    const artifactPath = stampPath.slice(0, -STAMP_SUFFIX.length)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(artifactPath)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (st.size !== stamp.bytes) continue
    return artifactPath
  }
  return null
}

/**
 * Garbage-collect the cache:
 *   - delete orphan `*.tmp.*` files (interrupted downloads / stamp writes)
 *   - keep at most `keep` newest verified artifacts (+ their stamps)
 *   - drop any artifact whose sha256 is NOT in `liveSha256s` when that set
 *     is provided (a superseded release's artifact)
 * Best-effort — every unlink is guarded; a GC failure never blocks staging.
 * Returns the list of deleted artifact basenames for logging.
 */
export function gcCache(
  keep: number,
  opts: { liveSha256s?: ReadonlySet<string> } = {},
): string[] {
  const deleted: string[] = []
  let dir: string
  let names: string[]
  try {
    dir = getCacheDir()
    names = readdirSync(dir)
  } catch {
    return deleted
  }

  const tryUnlink = (p: string): void => {
    try {
      unlinkSync(p)
    } catch {
      /* already gone / unreadable — best-effort */
    }
  }

  // 1. Orphan tmp files — any `*.tmp.*` left by an interrupted write.
  for (const name of names) {
    if (/\.tmp\.[^/]+$/.test(name)) tryUnlink(join(dir, name))
  }

  // 2. Enumerate verified artifacts via their stamps, newest first.
  type Entry = { artifact: string; stamp: string; sha256: string; mtime: number }
  const entries: Entry[] = []
  for (const name of names) {
    if (!name.endsWith(`.tar.gz${STAMP_SUFFIX}`)) continue
    const stampPath = join(dir, name)
    const stamp = readStamp(stampPath)
    const artifactPath = stampPath.slice(0, -STAMP_SUFFIX.length)
    let mtime = 0
    let exists = false
    try {
      mtime = statSync(artifactPath).mtimeMs
      exists = true
    } catch {
      exists = false
    }
    if (!stamp || !exists) {
      // Orphan stamp (no artifact) or orphan artifact (handled below) →
      // clean the stamp; the artifact (if any) falls into the orphan sweep.
      tryUnlink(stampPath)
      if (!stamp && exists) tryUnlink(artifactPath)
      continue
    }
    entries.push({
      artifact: artifactPath,
      stamp: stampPath,
      sha256: stamp.sha256.toLowerCase(),
      mtime,
    })
  }

  // 3. Drop superseded artifacts (sha256 no longer live) outright.
  let survivors = entries
  if (opts.liveSha256s) {
    const live = opts.liveSha256s
    survivors = []
    for (const e of entries) {
      if (!live.has(e.sha256)) {
        tryUnlink(e.artifact)
        tryUnlink(e.stamp)
        deleted.push(basename(e.artifact))
      } else {
        survivors.push(e)
      }
    }
  }

  // 4. Keep the `keep` newest survivors; delete the rest.
  survivors.sort((a, b) => b.mtime - a.mtime)
  for (const e of survivors.slice(Math.max(0, keep))) {
    tryUnlink(e.artifact)
    tryUnlink(e.stamp)
    deleted.push(basename(e.artifact))
  }

  // 5. Stray standalone artifacts without stamps (e.g. partial rename).
  for (const name of names) {
    if (!name.endsWith('.tar.gz')) continue
    const artifactPath = join(dir, name)
    const stampPath = stampPathFor(artifactPath)
    if (!readStamp(stampPath)) {
      tryUnlink(artifactPath)
    }
  }

  return deleted
}
