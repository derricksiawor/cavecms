// Boot-time validation: runs once when Next starts.
// Refuses to boot if secrets are missing/short/duplicated, scrypt is too
// weak, or the deployed DB schema fingerprint disagrees with the baseline
// baked into the build.
//
// Turbopack analyzes this file for BOTH Edge and Node runtimes and emits
// cosmetic warnings about node:* imports / process.exit usage in the
// Edge build. The runtime guard at the top short-circuits the Edge
// path — no Node API is ever actually invoked there. Tried splitting
// into a separate Node-only file dispatched via Function constructor
// (defeats static analyzer) but Node's runtime resolver couldn't find
// the split file in Turbopack's chunk output. The warnings are
// effectively unsuppressible without an upstream Turbopack fix or a
// drastic refactor; leaving them as known noise.

import { env } from '@/lib/env'

// ─── Crash handler primitives ─────────────────────────────────────
// Hoisted to module scope so register() can install the handlers
// BEFORE any of the boot-time imports (lockout, fingerprint check,
// scrypt warm-up) that might throw. Pre-fix, a throw inside one of
// those awaits surfaced via Node's DEFAULT uncaught handler — bare
// stderr line, no structured `{level:'fatal'}` shape, no signal to
// PM2's log shipper or alerting rules. Now every uncaught throw
// after the very first instruction in register() routes through
// `crash()` with the canonical structured fatal log.
const isInboundHttpAbort = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false
  if (e.message !== 'aborted') return false
  if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') return false
  if (e.name !== 'Error') return false
  const stack = typeof e.stack === 'string' ? e.stack : ''
  if (!stack.includes('node:_http_server')) return false
  return stack.includes('abortIncoming') || stack.includes('socketOnClose')
}
const ABORT_BURST_THRESHOLD = 100
const ABORT_BURST_WINDOW_MS = 60_000
let abortBurstCount = 0
let abortBurstWindowStart = Date.now()
const crash = (label: string, e: unknown): void => {
  if (label === 'uncaughtException' && isInboundHttpAbort(e)) {
    const now = Date.now()
    if (now - abortBurstWindowStart > ABORT_BURST_WINDOW_MS) {
      abortBurstWindowStart = now
      abortBurstCount = 0
    }
    abortBurstCount += 1
    if (abortBurstCount > ABORT_BURST_THRESHOLD) {
      console.error(
        JSON.stringify({
          level: 'fatal',
          label: 'http_client_abort_burst',
          msg: 'inbound-HTTP-abort filter exceeded burst threshold — escalating to fatal',
          burstCount: abortBurstCount,
          windowMs: ABORT_BURST_WINDOW_MS,
          err:
            e instanceof Error
              ? { name: e.name, message: e.message, stack: e.stack }
              : String(e),
        }),
      )
      process.exit(1)
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        label: 'http_client_abort',
        burstCount: abortBurstCount,
        err: e instanceof Error ? e.message : String(e),
      }),
    )
    return
  }
  console.error(
    JSON.stringify({
      level: 'fatal',
      label,
      err:
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : String(e),
    }),
  )
  process.exit(1)
}

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return

  // Install crash handlers FIRST — before any other await. A throw in
  // the imports / fingerprint check / scrypt warm-up below would
  // otherwise route through Node's default uncaught handler with no
  // structured log shape.
  const g = globalThis as unknown as { __cavecmsCrashHandlersRegistered?: true }
  if (!g.__cavecmsCrashHandlersRegistered) {
    g.__cavecmsCrashHandlersRegistered = true
    process.on('uncaughtException', (e) => crash('uncaughtException', e))
    process.on('unhandledRejection', (e) => crash('unhandledRejection', e))
  }

  // PM2 cluster-mode refusal. lib/auth/rateLimit + lib/email/queue both
  // hold IN-MEMORY state that ASSUMES single-process semantics — rate
  // limit Map state isn't shared across workers, and the email-queue
  // runOnce gate guards against duplicate sends only within ONE process.
  // If an operator (or a future infra change) flips ecosystem.config.cjs
  // to `instances: 'max'`, those invariants silently break: rate
  // limiting halves on each worker, and the queue can double-send.
  // Refuse to boot in cluster mode rather than ship the silent failure.
  // PM2 sets NODE_APP_INSTANCE='0' for the first worker, '1' for the
  // second, etc; non-zero == cluster.
  const pmInstance = process.env['NODE_APP_INSTANCE']
  if (env.NODE_ENV === 'production' && pmInstance && pmInstance !== '0') {
    console.error(
      JSON.stringify({
        level: 'fatal',
        msg: 'pm2_cluster_refusal',
        instance: pmInstance,
        reason:
          'CaveCMS uses in-memory rate-limit and email-queue state; not cluster-safe. Set instances: 1 in ecosystem.config.cjs OR migrate state to Redis.',
      }),
    )
    process.exit(1)
  }

  // (Removed) __Host- cookie-prefix boot assertion. CaveCMS now uses
  // plain cookie names with the `Secure` attribute gated on the request
  // protocol (see lib/auth/cookie-names.ts + cookies.ts isSecureRequest).
  // The `__Host-` prefix forced `Secure`, which browsers refuse to store
  // over plain HTTP — breaking login on every http://localhost / LAN
  // install (which run NODE_ENV=production). The prefix's only unique
  // protection (rejecting a Domain-scoped same-named cookie) is relevant
  // solely to a related-domain attacker controlling a sibling subdomain;
  // every other guarantee (httpOnly, Secure-on-HTTPS, SameSite=lax,
  // host-only, signed+revocable JWT) is retained.

  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')

  // Force-import modules whose env validation throws at module-load — so
  // misconfiguration fails AT BOOT (PM2 will see an unhealthy process and
  // alert), not on the first request that happens to import the module.
  await import('@/lib/auth/lockout')
  // lib/email/queue intentionally NOT eager-loaded — see prior commits
  // for the nodemailer/stream chain rationale. Queue self-initializes on
  // first lead-route request.

  // One-shot same-fs check for the uploads tree.
  const { assertSameFs } = await import('@/lib/media/storage')
  try {
    await assertSameFs()
  } catch (e) {
    console.error(JSON.stringify({
      level: 'fatal',
      msg: 'uploads_fs_misconfig',
      err: e instanceof Error ? e.message : String(e),
    }))
    if (env.NODE_ENV === 'production') process.exit(1)
  }

  const secrets = [
    env.JWT_SECRET,
    env.CSRF_SECRET,
    env.PREVIEW_SECRET,
    env.BROCHURE_SECRET,
    env.INTERNAL_REVALIDATE_SECRET,
    env.SECRETS_ENCRYPTION_KEY,
  ]
  const seen = new Set<string>()
  for (const s of secrets) {
    if (seen.has(s)) {
      console.error('boot: refusing — duplicate secret detected (JWT/CSRF/PREVIEW/BROCHURE/INTERNAL_REVALIDATE/SECRETS_ENCRYPTION_KEY must be distinct)')
      process.exit(1)
    }
    seen.add(s)
  }

  if (env.NODE_ENV !== 'test') {
    try {
      const baselinePath = path.default.resolve(process.cwd(), 'db/schema-fingerprint.txt')
      const expected = (await readFile(baselinePath, 'utf8')).trim()
      if (!expected) {
        if (env.NODE_ENV === 'production') {
          console.error('boot: refusing — schema-fingerprint.txt is empty')
          process.exit(1)
        }
        console.warn('boot: schema-fingerprint.txt empty — skipping check (dev)')
      } else {
        const { db } = await import('@/db/client')
        const { sql } = await import('drizzle-orm')
        const [rows] = (await db.execute(
          sql`SELECT fingerprint FROM schema_fingerprint WHERE id = 1`,
        )) as unknown as [Array<{ fingerprint: string }>]
        const actual = rows[0]?.fingerprint
        if (!actual) {
          console.error('boot: refusing — schema_fingerprint row missing; run pnpm db:fingerprint')
          process.exit(1)
        }
        if (actual !== expected) {
          console.error(
            JSON.stringify({
              level: 'fatal',
              msg: 'schema_fingerprint_mismatch',
              expected,
              actual,
            }),
          )
          process.exit(1)
        }
      }
    } catch (e) {
      if (env.NODE_ENV === 'production') {
        console.error(JSON.stringify({
          level: 'fatal',
          msg: 'schema_fingerprint_check_failed',
          err: e instanceof Error ? e.message : String(e),
        }))
        process.exit(1)
      } else {
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'schema_fingerprint_check_skipped',
          err: e instanceof Error ? e.message : String(e),
        }))
      }
    }
  }

  const { scryptSync, randomBytes } = await import('node:crypto')
  const { SCRYPT_PARAMS, SCRYPT_KEY_LEN, SCRYPT_SALT_LEN } = await import('@/lib/auth/scrypt-params')
  const t0 = Date.now()
  scryptSync('boot-check', randomBytes(SCRYPT_SALT_LEN), SCRYPT_KEY_LEN, SCRYPT_PARAMS)
  const dur = Date.now() - t0
  if (dur < 50) {
    console.error(`boot: refusing — scrypt warm-up too fast (${dur}ms); parameters too weak`)
    process.exit(1)
  }

  // ─── Legacy block-type audit ───────────────────────────────────────
  // Defence-in-depth after the legacy purge (migration 0024). If any
  // content_blocks row still carries a block_type the registry no
  // longer knows about, parseBlockData would throw on render and the
  // page would 500. The audit WARNS (does not crash) so an operator
  // with a stray un-migrated row sees a structured forensic line in
  // the boot log instead of discovering the bad row from a customer
  // bug report. Skipped in dev / when the DB is unreachable — the
  // operator-facing crash-on-render still fires loudly in that case.
  try {
    if (process.env.SKIP_LEGACY_BLOCK_AUDIT !== '1') {
      const { db } = await import('@/db/client')
      const { sql } = await import('drizzle-orm')
      const { blockSchemas } = await import('@/lib/cms/block-registry')
      const knownTypes = new Set(Object.keys(blockSchemas))
      const [rows] = (await db.execute(
        sql`SELECT DISTINCT block_type FROM content_blocks WHERE kind = 'widget'`,
      )) as unknown as [Array<{ block_type: string }>]
      const unknown = rows
        .map((r) => r.block_type)
        .filter((t) => !knownTypes.has(t))
      if (unknown.length > 0) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'legacy_block_types_surviving',
            count: unknown.length,
            types: unknown.slice(0, 40),
            hint: 'Run migration 0024_legacy_block_type_to_lx or rebuild via the palette.',
          }),
        )
      }
    }
  } catch (e) {
    // Audit failure is non-fatal — the DB-reachability gate already
    // ran via the fingerprint check above. Log + continue.
    if (env.NODE_ENV === 'production') {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'legacy_block_audit_failed',
          err: e instanceof Error ? e.message : String(e),
        }),
      )
    }
  }

  // ─── One-time projects → CMS-blocks backfill (customer auto-migration) ──
  // After an update restarts the app, convert any legacy `project_sections`
  // project that still lacks a block-tree `pages` row into the new tree —
  // the customer-facing delivery of the projects→blocks feature, via the
  // SAME validated engine the dev CLI uses (parseAndSanitize per widget,
  // media checks, one TX per project). FIRE-AND-FORGET (deliberately not
  // awaited) so it never blocks boot or delays the health check: projects
  // render via the legacy branch until their tree lands, each migrating in
  // its own transaction, so a visitor hitting a project mid-backfill always
  // sees the old render OR the new one — never a half-built page.
  // Production-only — contributors migrate by hand (pnpm
  // migrate:projects-to-blocks). The runner is idempotent + cheap-guarded
  // (a single COUNT short-circuits the all-migrated no-op), so this costs
  // ~one query on every normal restart after the first successful pass.
  if (env.NODE_ENV === 'production') {
    void (async () => {
      try {
        const { runProjectsBackfillOnce } = await import(
          '@/lib/cms/runProjectsBackfillOnce'
        )
        await runProjectsBackfillOnce()
      } catch (e) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'projects_backfill_failed',
            err: e instanceof Error ? e.message : String(e),
          }),
        )
      }
    })()
  }

  // ─── One-time posts → CMS-blocks backfill (customer auto-migration) ──
  // Symmetric with the projects backfill above (spec §12). After an
  // update restarts the app, move any post whose body has not yet landed
  // on the block engine (body_page_id IS NULL) onto it — a hidden body
  // page + one lx_richtext block per post — via the SAME validated engine
  // the dev CLI uses (parseAndSanitize on the seed block, one TX per
  // post). FIRE-AND-FORGET so it never blocks boot: posts render via the
  // body_md fallback until their body page lands, each migrating in its
  // own transaction, so a visitor mid-backfill always sees the old render
  // OR the new one. Production-only — contributors migrate by hand (pnpm
  // migrate:posts-to-blocks). Idempotent + cheap-guarded (a single COUNT
  // short-circuits the all-migrated no-op), so it costs ~one query on
  // every normal restart after the first successful pass.
  if (env.NODE_ENV === 'production') {
    void (async () => {
      try {
        const { runPostsBackfillOnce } = await import(
          '@/lib/cms/runPostsBackfillOnce'
        )
        await runPostsBackfillOnce()
      } catch (e) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'posts_backfill_failed',
            err: e instanceof Error ? e.message : String(e),
          }),
        )
      }
    })()
  }

  // ─── One-time Blog-index block-tree backfill (customer auto-migration) ──
  // Migration 0034 creates the `pages.slug='blog'` system ROW, but pure SQL
  // can't author a block tree. On a fresh install the blocks come from the
  // install template; on an EXISTING install that updates, this seeds the
  // canonical BLOG_SECTIONS tree into the empty row so /blog renders instead
  // of resolving to an empty page (spec §5). Idempotent + cheap (a single
  // COUNT inside seedBlogPageBlocksIfEmpty short-circuits when the row already
  // has live blocks). FIRE-AND-FORGET so it never blocks boot. Production-only
  // — contributors seed via pnpm db:seed.
  if (env.NODE_ENV === 'production') {
    void (async () => {
      try {
        const { runBlogPageBackfillOnce } = await import(
          '@/lib/cms/runBlogPageBackfillOnce'
        )
        await runBlogPageBackfillOnce()
      } catch (e) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'blog_page_backfill_failed',
            err: e instanceof Error ? e.message : String(e),
          }),
        )
      }
    })()
  }

  // Crash handlers were installed at the top of register() — see the
  // module-scope definitions of isInboundHttpAbort + crash above.
  // Documenting the inbound-HTTP-abort filter here so the rationale
  // stays close to the surrounding scrypt warm-up + fingerprint
  // gates that operators read together:
  //   Node's HTTP server raises `Error: aborted` (ECONNRESET) on the
  //   IncomingMessage when a client RSTs the socket mid-read. With no
  //   listener attached — and Next's dev server doesn't attach one
  //   when it adapts IncomingMessage → Web Request — Node promotes it
  //   to an uncaughtException. The filter targets the EXACT Node-
  //   canonical shape (message + code + name + stack frames) so a
  //   driver-emitted ECONNRESET (mysql/SMTP peer reset, state IS
  //   unknown) can't silently match. The burst-threshold defends
  //   against Node frame-name drift: if we're swallowing more than
  //   ABORT_BURST_THRESHOLD exceptions per window, escalate the next
  //   match to fatal so operators see the regression.

  // Graceful-drain on SIGTERM / SIGINT. PM2 sends SIGTERM then
  // SIGKILL after kill_timeout (8s in ecosystem.config.cjs). Within
  // those 8s we drain the mysql2 pool so in-flight transactions can
  // roll back cleanly instead of being SIGKILL-cut mid-statement.
  // Each shutdown step is timeout-raced — a hung resource can't
  // delay process exit past PM2's kill_timeout. Production-only so
  // dev hot-reload stays snappy.
  if (env.NODE_ENV === 'production') {
    const dg = globalThis as unknown as { __cavecmsShutdownRegistered?: true }
    if (!dg.__cavecmsShutdownRegistered) {
      dg.__cavecmsShutdownRegistered = true
      const raceTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | void> =>
        Promise.race([
          p,
          new Promise<void>((resolve) => setTimeout(resolve, ms)),
        ])
      const drain = async (signal: string): Promise<never> => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'shutdown_drain_start',
            signal,
          }),
        )
        // Stop the AI proposal sweeper BEFORE closing the pool — if a
        // sweep tick fires during the drain it would hold a pool
        // connection that pool.end() then cuts mid-statement,
        // producing spurious `ai_proposal_sweep_failed` log lines on
        // every reload. stopAiProposalSweeper awaits any in-flight
        // tick (bounded at 2s so the rest of the drain fits inside
        // PM2's 8s kill_timeout).
        try {
          const { stopAiProposalSweeper } = await import('@/lib/ai/sweeper')
          await raceTimeout(stopAiProposalSweeper(), 2_500)
        } catch {
          /* swallow — sweep module may not be loaded in test mode */
        }
        // Same rationale as the AI sweeper above — if the email queue
        // sweep tick fires during pool.end() it holds a connection
        // mid-statement and the next reload's logs show a spurious
        // `email_sweep_failed` line.
        try {
          const { stopEmailQueueSweeper } = await import('@/lib/email/queue')
          await raceTimeout(stopEmailQueueSweeper(), 2_500)
        } catch {
          /* swallow — queue module may not be loaded in test mode */
        }
        try {
          const { pool } = await import('@/db/client')
          await raceTimeout(pool.end(), 3_000)
        } catch (e) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'db_pool_end_failed',
              err: e instanceof Error ? e.message : String(e),
            }),
          )
        }
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'shutdown_drain_done',
            signal,
          }),
        )
        process.exit(0)
      }
      process.on('SIGTERM', () => {
        void drain('SIGTERM')
      })
      process.on('SIGINT', () => {
        void drain('SIGINT')
      })
    }
  }

  // ─── Background update checker (WordPress-style) ───────────────
  //
  // Polls upstream every `settings.updates.checkFrequencyHours` (12
  // by default), updating the cached release info AND emailing the
  // operator if there's a new version they haven't been notified
  // about. The whole thing is contained in `backgroundScheduler.ts`
  // — we import it dynamically here so its transitive dependencies
  // (nodemailer, drizzle, etc., none of which are edge-safe) never
  // reach the edge-runtime bundle via instrumentation.ts's static
  // analysis.
  //
  // PM2 cluster-mode is refused at line 112-123, so we don't worry
  // about two workers both firing the check.
  const updateSchedGlobal = globalThis as unknown as {
    __cavecmsUpdateChecker?: ReturnType<typeof setInterval>
  }
  if (!updateSchedGlobal.__cavecmsUpdateChecker) {
    // First fire: 30s after boot so DB pool / route handlers settle
    // before we make outbound network calls.
    const FIRST_FIRE_MS = 30_000
    const FALLBACK_HOURS = 12
    const fire = async (): Promise<void> => {
      try {
        // Dynamic import — Next.js can split this off into a
        // separate chunk that ONLY loads at runtime under Node.
        // nodemailer (transitive) is declared in
        // `serverExternalPackages` in next.config.ts so the Edge
        // bundler doesn't try to follow it.
        const mod = await import('@/lib/updates/backgroundScheduler')
        await mod.runUpdateCheck()
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'update_check_loop_failed',
            err:
              err instanceof Error
                ? err.message.slice(0, 200)
                : String(err).slice(0, 200),
          }),
        )
      }
    }
    setTimeout(() => {
      void fire()
    }, FIRST_FIRE_MS)
    // Subsequent fires: read frequency dynamically each tick so a
    // dashboard change takes effect without restart. We tick every
    // hour and bail inside if we're still within the configured
    // window since lastCheckedAt.
    updateSchedGlobal.__cavecmsUpdateChecker = setInterval(async () => {
      try {
        const { getSetting } = await import('@/lib/cms/getSettings')
        const updatesCfg = await getSetting('updates')
        const state = await getSetting('updates_state')
        const intervalMs =
          (updatesCfg.checkFrequencyHours || FALLBACK_HOURS) * 60 * 60 * 1000
        const lastTs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0
        if (Number.isFinite(lastTs) && Date.now() - lastTs < intervalMs) return
        await fire()
      } catch (err) {
        // Log a structured warning so a sustained DB outage / settings-
        // table corruption shows up in the operator's logs instead of
        // silently swallowing every tick. Next tick still retries.
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'update_check_tick_failed',
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }, 60 * 60 * 1000)
    updateSchedGlobal.__cavecmsUpdateChecker.unref()
  }

  // ─── Scheduled-backup ticker ───────────────────────────────────
  //
  // Mirror of the update checker: an hourly in-process tick that runs a backup
  // when `settings.backups.schedule` (off|daily|weekly) says it's due and no
  // other op holds the shared lock. Paired with a systemd timer
  // (scripts/systemd/cavecms-backup-run.timer) hitting the loopback
  // /api/internal/backups/trigger-scheduled endpoint so a Node restart never
  // misses a window. The scheduler claims each occurrence before spawning, so
  // the in-process tick + the systemd trigger can't double-fire. Dynamic import
  // keeps the backup engine's transitive deps out of the edge bundle. PM2
  // cluster-mode is refused upstream, so only one worker ticks.
  const backupSchedGlobal = globalThis as unknown as {
    __cavecmsBackupScheduler?: ReturnType<typeof setInterval>
  }
  if (!backupSchedGlobal.__cavecmsBackupScheduler) {
    // First fire 90s after boot — staggered after the update checker (+30s) and
    // the AI sweeper (+60s) so the three don't contend at startup.
    const BACKUP_FIRST_FIRE_MS = 90_000
    const fireBackup = async (): Promise<void> => {
      try {
        const mod = await import('@/lib/backups/scheduler')
        await mod.runBackupTickIfDue()
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'backup_schedule_loop_failed',
            err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          }),
        )
      }
    }
    setTimeout(() => {
      void fireBackup()
    }, BACKUP_FIRST_FIRE_MS)
    backupSchedGlobal.__cavecmsBackupScheduler = setInterval(() => {
      void fireBackup()
    }, 60 * 60 * 1000)
    backupSchedGlobal.__cavecmsBackupScheduler.unref()
  }

  // ─── AI proposal lifecycle sweeper (PR 5) ──────────────────────
  //
  // Two responsibilities on a 5-min tick: flip pending → expired past
  // expires_at, and hard-delete terminal-status rows older than 7
  // days so the table stays small. Implementation + structured logs
  // live in lib/ai/sweeper.ts — kept as a separate module so the
  // integration test can invoke sweepExpiredProposals() directly.
  //
  // PM2 cluster-mode is refused upstream so two workers can't both
  // sweep concurrently. NODE_ENV='test' opts out so the vitest pool
  // doesn't spawn timers in every child worker.
  if (env.NODE_ENV !== 'test') {
    const { startAiProposalSweeper } = await import('@/lib/ai/sweeper')
    startAiProposalSweeper()
  }
}
