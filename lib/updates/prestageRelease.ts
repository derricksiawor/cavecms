import 'server-only'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
  statfsSync,
} from 'node:fs'
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'
import { getCurrentVersion } from './getCurrentVersion'
import { RELEASE_PUBKEYS_PEM } from './releasePubkey'
import { compareSemver } from './semver'
import type { LatestRelease } from './checkLatestRelease'
import {
  PRESTAGE_CACHE_KEEP,
  PRESTAGE_MIN_FREE_BYTES,
  PRESTAGE_WGET_TIMEOUT_SEC,
  PRESTAGE_DOWNLOAD_TIMEOUT_MS,
} from './constants'
import {
  cachePathFor,
  ensureCacheDir,
  findValidStaged,
  gcCache,
  stampPathFor,
  writeStamp,
  type ReleaseStamp,
} from './releaseCache'
import {
  acquirePrestageLock,
  releasePrestageLock,
  prestageLockIsStale,
  writePrestageStatus,
} from './statusFile'

const execFileAsync = promisify(execFile)

// Same wget rationale as checkLatestRelease + the orchestrator: the release
// host sits behind Cloudflare Bot Fight Mode, which 403s curl/undici by TLS
// fingerprint from datacenter IPs. wget + a browser UA clears it.
const RELEASE_FETCH_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export type PrestageReason =
  | 'dev'
  | 'unsigned'
  | 'ineligible'
  | 'already_staged'
  | 'in_flight'
  | 'lock_failed'
  | 'disk'
  | 'download_failed'
  | 'sha256_mismatch'
  | 'signature_invalid'
  | 'rename_failed'

export interface PrestageResult {
  staged: boolean
  reason?: PrestageReason
  path?: string
}

// Read-merge-write of the durable updates_state staged* fields. Mirrors the
// scheduler's lastCheckedAt write. Read-merge so a concurrent
// lastNotifiedSha write isn't clobbered (the scheduler awaits notify BEFORE
// kicking prestage, so the window is tiny; findValidStaged is the
// authoritative staged signal regardless).
async function writeStageState(
  fields: Record<string, string | number | undefined>,
): Promise<void> {
  try {
    const state = await getSetting('updates_state')
    const merged = { ...state, ...fields }
    await db.execute(sql`
      INSERT INTO settings (\`key\`, value, version, updated_by)
      VALUES ('updates_state', ${JSON.stringify(merged)}, 1, NULL)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        version = version + 1
    `)
    safeRevalidate([tag.settings]).catch(() => undefined)
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'prestage_state_write_failed',
        err: err instanceof Error ? err.message.slice(0, 200) : String(err),
      }),
    )
  }
}

// SHA-256 of a file's bytes, lowercase hex.
function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// Ed25519-verify bytes against any trusted key. Mirrors the orchestrator's
// shared verify_tarball_signature (dual-key).
function ed25519Verify(payload: Buffer, signatureB64: string): boolean {
  let sig: Buffer
  try {
    sig = Buffer.from(signatureB64, 'base64')
  } catch {
    return false
  }
  for (const pem of RELEASE_PUBKEYS_PEM) {
    try {
      const pubkey = createPublicKey({ key: pem, format: 'pem' })
      if (pubkey.asymmetricKeyType !== 'ed25519') continue
      if (cryptoVerify(null, payload, pubkey, sig)) return true
    } catch {
      /* malformed key — try the next */
    }
  }
  return false
}

function freeBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null // statfsSync unavailable / unsupported → skip the guard
  }
}

/**
 * Download + verify + cache a release artifact in the background, so a later
 * "Update now" skips the download. Never throws — always resolves a result
 * and logs internally (it's called fire-and-forget by the scheduler).
 *
 * Auto-DOWNLOAD only — NEVER auto-apply. This function ends at "verified
 * artifact on disk + durable record"; the operator still initiates apply.
 */
export async function prestageRelease(
  release: LatestRelease,
): Promise<PrestageResult> {
  const log = (msg: string, extra: Record<string, unknown> = {}): void => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...extra }))
  }

  const current = getCurrentVersion()
  if (current.sha === 'dev') return { staged: false, reason: 'dev' }

  // A release with no signature can never be applied (apply route requires
  // it), so there's no point staging it. Record + bail.
  if (!release.signature) {
    writePrestageStatus({
      state: 'prestage_failed',
      version: release.version,
      sha: release.sha,
      sha256: release.sha256,
      error: 'release is unsigned — cannot verify',
    })
    await writeStageState({ stageState: 'failed', stageError: 'unsigned release' })
    return { staged: false, reason: 'unsigned' }
  }

  // Eligibility gate — replicate (and, in Phase 5, mirror at apply) the
  // minPreviousVersion floor so we never cache a jump apply will refuse.
  if (release.minPreviousVersion) {
    const cmp = compareSemver(current.version, release.minPreviousVersion)
    if (cmp !== null && cmp < 0) {
      writePrestageStatus({
        state: 'prestage_ineligible',
        version: release.version,
        sha: release.sha,
        sha256: release.sha256,
        error: `running ${current.version} is older than the minimum ${release.minPreviousVersion} for a one-hop update`,
      })
      await writeStageState({
        stageState: 'ineligible',
        stagedSha: release.sha,
        stagedVersion: release.version,
        stageError: `min ${release.minPreviousVersion} > current ${current.version}`,
      })
      return { staged: false, reason: 'ineligible' }
    }
  }

  // ── Lock (hard backstop against concurrent prestages) ──
  let lockFd: number | null = null
  try {
    lockFd = acquirePrestageLock()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      if (prestageLockIsStale()) {
        releasePrestageLock(null)
        try {
          lockFd = acquirePrestageLock()
        } catch {
          return { staged: false, reason: 'in_flight' }
        }
      } else {
        return { staged: false, reason: 'in_flight' }
      }
    } else {
      log('prestage_lock_failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      return { staged: false, reason: 'lock_failed' }
    }
  }

  try {
    // GC first — drop superseded artifacts (anything whose sha256 isn't the
    // one we're about to stage) + orphan tmp files, keep the newest few.
    // Critical on disk-quota'd hosts (cPanel).
    try {
      const live = new Set<string>([release.sha256.toLowerCase()])
      const dropped = gcCache(PRESTAGE_CACHE_KEEP, { liveSha256s: live })
      if (dropped.length) log('prestage_gc', { dropped })
    } catch {
      /* GC is best-effort */
    }

    // Already staged? Idempotent no-op — re-affirm the durable record + return.
    const existing = findValidStaged({
      targetSha: release.sha,
      sha256: release.sha256,
    })
    if (existing) {
      writePrestageStatus({
        state: 'prestage_staged',
        version: release.version,
        sha: release.sha,
        sha256: release.sha256,
        stagedPath: existing,
      })
      let bytes = 0
      try {
        bytes = statSync(existing).size
      } catch {
        /* ignore */
      }
      await writeStageState({
        stageState: 'staged',
        stagedSha: release.sha,
        stagedSha256: release.sha256,
        stagedVersion: release.version,
        stagedPath: existing,
        stagedAt: new Date().toISOString(),
        stagedBytes: bytes,
        stageError: undefined,
      })
      return { staged: true, reason: 'already_staged', path: existing }
    }

    // Disk guard — refuse to start a download that can't fit (best-effort).
    const cacheDir = ensureCacheDir()
    const free = freeBytes(cacheDir)
    if (free !== null && free < PRESTAGE_MIN_FREE_BYTES) {
      writePrestageStatus({
        state: 'prestage_failed',
        version: release.version,
        sha: release.sha,
        sha256: release.sha256,
        error: 'not enough free disk space to stage the update',
      })
      await writeStageState({ stageState: 'failed', stageError: 'disk' })
      return { staged: false, reason: 'disk' }
    }

    // Mark downloading (status file + durable record).
    writePrestageStatus({
      state: 'prestage_downloading',
      version: release.version,
      sha: release.sha,
      sha256: release.sha256,
      bytesTotal: null,
      bytesDone: null,
    })
    await writeStageState({
      stageState: 'downloading',
      stagedSha: release.sha,
      stagedVersion: release.version,
      stageError: undefined,
    })

    const finalPath = cachePathFor(release.version, release.sha256)
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2)}`

    // Download (fresh .tmp; atomic-rename only after full verify, so a
    // partial download is never visible under the deterministic name).
    try {
      await execFileAsync(
        'wget',
        [
          '-nv',
          '--tries=3',
          `--timeout=${PRESTAGE_WGET_TIMEOUT_SEC}`,
          '--user-agent',
          RELEASE_FETCH_UA,
          '--header',
          'X-CaveCMS-Client: CaveCMS-Prestage',
          '-O',
          tmpPath,
          release.downloadUrl,
        ],
        { timeout: PRESTAGE_DOWNLOAD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      )
    } catch (err) {
      tryUnlink(tmpPath)
      log('prestage_download_failed', {
        err: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
      writePrestageStatus({
        state: 'prestage_failed',
        version: release.version,
        sha: release.sha,
        sha256: release.sha256,
        error: 'download failed',
      })
      await writeStageState({ stageState: 'failed', stageError: 'download_failed' })
      return { staged: false, reason: 'download_failed' }
    }

    // Read once; verify sha256 + Ed25519 on the same bytes.
    let buf: Buffer
    try {
      buf = readFileSync(tmpPath)
    } catch (err) {
      tryUnlink(tmpPath)
      log('prestage_read_failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      await writeStageState({ stageState: 'failed', stageError: 'download_failed' })
      return { staged: false, reason: 'download_failed' }
    }
    if (buf.length === 0) {
      tryUnlink(tmpPath)
      writePrestageStatus({
        state: 'prestage_failed',
        version: release.version,
        sha: release.sha,
        sha256: release.sha256,
        error: 'downloaded artifact is empty',
      })
      await writeStageState({ stageState: 'failed', stageError: 'download_failed' })
      return { staged: false, reason: 'download_failed' }
    }

    const wantSha256 = release.sha256.toLowerCase()
    if (sha256OfBuffer(buf) !== wantSha256) {
      tryUnlink(tmpPath)
      writePrestageStatus({
        state: 'prestage_failed',
        version: release.version,
        sha: release.sha,
        sha256: release.sha256,
        error: "downloaded archive doesn't match the expected fingerprint",
      })
      await writeStageState({ stageState: 'failed', stageError: 'sha256_mismatch' })
      return { staged: false, reason: 'sha256_mismatch' }
    }

    if (!ed25519Verify(buf, release.signature)) {
      tryUnlink(tmpPath)
      writePrestageStatus({
        state: 'prestage_failed',
        version: release.version,
        sha: release.sha,
        sha256: release.sha256,
        error: 'signature did not verify against any trusted key',
      })
      await writeStageState({ stageState: 'failed', stageError: 'signature_invalid' })
      return { staged: false, reason: 'signature_invalid' }
    }

    const bytes = buf.length

    // Atomic rename into the deterministic cache path + write the stamp.
    try {
      renameSync(tmpPath, finalPath)
    } catch (err) {
      tryUnlink(tmpPath)
      log('prestage_rename_failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      await writeStageState({ stageState: 'failed', stageError: 'rename_failed' })
      return { staged: false, reason: 'rename_failed' }
    }
    const stagedAt = new Date().toISOString()
    const stamp: ReleaseStamp = {
      version: release.version,
      sha: release.sha,
      sha256: wantSha256,
      signature: release.signature,
      downloadUrl: release.downloadUrl,
      bytes,
      stagedAt,
      verified: true,
    }
    try {
      writeStamp(stampPathFor(finalPath), stamp)
    } catch (err) {
      // Without a stamp, findValidStaged won't trust the artifact — so a
      // stamp-write failure means the stage is useless. Clean up + fail.
      tryUnlink(finalPath)
      log('prestage_stamp_failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      await writeStageState({ stageState: 'failed', stageError: 'rename_failed' })
      return { staged: false, reason: 'rename_failed' }
    }

    writePrestageStatus({
      state: 'prestage_staged',
      version: release.version,
      sha: release.sha,
      sha256: wantSha256,
      bytesTotal: bytes,
      bytesDone: bytes,
      stagedPath: finalPath,
    })
    await writeStageState({
      stageState: 'staged',
      stagedSha: release.sha,
      stagedSha256: wantSha256,
      stagedVersion: release.version,
      stagedPath: finalPath,
      stagedAt,
      stagedBytes: bytes,
      stageError: undefined,
    })
    log('prestage_staged', { version: release.version, bytes })
    return { staged: true, path: finalPath }
  } finally {
    releasePrestageLock(lockFd)
  }
}

function tryUnlink(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    /* best-effort */
  }
}
