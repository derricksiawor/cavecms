import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { normalizeEmail } from '@/lib/leads/normalizeEmail'
import { getTransporter, getActiveSmtpConfig, getFromHeader, stripCrLf } from './transport'
import type { PdfAttachment } from '@/lib/media/storedPdf'

// Persist-on-enqueue email queue.
//
//   1. enqueueEmail INSERTs a pending_emails row. The lead routes
//      call this AFTER committing the lead insert, so an enqueue
//      failure cannot lose the lead itself.
//   2. runOnce claims up to N due rows, sends each, and either
//      marks resolved or bumps attempts + nextRetryAt. Backoff is
//      30s → 5m → 1h; beyond the 3rd attempt, the row is left
//      claim_until=NULL with attempts >= max so the WHERE clause
//      stops picking it up.
//   3. A circuit breaker counts consecutive failures across all
//      sends. 5 in a row trips the breaker for 5 minutes; we also
//      clear claim_until on every mid-batch row at trip time so
//      the next post-breaker sweep doesn't wait an extra 60s for
//      lease expiry.
//
// When SMTP_HOST is unset (dev with no mail config) enqueueEmail
// still INSERTs — the row stays for replay once credentials land —
// but runOnce short-circuits before claim, so no ECONNREFUSED
// spam in the logs.

const BACKOFFS_SEC = [30, 300, 3600] as const
const MAX_ATTEMPTS = BACKOFFS_SEC.length + 1
const CLAIM_BATCH = 10
const CLAIM_LEASE_SEC = 60
const BREAKER_THRESHOLD = 5
const BREAKER_OPEN_MS = 5 * 60 * 1000

// Defense-in-depth caps on email body sizes — Zod validates user
// inputs at the route boundary but templates concat fields into
// HTML, so a template bug could still produce an oversize payload.
// 200K matches the body_md cap on posts; lead forms cap fields at
// 4K so realistic emails are <50K.
const EMAIL_BODY_MAX = 200_000

// Pin to globalThis so HMR doesn't reset the breaker state mid-dev.
declare global {
  var __cavecmsEmailBreaker:
    | { consecutiveFailures: number; openUntil: number }
    | undefined
  var __cavecmsEmailSweep: NodeJS.Timeout | undefined
  // Promise gate so concurrent kickers (queueMicrotask + the 30s
  // setInterval) can't both run claim() in parallel and pick up
  // overlapping batches in the same process. `undefined` when
  // idle; `Promise<void>` when in-flight. `.finally` clears it.
  var __cavecmsEmailRunOncePromise: Promise<void> | undefined
}
const breaker: { consecutiveFailures: number; openUntil: number } =
  globalThis.__cavecmsEmailBreaker ?? { consecutiveFailures: 0, openUntil: 0 }
globalThis.__cavecmsEmailBreaker = breaker

interface InsertResult {
  insertId: number
}

export interface EnqueueParams {
  to: string
  subject: string
  html: string
  text: string
  // Optional gated-PDF attachment (lx_form deliver_file `attach` mode). Carried
  // as a media-row id and resolved + streamed from disk at SEND time, so a
  // failed resolution degrades to an attachment-less send rather than blocking
  // the enqueue. NULL/undefined → an ordinary email.
  attachmentMediaId?: number
}

/**
 * INSERT a pending_emails row. Called AFTER the lead-intake row
 * commits — never inside the same TX, so an email-table failure
 * cannot lose the lead. Returns the new row's id.
 *
 * Best-effort kicks `runOnce` so a healthy SMTP gets the email out
 * in seconds rather than waiting for the next 30s sweep.
 */
export async function enqueueEmail(p: EnqueueParams): Promise<number> {
  // Body-size belt-and-braces — Zod caps user inputs at the route
  // boundary, but a template bug or runaway loop could still emit
  // an oversize payload. Refuse before storing so a single hostile
  // input can't blow up a row to 16MB (mediumtext cap).
  if (p.html.length > EMAIL_BODY_MAX || p.text.length > EMAIL_BODY_MAX) {
    throw new Error('email_body_too_large')
  }
  const subject = stripCrLf(p.subject).slice(0, 254)
  // Slice to 180 (column varchar(180)) — one extra char was being
  // truncated; aligns with Zod's max(180) email validation upstream
  // so legitimate boundary cases don't get silently shortened.
  const to = stripCrLf(p.to).slice(0, 180)
  // Dev deliverability guard. Outside production, if CAVECMS_DEV_EMAIL_ALLOWLIST
  // is set (comma-separated addresses), drop any recipient not on it so test
  // fixtures / fake domains never hit real SMTP and harm sender reputation.
  // Production is never affected; dev WITHOUT the var is never affected.
  if (process.env.NODE_ENV !== 'production' && process.env.CAVECMS_DEV_EMAIL_ALLOWLIST) {
    const allow = process.env.CAVECMS_DEV_EMAIL_ALLOWLIST.split(',')
      .map((e) => normalizeEmail(e.trim()))
      .filter(Boolean)
    if (!allow.includes(normalizeEmail(to))) {
      console.info(JSON.stringify({ level: 'info', msg: 'email_dropped_dev_allowlist', to }))
      return -1
    }
  }
  // A positive integer media id or NULL — never a fractional/zero value that
  // could resolve to the wrong row at send time.
  const attachmentMediaId =
    typeof p.attachmentMediaId === 'number' &&
    Number.isInteger(p.attachmentMediaId) &&
    p.attachmentMediaId > 0
      ? p.attachmentMediaId
      : null
  const [res] = (await db.execute(sql`
    INSERT INTO pending_emails (to_email, subject, html_body, text_body, attachment_media_id, next_retry_at)
    VALUES (${to}, ${subject}, ${p.html}, ${p.text}, ${attachmentMediaId}, NOW(3))
  `)) as unknown as [InsertResult]
  queueMicrotask(() => {
    runOnce().catch((err: unknown) => {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'email_runOnce_kick_failed',
        err: err instanceof Error ? err.message : String(err),
      }))
    })
  })
  return Number(res.insertId)
}

interface PendingEmailRow {
  id: number
  to_email: string
  subject: string
  html_body: string
  text_body: string
  attempts: number
  attachment_media_id: number | null
}

async function claim(): Promise<PendingEmailRow[]> {
  // Two-statement claim. Statement 1 atomically reserves a batch by
  // bumping claim_until; statement 2 SELECTs the rows we just owned.
  // Concurrent calls within ONE process are serialized by the
  // module-level runOnce promise gate (below). Multi-process
  // deployments would need MySQL 8 SKIP LOCKED + FOR UPDATE — the
  // single-PM2-instance deploy plan documents this constraint.
  await db.execute(sql`
    UPDATE pending_emails
    SET claim_until = DATE_ADD(NOW(3), INTERVAL ${CLAIM_LEASE_SEC} SECOND)
    WHERE id IN (
      SELECT id FROM (
        SELECT id FROM pending_emails
        WHERE resolved_at IS NULL
          AND next_retry_at <= NOW(3)
          AND (claim_until IS NULL OR claim_until < NOW(3))
          AND attempts < ${MAX_ATTEMPTS}
        ORDER BY next_retry_at, id
        LIMIT ${CLAIM_BATCH}
      ) AS t
    )
  `)
  const [rows] = (await db.execute(sql`
    SELECT id, to_email, subject, html_body, text_body, attempts, attachment_media_id
    FROM pending_emails
    WHERE claim_until > NOW(3) AND resolved_at IS NULL
    ORDER BY next_retry_at, id
    LIMIT ${CLAIM_BATCH}
  `)) as unknown as [PendingEmailRow[]]
  return rows
}

async function markFailed(
  rowId: number,
  to: string,
  attempts: number,
  err: unknown,
): Promise<void> {
  const nextAttempt = attempts + 1
  const backoff = BACKOFFS_SEC[Math.min(nextAttempt - 1, BACKOFFS_SEC.length - 1)]
  // Redact common credential-bearing fragments before persisting
  // the error message. nodemailer's transport errors do NOT include
  // passwords by default, but a relay's SMTP response line could
  // echo back the AUTH PLAIN payload on certain misconfigurations.
  // Defense-in-depth: scrub before INSERT.
  const rawMessage = String(err instanceof Error ? err.message : err)
  // Layered redaction. SMTP transcripts and nodemailer error messages
  // can echo back chunks of the AUTH exchange (PLAIN/LOGIN payloads
  // are base64-encoded credentials) and Authorization: Basic <b64>
  // headers from upstream proxies. Scrub before persisting so log
  // viewers / audit-log consumers don't widen the credential blast
  // radius.
  const redacted = rawMessage
    .replace(/AUTH\s+(?:PLAIN|LOGIN)[\s\S]{0,4}[A-Za-z0-9+/=]{16,}/gi, 'AUTH <redacted>')
    .replace(/AUTH\s+(?:PLAIN|LOGIN)\s+\S+/gi, 'AUTH <redacted>')
    .replace(/Authorization:\s*Basic\s+\S+/gi, 'Authorization: Basic <redacted>')
    .replace(/\bpass(?:word)?[=:]\s*\S+/gi, 'pass=<redacted>')
    .slice(0, 1000)
  await db.execute(sql`
    UPDATE pending_emails
    SET attempts = ${nextAttempt},
        next_retry_at = DATE_ADD(NOW(3), INTERVAL ${backoff} SECOND),
        last_error = ${redacted},
        claim_until = NULL
    WHERE id = ${rowId}
  `)
  // When the row has exhausted its retries, insert a forensic
  // notification_failures row so an operator can find the stuck
  // delivery via the audit-log dashboard (Plan 08) instead of
  // hand-scanning pending_emails for `attempts >= MAX_ATTEMPTS`.
  // The recipient is hashed so the notification ledger isn't a
  // second PII store outside the leads retention policy.
  if (nextAttempt >= MAX_ATTEMPTS) {
    // Hash the NORMALIZED recipient so operators correlating
    // `smtp_send` failures with `lead_email_enqueue_failed` rows
    // see the same fingerprint for the same human — the lead
    // routes always normalize before INSERTing, so the canonical
    // form of the address is the post-trim+lowercase string.
    const toHash = createHash('sha256').update(normalizeEmail(to)).digest('hex')
    await db
      .execute(sql`
        INSERT INTO notification_failures (kind, payload, attempts, next_retry_at)
        VALUES (
          'smtp_send',
          ${JSON.stringify({
            pending_email_id: rowId,
            to_sha256: toHash,
            attempts: nextAttempt,
            last_error: redacted,
          })},
          ${nextAttempt},
          NULL
        )
      `)
      .catch(() => {})
  }
}

async function doRunOnce(): Promise<void> {
  if (Date.now() < breaker.openUntil) return
  // SMTP config is DB-first, env-fallback. If neither is set the
  // active config resolves to null and we short-circuit — pending
  // emails stay queued for replay once the operator wires up SMTP
  // via Settings → Email.
  const activeCfg = await getActiveSmtpConfig()
  if (!activeCfg) return
  const transporter = await getTransporter()
  if (!transporter) return
  const from = (await getFromHeader()) ?? activeCfg.fromAddress

  const rows = await claim()
  for (const row of rows) {
    try {
      // Resolve an optional PDF attachment from disk. A failure to resolve
      // (soft-deleted media, oversized, or a vanished file) degrades to an
      // attachment-less send + a log line — never a failed/dead-lettered email,
      // matching the queue's best-effort ethos. The enqueue-time check already
      // validated this in the common case, so a drop here is rare.
      let attachments: PdfAttachment[] | undefined
      if (row.attachment_media_id != null) {
        const { buildPdfAttachment } = await import('@/lib/media/storedPdf')
        const att = await buildPdfAttachment(row.attachment_media_id)
        if (att) {
          attachments = [att]
        } else {
          console.error(JSON.stringify({
            level: 'error',
            msg: 'email_attachment_dropped',
            rowId: row.id,
            mediaId: row.attachment_media_id,
          }))
        }
      }
      await transporter.sendMail({
        from,
        to: row.to_email,
        subject: row.subject,
        html: row.html_body,
        text: row.text_body,
        ...(attachments ? { attachments } : {}),
      })
      await db.execute(sql`
        UPDATE pending_emails
        SET resolved_at = NOW(3), claim_until = NULL
        WHERE id = ${row.id}
      `)
      breaker.consecutiveFailures = 0
    } catch (err) {
      await markFailed(row.id, row.to_email, row.attempts, err).catch(
        (updErr: unknown) => {
          console.error(JSON.stringify({
            level: 'error',
            msg: 'email_mark_failed_update_failed',
            rowId: row.id,
            err: updErr instanceof Error ? updErr.message : String(updErr),
          }))
        },
      )
      breaker.consecutiveFailures += 1
      // Scrub recipient out of the error message before logging.
      // SMTP relays sometimes echo a case-folded or angle-bracket
      // wrapped form of the recipient; an exact-case `.split` would
      // miss those variants. Case-insensitive regex + regex-escape
      // catches the common echo shapes (`<USER@DOMAIN.COM>`, etc.).
      const rawErr = err instanceof Error ? err.message : String(err)
      const escapedTo = row.to_email.replace(/[.*+?^${}()|[\]\\<>]/g, '\\$&')
      const recipientRe = new RegExp(escapedTo, 'gi')
      const sanitized = rawErr.replace(recipientRe, '<recipient>')
      console.error(JSON.stringify({
        level: 'error',
        msg: 'email_send_failed',
        rowId: row.id,
        attempts: row.attempts + 1,
        err: sanitized,
      }))
      if (breaker.consecutiveFailures >= BREAKER_THRESHOLD) {
        breaker.openUntil = Date.now() + BREAKER_OPEN_MS
        // Release the leases on every still-claimed row so the
        // next sweep (post-breaker) picks them up immediately
        // instead of waiting for the per-row lease (~60s) to age
        // out naturally. Best-effort UPDATE; a failure here just
        // means the next sweep waits a bit longer.
        await db
          .execute(sql`
            UPDATE pending_emails
            SET claim_until = NULL
            WHERE claim_until > NOW(3) AND resolved_at IS NULL
          `)
          .catch(() => {})
        await db
          .execute(sql`
            INSERT INTO notification_failures (kind, payload, attempts, next_retry_at)
            VALUES ('smtp_breaker_open', ${JSON.stringify({
              consecutiveFailures: breaker.consecutiveFailures,
              openUntil: breaker.openUntil,
            })}, 0, NOW(3))
          `)
          .catch(() => {})
        console.error(JSON.stringify({
          level: 'error',
          msg: 'email_breaker_open',
          openMs: BREAKER_OPEN_MS,
        }))
        return
      }
    }
  }
}

/**
 * Public entry point. Serialized with a module-level promise gate
 * so concurrent callers (the per-enqueue microtask kick + the 30s
 * setInterval) share a single in-flight execution instead of
 * racing on claim() and double-sending the same row.
 *
 * Single-process semantics only — a rolling deploy where two PM2
 * workers run in parallel could still race their independent
 * gates. Documented in the queue.ts header.
 */
export async function runOnce(): Promise<void> {
  if (globalThis.__cavecmsEmailRunOncePromise) {
    return globalThis.__cavecmsEmailRunOncePromise
  }
  const p = doRunOnce().finally(() => {
    globalThis.__cavecmsEmailRunOncePromise = undefined
  })
  globalThis.__cavecmsEmailRunOncePromise = p
  return p
}

// Interval sweep — once per 30s, fires runOnce. unref()'d so it
// doesn't pin the process at shutdown. globalThis-gated so HMR
// doesn't stack timers in dev. Suppressed during `next build`
// (NEXT_PHASE=phase-production-build) — the build process imports
// route modules to extract metadata and would otherwise open DB
// connections from a non-server context.
const SWEEP_INTERVAL_MS = 30_000
const isBuildPhase = process.env['NEXT_PHASE'] === 'phase-production-build'
// Always start the sweeper in Node runtime — `doRunOnce` itself
// short-circuits when neither DB nor env SMTP config resolves, so
// the loop is harmless when email is disabled at boot AND
// automatically activates once an operator saves their SMTP
// credentials in Settings → Email (no restart needed).
if (
  process.env['NEXT_RUNTIME'] === 'nodejs' &&
  !isBuildPhase &&
  !globalThis.__cavecmsEmailSweep
) {
  globalThis.__cavecmsEmailSweep = setInterval(() => {
    runOnce().catch((err: unknown) => {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'email_sweep_failed',
        err: err instanceof Error ? err.message : String(err),
      }))
    })
  }, SWEEP_INTERVAL_MS)
  globalThis.__cavecmsEmailSweep.unref()
  // Kick once at startup so a dev reload doesn't have to wait 30s
  // for the first sweep.
  setImmediate(() => {
    runOnce().catch(() => {})
  })
}

/**
 * Graceful-drain helper. Called from instrumentation.ts's SIGTERM /
 * SIGINT handler BEFORE pool.end() — if a sweep tick fires after the
 * pool drains it would emit a spurious `email_sweep_failed` line on
 * every pm2 reload. We clear the interval, then await any in-flight
 * runOnce (bounded externally — caller wraps with raceTimeout). The
 * caller's swallow on rejection is fine.
 */
export async function stopEmailQueueSweeper(): Promise<void> {
  if (globalThis.__cavecmsEmailSweep) {
    clearInterval(globalThis.__cavecmsEmailSweep)
    globalThis.__cavecmsEmailSweep = undefined
  }
  const inflight = globalThis.__cavecmsEmailRunOncePromise
  if (inflight) {
    try {
      await inflight
    } catch {
      /* swallow — runOnce errors are already logged by its caller */
    }
  }
}
