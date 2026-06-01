import 'server-only'
import { writeSync } from 'node:fs'
import {
  acquireUpdateLock,
  releaseUpdateLock,
  readLockPid,
  lockIsStale,
} from '@/lib/updates/statusFile'
import { getStage, deleteStage } from './stageStore'
import { applyBundle, type CutoverResult } from './applyBundle'
import { buildBundleContent, contentGraphOf } from './serializeLocal'
import { canonicalContentHash } from './contentHash'
import { contentBackup } from './contentBackup'

export type CutoverOutcome =
  | {
      ok: true
      swapped: CutoverResult
      backupArtifact: string
      contentHash: string
    }
  | {
      ok: false
      reason: 'stage_not_found' | 'busy' | 'drift_detected' | 'backup_failed' | 'cutover_failed'
      // Operator-facing, internals-free. Full diagnostics are logged server-side.
      detail?: string
    }

// Acquire the shared op-lock (mutually exclusive with update/backup/restore AND
// a second cutover) and stamp OUR pid so liveness is decidable. On contention
// we make the reclaim decision ourselves by PID liveness — NOT via the shell-
// script-oriented lockIsStale, which would treat a live in-process holder as
// stale. We only ever reclaim a lock whose holder PID is provably dead.
function tryAcquireLock(): number | null {
  const stamp = (fd: number): number => {
    try {
      writeSync(fd, `${process.pid}\n`)
    } catch {
      /* best-effort PID stamp; liveness falls back to mtime */
    }
    return fd
  }
  try {
    return stamp(acquireUpdateLock())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    // Held by someone. Decide staleness by PID liveness only.
    const pid = readLockPid()
    let reclaimable: boolean
    if (pid === null) {
      // Unstamped (older orchestrator) — defer to the shared staleness heuristic.
      reclaimable = lockIsStale()
    } else {
      try {
        process.kill(pid, 0)
        reclaimable = false // alive → genuinely busy
      } catch (err) {
        reclaimable = (err as NodeJS.ErrnoException).code === 'ESRCH' // dead → reclaim
      }
    }
    if (!reclaimable) return null
    // TOCTOU narrowing: re-read the stamped PID immediately before unlinking and
    // only reclaim if it is STILL the same dead PID we inspected. This stops us
    // from blind-unlinking a lock a third process freshly re-created (with its
    // own live PID) in the gap. If acquire still races, the O_EXCL create below
    // fails → we return null (busy) rather than double-holding.
    const pidNow = readLockPid()
    if (pidNow !== pid) return null
    releaseUpdateLock(null) // unlink the (confirmed-still-dead) holder's lock
    try {
      return stamp(acquireUpdateLock())
    } catch {
      return null
    }
  }
}

function liveContentHash(): Promise<string> {
  return buildBundleContent().then((c) => canonicalContentHash(contentGraphOf(c)))
}

// The cutover. Holds the op-lock across: content backup → drift gate → atomic
// applyBundle. The applyBundle transaction (which verifies the page count
// before COMMIT) is the all-or-nothing guarantee; the backup is the retained
// pre-cutover content snapshot for manual revert.
export async function runCutover(
  args: { stageId: string; force?: boolean },
  ctx: { userId: number },
): Promise<CutoverOutcome> {
  const stage = await getStage(args.stageId)
  if (!stage) return { ok: false, reason: 'stage_not_found' }
  // The drift baseline comes from the IMMUTABLE staged record (set at stage
  // time from the bundle manifest), NOT from a per-request field — so a direct
  // API call can't null it out to skip the gate. Only `force` is a request opt.
  const baselineContentHash = stage.baselineContentHash

  const fd = tryAcquireLock()
  if (fd === null) return { ok: false, reason: 'busy', detail: 'another operation is in progress' }

  try {
    // 1. Compute the live (pre-cutover) content hash ONCE — used both for the
    //    drift gate AND to name the backup after the state it actually contains.
    const liveHash = await liveContentHash()

    // 2. Drift gate FIRST — a refusal does ZERO backup work (no wasted dump, no
    //    orphan snapshot). Best-effort: regular block edits don't take the
    //    op-lock, so a concurrent edit landing between this check and the swap's
    //    first DELETE is a narrow, documented window — not a hard barrier.
    if (!args.force) {
      if (baselineContentHash == null) {
        // No baseline recorded → we cannot prove the target is unchanged, so a
        // non-forced cutover must refuse rather than silently overwrite.
        return {
          ok: false,
          reason: 'drift_detected',
          detail: 'no drift baseline recorded for this stage — push with --force to overwrite',
        }
      }
      if (liveHash !== baselineContentHash) {
        return {
          ok: false,
          reason: 'drift_detected',
          detail: 'the target changed since this push was staged — re-stage or push with --force',
        }
      }
    }

    // 3. Content backup — the retained revert snapshot, named after the live
    //    content it captures. A failure here aborts before any write.
    let backupArtifact: string
    try {
      backupArtifact = await contentBackup(liveHash)
    } catch (e) {
      logSyncError('cutover_backup_failed', e)
      return { ok: false, reason: 'backup_failed', detail: 'could not create the pre-cutover backup' }
    }

    // 4. Atomic swap (verifies inside the transaction; throws → ROLLBACK).
    let swapped: CutoverResult
    try {
      swapped = await applyBundle(stage.payload, ctx)
    } catch (e) {
      logSyncError('cutover_apply_failed', e)
      return { ok: false, reason: 'cutover_failed', detail: 'the content swap failed and was rolled back' }
    }

    // Pure cleanup — the swap already committed. A failure here must NOT report
    // cutover_failed (prod IS updated); the stage row TTL-expires regardless.
    await deleteStage(args.stageId).catch((e) => logSyncError('cutover_delete_stage_failed', e))
    return { ok: true, swapped, backupArtifact, contentHash: stage.contentHash }
  } finally {
    releaseUpdateLock(fd)
  }
}

function logSyncError(msg: string, e: unknown): void {
  console.error(
    JSON.stringify({ level: 'error', msg, err: e instanceof Error ? e.message : String(e) }),
  )
}
