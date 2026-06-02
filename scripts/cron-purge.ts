// Daily purge. Invoked by cavecms-cron-purge.timer @ 06:00 UTC. Runs the
// quiet-time bookkeeping the live request path can't afford:
//
//   * Hard-deletes soft-deleted content_blocks past retention
//   * Trims login_attempts, audit_log, notification_failures,
//     pending_emails (resolved), and stale user_known_ips
//   * Soft-deletes orphan media (variants IS NULL > 1h — pipeline
//     committed the row but the post-process rename never landed)
//   * Hard-deletes soft-deleted media that no media_references row
//     points at — under FOR UPDATE so a concurrent saveBlock can't
//     INSERT a reference between the SELECT and the DELETE
//
// CONTRACTS THIS SCRIPT CONSUMES (from cluster-3):
//
//   /var/lib/cavecms/last-uploads-backup.ok must be ≤24h old. If
//   uploads-backup hasn't run successfully today we refuse to purge
//   — a file we hard-delete on disk has no recovery path otherwise.
//   This is the contract documented in cavecms-cron-purge.service:9.
//   The plan template (docs/.../plan-09:1029) omitted this gate; it
//   is added here per cluster-3 → cluster-4 handoff.
//
//   /var/lib/cavecms/deploy.blocked: NOT consumed here. disk-check writes
//   it for the preflight to read; cron-purge does not gate on it
//   (low-disk during purge is still safer than letting tables grow
//   unboundedly).

// NODE_ENV guard MUST run BEFORE any import that touches db/client.ts
// — db/client-node.ts creates a mysql2 pool on import and registers
// the 'connection' event handler. Importing-then-bailing would leak
// a pool and an unhandled-rejection-prone handler into the test
// environment.
if (process.env['NODE_ENV'] !== 'production') {
  console.error('[cron-purge] refusing to run with NODE_ENV != production')
  process.exit(1)
}

import { lstat, unlink, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db, pool } from '../db/client'
import { intervalDays } from '../lib/db/intervalDays'
import { env } from '../lib/env'

const SOFT_DAYS = Number(process.env['SOFT_DELETE_RETENTION_DAYS'] ?? 30)
const ATT_DAYS = Number(process.env['LOGIN_ATTEMPTS_RETENTION_DAYS'] ?? 30)
const AUD_DAYS = Number(process.env['AUDIT_LOG_RETENTION_DAYS'] ?? 730)
const NTF_DAYS = Number(process.env['NOTIFICATION_FAILURES_RETENTION_DAYS'] ?? 30)
const UKI_DAYS = Number(process.env['USER_KNOWN_IPS_RETENTION_DAYS'] ?? 90)

// Reject obviously bogus values BEFORE running any DELETE. A typo'd
// `LOGIN_ATTEMPTS_RETENTION_DAYS=` (empty → NaN → INTERVAL NaN DAY)
// would silently delete EVERY row.
//
// Upper bound 3650 (10 years) matches `lib/db/intervalDays.ts`. The
// previous cap was 36500 (100 years), which left a partial-completion
// failure window: `SOFT_DELETE_RETENTION_DAYS` in [3651, 36500] would
// pass this gate, the legacy posts/projects/leads DELETEs would run
// (they use inline `sql.raw(String(SOFT_DAYS))`), and the new pages
// DELETE would then throw in `intervalDays()` after four tables had
// already been mutated. Aligning the bounds closes that window AND
// applies the 10-year sanity ceiling to the other retention vars where
// it's equally appropriate — a retention configured for 11+ years is
// almost certainly a typo.
for (const [name, value] of [
  ['SOFT_DELETE_RETENTION_DAYS', SOFT_DAYS],
  ['LOGIN_ATTEMPTS_RETENTION_DAYS', ATT_DAYS],
  ['AUDIT_LOG_RETENTION_DAYS', AUD_DAYS],
  ['NOTIFICATION_FAILURES_RETENTION_DAYS', NTF_DAYS],
  ['USER_KNOWN_IPS_RETENTION_DAYS', UKI_DAYS],
] as const) {
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    console.error(`[cron-purge] ${name} must be a positive integer ≤ 3650, got: ${String(value)}`)
    process.exit(1)
  }
}

const UPLOADS_BACKUP_MARKER = '/var/lib/cavecms/last-uploads-backup.ok'
const MAX_BACKUP_AGE_SEC = 24 * 60 * 60

// Bounded for-update SELECT page size. A single TX scanning the full
// orphan candidate set would hold row locks long enough to stall any
// concurrent saveBlock INSERT into media_references. We iterate in
// pages until the candidate set is empty.
const MEDIA_PURGE_BATCH = 200

// Uploads-root layout mirrors lib/uploads/paths.ts. We re-derive the
// variant suffix list here (rather than importing the path helper)
// because importing it pulls Next/server-only into a CLI process.
// Keep the suffix list in sync with the image pipeline.
const IMAGE_VARIANT_SUFFIXES = ['-thumb.webp', '-md.webp', '-lg.webp', '-og.jpg']

function logInfo(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', script: 'cron-purge', event, ...extra }))
}

function logError(event: string, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', script: 'cron-purge', event, ...extra }))
}

// Marker freshness gate. Pool is already initialized by import time
// (db/client-node.ts opens the mysql2 pool at module load), so this
// helper MUST throw on failure rather than process.exit — main()'s
// try/catch/finally is responsible for draining the pool. A direct
// process.exit here would orphan keep-alived connections server-side
// (Aborted_clients++).
async function assertUploadsBackupFresh(): Promise<void> {
  let s: Awaited<ReturnType<typeof lstat>>
  try {
    // lstat (not stat) so a symlink at the marker path is detected
    // rather than silently followed. Defence-in-depth: the marker
    // lives in /var/lib/cavecms (2770 root:cavecmsstate). If the directory
    // perms are ever loosened or another cavecmsstate-group service is
    // added, a swapped symlink could forge freshness against an
    // unrelated frequently-touched file.
    s = await lstat(UPLOADS_BACKUP_MARKER)
  } catch (err) {
    throw new Error(
      `uploads-backup marker missing at ${UPLOADS_BACKUP_MARKER}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  if (s.isSymbolicLink()) {
    throw new Error(
      `uploads-backup marker at ${UPLOADS_BACKUP_MARKER} is a symlink — refusing to follow`,
    )
  }
  if (!s.isFile()) {
    throw new Error(
      `uploads-backup marker at ${UPLOADS_BACKUP_MARKER} is not a regular file`,
    )
  }
  const ageSec = (Date.now() - s.mtimeMs) / 1000
  if (ageSec > MAX_BACKUP_AGE_SEC) {
    throw new Error(
      `uploads-backup marker stale (ageSec=${Math.round(ageSec)} > ${MAX_BACKUP_AGE_SEC}) — refusing to hard-delete media without a recent backup`,
    )
  }
  logInfo('uploads_backup_marker_fresh', {
    ageSec: Math.round(ageSec),
  })
}

// Resolve and validate the uploads-root subdirs. UPLOADS_ROOT comes
// from lib/env.ts (production requires it absolute). We refuse to
// unlink a path that doesn't begin with the resolved root — defends
// against a hostile filename_uuid that ever bypassed write-time
// validation (e.g. '../../etc/passwd' would otherwise traverse).
const UPLOADS_ROOT = path.resolve(env.UPLOADS_ROOT)
const ORIGINALS_DIR = path.join(UPLOADS_ROOT, 'originals')
const VARIANTS_DIR = path.join(UPLOADS_ROOT, 'variants')
const BROCHURES_DIR = path.join(UPLOADS_ROOT, 'brochures-private')

function isWithinUploadsRoot(p: string): boolean {
  const resolved = path.resolve(p)
  return resolved === UPLOADS_ROOT || resolved.startsWith(UPLOADS_ROOT + path.sep)
}

function pathsForMedia(filenameUuid: string, mimeType: string): string[] {
  // filename_uuid is a varchar(40) generated by the upload pipeline. We
  // re-validate here so a manually-INSERTed media row with a path-
  // traversal payload can't reach fs.unlink.
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(filenameUuid)) return []
  if (mimeType === 'application/pdf') {
    return [path.join(BROCHURES_DIR, `${filenameUuid}.pdf`)]
  }
  return [
    path.join(ORIGINALS_DIR, filenameUuid),
    ...IMAGE_VARIANT_SUFFIXES.map((s) => path.join(VARIANTS_DIR, `${filenameUuid}${s}`)),
  ]
}

async function purgeSoftDeletedRows(): Promise<void> {
  // content_blocks / posts / projects / leads all share the
  // 30-day recovery window. Posts + projects also hold typed media
  // references (hero_image_id, brochure_pdf_id, og_image_id) that
  // the weekly verify-media-refs reconciler will clean up as orphans
  // after this purge runs — we don't need to touch media_references
  // here.
  // Note (migration 0011): when this DELETE removes a `kind='section'`
  // or `kind='column'` row, the self-FK on content_blocks(parent_id)
  // CASCADES the hard-delete to every descendant column/widget. mysql2
  // reports only the DIRECT rows touched in `affectedRows`, so the
  // logged `affected` count UNDERSTATES by the cascade-descendant
  // count. The descendant rows were also soft-deleted with the same
  // `deleted_at` (via the API's recursive-CTE soft-cascade in
  // /api/cms/blocks/[id] DELETE), so they'd be picked up by this very
  // statement directly anyway — no rows are missed, only the metric
  // is slightly low. Logged for visibility, not correctness.
  const [r1] = await db.execute(
    sql`DELETE FROM content_blocks
        WHERE deleted_at IS NOT NULL
          AND deleted_at < (NOW(3) - INTERVAL ${sql.raw(String(SOFT_DAYS))} DAY)`,
  )
  logInfo('content_blocks_purged', { affected: (r1 as { affectedRows?: number }).affectedRows ?? 0 })

  const [rPosts] = await db.execute(
    sql`DELETE FROM posts
        WHERE deleted_at IS NOT NULL
          AND deleted_at < (NOW(3) - INTERVAL ${sql.raw(String(SOFT_DAYS))} DAY)`,
  )
  logInfo('posts_purged', { affected: (rPosts as { affectedRows?: number }).affectedRows ?? 0 })

  const [rProjects] = await db.execute(
    sql`DELETE FROM projects
        WHERE deleted_at IS NOT NULL
          AND deleted_at < (NOW(3) - INTERVAL ${sql.raw(String(SOFT_DAYS))} DAY)`,
  )
  logInfo('projects_purged', { affected: (rProjects as { affectedRows?: number }).affectedRows ?? 0 })

  // Leads carry no media_references; a straight DELETE is enough.
  // audit_log rows with resource_type='lead' are forward-only and stay
  // through the audit retention window (AUD_DAYS, default 730d).
  const [rLeads] = await db.execute(
    sql`DELETE FROM leads
        WHERE deleted_at IS NOT NULL
          AND deleted_at < (NOW(3) - INTERVAL ${sql.raw(String(SOFT_DAYS))} DAY)`,
  )
  logInfo('leads_purged', { affected: (rLeads as { affectedRows?: number }).affectedRows ?? 0 })

  // Pages soft-deleted past retention. The FK ON DELETE CASCADE on
  // content_blocks.page_id (migration 0010 §1.2) cascades the block
  // rows atomically — order vs. the earlier content_blocks block does
  // not affect correctness (the cascade hard-deletes regardless of the
  // child's own deleted_at). This block runs LAST among the soft-delete
  // purges purely so the per-table log lines surface in parent-after-
  // children order for operator readability. media_references rows
  // pointing at cascaded blocks become orphans, swept by the weekly
  // verify-media-refs reconciler.
  //
  // Single-statement DELETE … RETURNING (MariaDB 10+, enforced by
  // scripts/preflight.sh + pre-migrate-asserts) eliminates the
  // SELECT-then-DELETE race that would otherwise let a page soft-deleted
  // between the two queries get hard-deleted without its slug appearing
  // in the revalidate tag list. SOFT_DAYS is validated at module load
  // above; `intervalDays()` re-validates defensively to keep the
  // `sql.raw` blast radius local to one helper.
  const purgedPagesResult = (await db.execute(sql`
    DELETE FROM pages
    WHERE deleted_at IS NOT NULL
      AND deleted_at < (NOW(3) - INTERVAL ${intervalDays(SOFT_DAYS)} DAY)
    RETURNING id, slug, is_home
  `)) as unknown as [Array<{ id: number; slug: string; is_home: number }>]
  const purgedPages = purgedPagesResult[0]
  logInfo('pages_purged', { affected: purgedPages.length })

  if (purgedPages.length > 0) {
    // Tag literals duplicate the values exported by `lib/cache/tags.ts`
    // (`tag.pagesIndex`, `tag.sitemap`, `tag.page(slug)`,
    // `tag.pageSlugResolver(slug)`, `tag.home`). We CANNOT import that
    // module here — `lib/cache/tags.ts:1` carries `import 'server-only'`,
    // which throws on module load under plain `tsx scripts/...` (no
    // `--conditions=react-server` flag in the systemd ExecStart) and
    // kills the cron before any DELETE runs. Any rename of these literals
    // MUST land in both this file and `lib/cache/tags.ts` in the same
    // commit; there is no compile-time check that catches divergence.
    const allTags = [
      'pages-index',
      'sitemap',
      ...purgedPages.flatMap((p) => [
        `page:${p.slug}`,
        `page-slug-resolver:${p.slug}`,
      ]),
      // Defensive: under PR-3+ data, soft-delete clears `is_home` in the
      // same UPDATE, so this branch never fires for fresh writes.
      // post-migrate-asserts assert #7 guards against legacy rows with
      // `is_home=1 AND deleted_at IS NOT NULL`; tag-emit defensively in
      // case any slipped through before the assert was active.
      ...(purgedPages.some((p) => p.is_home === 1) ? ['home'] : []),
    ]

    // `revalidateTag` from `next/cache` invariant-throws when called
    // from a plain Node process — `workAsyncStorage.getStore()` returns
    // undefined and Next bails with `static generation store missing`.
    // We proxy through an internal Next route (`app/api/internal/
    // revalidate-tags/route.ts`) so the `revalidateTag` calls land
    // inside a real request context. Loopback (127.0.0.1:${PORT})
    // because nginx fronts public traffic and the cron has no business
    // egressing through the public hostname. Bearer-token gate is the
    // load-bearing security boundary; nginx loopback-only routing is
    // defence in depth.
    //
    // Backpressure: chunk the tag burst into batches of 50 with a 100ms
    // pause between batches. After a multi-day outage backlog the purge
    // could surface hundreds of pages worth of tags in a single run;
    // firing them all at once would saturate the revalidate path for
    // the rest of the Next pool.
    const port = env.PORT
    const url = `http://127.0.0.1:${port}/api/internal/revalidate-tags`
    const bearer = `Bearer ${env.INTERNAL_REVALIDATE_SECRET}`
    // Per-request timeout. Without this, a wedged Next pool would hang
    // the fetch indefinitely — undici has no default fetch timeout.
    // 15s is generous (the route only fires revalidateTag in a loop;
    // worst-case 500 tags × low-microsecond per-tag write to Next's
    // tag manifest is well under one second). Combined with the
    // systemd `TimeoutStartSec=30min` ceiling, a wedge surfaces fast
    // AND the cron unit eventually fails cleanly.
    const FETCH_TIMEOUT_MS = 15_000
    let chunkFailures = 0
    let tagFailures = 0
    for (let i = 0; i < allTags.length; i += 50) {
      const chunk = allTags.slice(i, i + 50)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: bearer,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ tags: chunk }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        // Status-line is the authoritative signal: 200 = full success,
        // 207 = partial (body enumerates failed tags), anything else =
        // chunk failure. Body parse failures DO NOT downgrade the
        // status — a 207 with malformed body still counts as partial
        // (the route guarantees JSON on every code path, but defending
        // here means a transient response-stream corruption can't mask
        // real failures as successes).
        if (res.status === 207) {
          const parsed = await res
            .json()
            .catch(() => null) as
            | { failed?: number; failedTags?: string[] }
            | null
          const failedCount =
            typeof parsed?.failed === 'number' ? parsed.failed : chunk.length
          tagFailures += failedCount
          logError('revalidate_tags_partial', {
            chunkStart: i,
            failed: failedCount,
            failedTags: parsed?.failedTags ?? [],
            bodyParseOk: parsed !== null,
          })
        } else if (!res.ok) {
          chunkFailures += 1
          let body = ''
          try {
            body = (await res.text()).slice(0, 500)
          } catch {
            body = '<unreadable>'
          }
          logError('revalidate_tags_request_failed', {
            status: res.status,
            chunkStart: i,
            chunkSize: chunk.length,
            body,
          })
        } else {
          // 200 OK. Drain the body to release the keep-alive socket
          // cleanly; we don't actually use the response payload here.
          await res.text().catch(() => undefined)
        }
      } catch (err) {
        chunkFailures += 1
        // AbortSignal.timeout fires a DOMException with name=TimeoutError.
        // Distinguishing timeout from ECONNREFUSED/etc. is operator
        // signal — a timeout means Next is up but slow; an
        // ECONNREFUSED means PM2 is down.
        const cause = err instanceof Error ? err.message : String(err)
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError')
        logError('revalidate_tags_request_error', {
          chunkStart: i,
          chunkSize: chunk.length,
          cause,
          isTimeout,
        })
      }
      if (i + 50 < allTags.length) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    logInfo('pages_revalidate_summary', {
      totalTags: allTags.length,
      chunkFailures,
      tagFailures,
    })
    // Surface chunk-level failures (transport errors or HTTP non-2xx)
    // to the systemd OnFailure= alert by throwing — a Next pool that
    // can't accept loopback POSTs is a real outage. Tag-level partials
    // (HTTP 207) are logged but not fatal: an individual revalidateTag
    // hiccup on the receiver side is best-effort by design.
    if (chunkFailures > 0) {
      throw new Error(
        `pages-revalidate reported ${chunkFailures} chunk failure(s) — investigate`,
      )
    }
    // Escalate sustained tag-level partials. A single hiccup is
    // best-effort by design (logged not thrown), but a scenario where
    // every 207 reports ALL tags failed (broken Next tag manifest,
    // disk-full receiver, etc.) used to slip through silently because
    // chunkFailures stayed at 0. 25% across the day's run is a real
    // outage signal; below that it's noise.
    const TAG_FAIL_RATE_THRESHOLD = 0.25
    if (
      allTags.length > 0 &&
      tagFailures / allTags.length > TAG_FAIL_RATE_THRESHOLD
    ) {
      throw new Error(
        `pages-revalidate reported ${tagFailures}/${allTags.length} tag failures (>${Math.round(TAG_FAIL_RATE_THRESHOLD * 100)}%) — investigate`,
      )
    }
  }

  const [r2] = await db.execute(
    sql`DELETE FROM login_attempts
        WHERE created_at < (NOW(3) - INTERVAL ${sql.raw(String(ATT_DAYS))} DAY)`,
  )
  logInfo('login_attempts_purged', { affected: (r2 as { affectedRows?: number }).affectedRows ?? 0 })

  const [r3] = await db.execute(
    sql`DELETE FROM audit_log
        WHERE created_at < (NOW(3) - INTERVAL ${sql.raw(String(AUD_DAYS))} DAY)`,
  )
  logInfo('audit_log_purged', { affected: (r3 as { affectedRows?: number }).affectedRows ?? 0 })

  const [r4] = await db.execute(
    sql`DELETE FROM notification_failures
        WHERE resolved_at IS NOT NULL
          AND resolved_at < (NOW(3) - INTERVAL ${sql.raw(String(NTF_DAYS))} DAY)`,
  )
  logInfo('notification_failures_purged', { affected: (r4 as { affectedRows?: number }).affectedRows ?? 0 })

  const [r5] = await db.execute(
    sql`DELETE FROM pending_emails
        WHERE resolved_at IS NOT NULL
          AND resolved_at < (NOW(3) - INTERVAL ${sql.raw(String(NTF_DAYS))} DAY)`,
  )
  logInfo('pending_emails_purged', { affected: (r5 as { affectedRows?: number }).affectedRows ?? 0 })

  const [r6] = await db.execute(
    sql`DELETE FROM user_known_ips
        WHERE last_success_at < (NOW(3) - INTERVAL ${sql.raw(String(UKI_DAYS))} DAY)`,
  )
  logInfo('user_known_ips_purged', { affected: (r6 as { affectedRows?: number }).affectedRows ?? 0 })

  // CRM dispatch log retention. payload_snapshot can contain raw PII
  // (email, name, phone) for newsletter signups where lead_id=NULL
  // (no CASCADE). Trim terminal rows older than NTF_DAYS so the PII
  // window is bounded. We keep retry_scheduled / retry_in_flight /
  // pending rows regardless of age — those are live work-in-progress.
  const [r7] = await db.execute(
    sql`DELETE FROM crm_dispatch_log
        WHERE status IN ('success', 'retry_exhausted', 'retry_consumed')
          AND attempted_at < (NOW(3) - INTERVAL ${sql.raw(String(NTF_DAYS))} DAY)`,
  )
  logInfo('crm_dispatch_log_purged', { affected: (r7 as { affectedRows?: number }).affectedRows ?? 0 })
}

async function softDeleteOrphanMedia(): Promise<void> {
  // Orphan = media row whose variants column is still NULL >1h after
  // create. The pipeline's two-phase INSERT (row first, then UPDATE
  // variants after the post-rename) means a process kill between the
  // two leaves a phantom row. 1h is the worst-case tail for the
  // sharp encode (sized for the slowest -lg.webp on a 25MB JPEG).
  const [r] = await db.execute(
    sql`UPDATE media
        SET deleted_at = NOW(3)
        WHERE variants IS NULL
          AND deleted_at IS NULL
          AND created_at < (NOW(3) - INTERVAL 1 HOUR)`,
  )
  logInfo('orphan_media_soft_deleted', { affected: (r as { affectedRows?: number }).affectedRows ?? 0 })
}

interface MediaCandidate {
  id: number
  filename_uuid: string
  mime_type: string
}

async function hardDeleteUnreferencedMedia(): Promise<{ txFailed: number }> {
  let totalDbDeleted = 0
  let totalFilesUnlinked = 0
  let totalFilesMissing = 0
  let totalFilesFailed = 0
  let totalTxFailed = 0

  for (;;) {
    // Page by id ASC so we never re-scan the same candidate set after
    // the prior page is deleted. LIMIT is enforced server-side; the
    // SELECT is read-committed (no FOR UPDATE here — the per-row TX
    // re-locks inside the loop).
    const [rows] = await db.execute(
      sql`SELECT id, filename_uuid, mime_type
          FROM media
          WHERE deleted_at IS NOT NULL
            AND deleted_at < (NOW(3) - INTERVAL ${sql.raw(String(SOFT_DAYS))} DAY)
          ORDER BY id ASC
          LIMIT ${sql.raw(String(MEDIA_PURGE_BATCH))}`,
    )
    const candidates = rows as unknown as MediaCandidate[]
    if (candidates.length === 0) break

    for (const m of candidates) {
      // Per-row TX. Lock the media_references rows pointing at this
      // id (if any) and the media row itself; refuse to delete if a
      // reference exists. SELECT … FOR UPDATE on a zero-row result
      // still acquires a gap lock that blocks concurrent INSERTs of
      // the matching primary-key prefix (media_id, …) — this is the
      // race-closing property we need.
      let shouldUnlink = false
      try {
        await db.transaction(async (tx) => {
          const [refs] = await tx.execute(
            sql`SELECT 1 FROM media_references
                WHERE media_id = ${m.id}
                LIMIT 1
                FOR UPDATE`,
          )
          if ((refs as unknown as Array<unknown>).length > 0) {
            // Live reference appeared after soft-delete — leave the row
            // and the files alone. (verify-media-refs will reconcile.)
            return
          }
          await tx.execute(sql`DELETE FROM media WHERE id = ${m.id}`)
          shouldUnlink = true
        })
      } catch (err) {
        totalTxFailed += 1
        logError('media_tx_failed', {
          id: m.id,
          cause: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      if (!shouldUnlink) continue
      totalDbDeleted += 1

      for (const p of pathsForMedia(m.filename_uuid, m.mime_type)) {
        if (!isWithinUploadsRoot(p)) {
          // Defence-in-depth: refuse to touch anything outside the
          // resolved uploads root, even though the DB row is gone.
          logError('media_path_outside_root', { id: m.id, path: p })
          totalFilesFailed += 1
          continue
        }
        try {
          await unlink(p)
          totalFilesUnlinked += 1
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            // File was already gone (prior aborted run, manual cleanup,
            // or the variant was never produced — e.g. a tiny PDF has
            // no thumb). Not a failure.
            totalFilesMissing += 1
          } else {
            logError('media_unlink_failed', {
              id: m.id,
              path: p,
              code,
              cause: err instanceof Error ? err.message : String(err),
            })
            totalFilesFailed += 1
          }
        }
      }
    }

    // Defensive: if the most recent page returned fewer rows than the
    // batch size, the candidate set is drained.
    if (candidates.length < MEDIA_PURGE_BATCH) break
  }

  logInfo('media_hard_deleted', {
    dbRowsDeleted: totalDbDeleted,
    filesUnlinked: totalFilesUnlinked,
    filesMissing: totalFilesMissing,
    filesFailed: totalFilesFailed,
    txFailed: totalTxFailed,
  })

  return { txFailed: totalTxFailed }
}

// Only reap an upload FILE once it's been orphaned this long — far longer than
// any upload or sync-stage takes, so we never race an in-flight write whose
// media row hasn't committed yet.
const ORPHAN_FILE_MIN_AGE_SEC = 6 * 60 * 60

const CANONICAL_UUID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
function uuidFromUploadFile(dir: string, name: string): string | null {
  let m: RegExpMatchArray | null
  if (dir === VARIANTS_DIR) m = name.match(/^([0-9a-f-]{36})-(?:thumb|md|lg|og)\.[a-z0-9]+$/i)
  else if (dir === BROCHURES_DIR) m = name.match(/^([0-9a-f-]{36})\.pdf$/i)
  else m = name.match(/^([0-9a-f-]{36})(?:\.[a-z0-9]+)?$/i) // originals: bare uuid
  if (!m || !CANONICAL_UUID.test(m[1]!)) return null
  return m[1]!
}

// Reap upload FILES with no backing media row (any state — live OR soft-deleted).
// A process-kill mid-upload or mid-sync-stage writes the variant/PDF files BEFORE
// (or in a transaction alongside) the media row; if the row never commits, the
// files leak. The row-based purges above never see them (there's no row). Bounded
// by the same backup-fresh gate as the hard-delete, and by a generous file-age
// floor so an in-flight write is never mistaken for an orphan.
async function reapOrphanUploadFiles(): Promise<void> {
  let reaped = 0
  let failed = 0
  const nowMs = Date.now()
  for (const dir of [VARIANTS_DIR, ORIGINALS_DIR, BROCHURES_DIR]) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue // dir absent on this install
    }
    const byUuid = new Map<string, string[]>() // uuid -> filenames
    for (const name of names) {
      const uuid = uuidFromUploadFile(dir, name)
      if (!uuid) continue // unparseable name — never touch it
      const list = byUuid.get(uuid)
      if (list) list.push(name)
      else byUuid.set(uuid, [name])
    }
    const uuids = [...byUuid.keys()]
    if (uuids.length === 0) continue
    const owned = new Set<string>()
    for (let i = 0; i < uuids.length; i += 500) {
      const chunk = uuids.slice(i, i + 500)
      const [rows] = (await db.execute(
        sql`SELECT filename_uuid FROM media WHERE filename_uuid IN (${sql.join(
          chunk.map((u) => sql`${u}`),
          sql`, `,
        )})`,
      )) as unknown as [Array<{ filename_uuid: string }>]
      for (const r of rows) owned.add(r.filename_uuid)
    }
    for (const [uuid, files] of byUuid) {
      if (owned.has(uuid)) continue // a media row owns these files
      for (const name of files) {
        const p = path.join(dir, name)
        if (!isWithinUploadsRoot(p)) continue
        try {
          const st = await stat(p)
          if (nowMs - st.mtimeMs < ORPHAN_FILE_MIN_AGE_SEC * 1000) continue // too new — may be in-flight
          await unlink(p)
          reaped += 1
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed += 1
        }
      }
    }
  }
  logInfo('orphan_upload_files_reaped', { reaped, failed })
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  logInfo('started')

  await assertUploadsBackupFresh()

  await purgeSoftDeletedRows()
  await softDeleteOrphanMedia()
  const { txFailed } = await hardDeleteUnreferencedMedia()
  await reapOrphanUploadFiles()

  const durationMs = Date.now() - startedAt
  logInfo('completed', { durationMs, txFailed })

  // Surface per-row TX failures to the systemd OnFailure= alert. The
  // purge itself doesn't roll back (each row is independent), but a
  // sustained TX-failure rate means something is wrong (lock waits,
  // pool exhaustion, schema drift) and an operator should see it.
  if (txFailed > 0) {
    throw new Error(`hard-delete reported ${txFailed} TX failures — investigate`)
  }
}

try {
  await main()
} catch (err) {
  logError('fatal', {
    cause: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  process.exitCode = 1
} finally {
  // pool.end can throw if the pool was never created or has already
  // been ended; we DON'T want a cleanup failure to flip a clean run
  // into a systemd OnFailure= alert. Log + swallow.
  await pool.end().catch((err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'pool_end_failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  })
}
