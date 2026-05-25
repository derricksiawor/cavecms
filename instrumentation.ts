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
  const g = globalThis as unknown as { __bwcCrashHandlersRegistered?: true }
  if (!g.__bwcCrashHandlersRegistered) {
    g.__bwcCrashHandlersRegistered = true
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
          'BWC uses in-memory rate-limit and email-queue state; not cluster-safe. Set instances: 1 in ecosystem.config.cjs OR migrate state to Redis.',
      }),
    )
    process.exit(1)
  }

  // __Host- cookie prefix assertion. The `__Host-` prefix is the
  // strongest browser-side defence against subdomain / domain-scope
  // cookie shadowing — a misconfigured prod box that drops the prefix
  // (NODE_ENV ≠ 'production') would mint plain `bwc_session` cookies
  // with no prefix, leaving a Cookie-Tossing attack open. Refuse to
  // boot rather than silently serving in the weaker shape.
  if (env.NODE_ENV === 'production') {
    const { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } = await import(
      '@/lib/auth/cookie-names'
    )
    if (
      !SESSION_COOKIE_NAME.startsWith('__Host-') ||
      !CSRF_COOKIE_NAME.startsWith('__Host-')
    ) {
      console.error(
        JSON.stringify({
          level: 'fatal',
          msg: 'cookie_prefix_missing',
          session: SESSION_COOKIE_NAME,
          csrf: CSRF_COOKIE_NAME,
          reason:
            'Production session / CSRF cookies must carry the __Host- prefix. Check lib/auth/cookie-names.ts IS_PROD flag.',
        }),
      )
      process.exit(1)
    }
  }

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
    const dg = globalThis as unknown as { __bwcShutdownRegistered?: true }
    if (!dg.__bwcShutdownRegistered) {
      dg.__bwcShutdownRegistered = true
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
    __bwcUpdateChecker?: ReturnType<typeof setInterval>
  }
  if (!updateSchedGlobal.__bwcUpdateChecker) {
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
    updateSchedGlobal.__bwcUpdateChecker = setInterval(async () => {
      try {
        const { getSetting } = await import('@/lib/cms/getSettings')
        const updatesCfg = await getSetting('updates')
        const state = await getSetting('updates_state')
        const intervalMs =
          (updatesCfg.checkFrequencyHours || FALLBACK_HOURS) * 60 * 60 * 1000
        const lastTs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0
        if (Number.isFinite(lastTs) && Date.now() - lastTs < intervalMs) return
        await fire()
      } catch {
        /* swallow — next tick retries. */
      }
    }, 60 * 60 * 1000)
    updateSchedGlobal.__bwcUpdateChecker.unref()
  }
}
