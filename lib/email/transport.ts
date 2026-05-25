import 'server-only'
import type { Transporter } from 'nodemailer'
import { getSetting } from '@/lib/cms/getSettings'

// SMTP transport — DB ONLY. No env fallback.
//
// CaveCMS is a public CMS. End operators configure outbound email
// from Settings → Email in the dashboard, the same way WordPress
// operators configure SMTP plugins. Nobody edits `.env` to enable
// email — that path is for build/deploy operators, not end users.
//
// Returns `null` when `settings.smtp_config` is incomplete or
// disabled — callers (lead notifications, update alerts, password
// reset) skip the send. Pending email rows pile up in the queue
// for replay once an operator finishes the SMTP setup.

// nodemailer loaded lazily so the Edge runtime bundler doesn't
// trace its Node-only `child_process` import. `webpackIgnore: true`
// keeps webpack from following the dynamic import statically.
async function loadNodemailer(): Promise<typeof import('nodemailer')> {
  const mod = await import(/* webpackIgnore: true */ 'nodemailer')
  return mod.default ? (mod as unknown as typeof import('nodemailer')) : mod
}

export interface ResolvedSmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  password?: string
  fromAddress: string
  fromName?: string
  /** Lead-notification recipient (falls back to fromAddress when
   *  unset). Operator-configured via Settings → Email. */
  notificationRecipient?: string
}

/**
 * Resolve the active SMTP configuration from the dashboard settings.
 * Returns `null` when SMTP is disabled or incompletely configured.
 */
export async function getActiveSmtpConfig(): Promise<ResolvedSmtpConfig | null> {
  const cfg = await getSetting('smtp_config')
  if (!cfg.enabled || !cfg.host || !cfg.fromAddress) return null
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user || undefined,
    password: cfg.password || undefined,
    fromAddress: cfg.fromAddress,
    fromName: cfg.fromName || undefined,
    notificationRecipient: cfg.notificationRecipient || undefined,
  }
}

/**
 * Lead-notification recipient. Replaces the old `SALES_EMAIL` env
 * var — operator configures via Settings → Email. Falls back to the
 * SMTP From address when not set (single-mailbox deploys), and
 * returns `''` when SMTP isn't configured (callers skip the send).
 */
export async function getLeadNotificationRecipient(): Promise<string> {
  const cfg = await getActiveSmtpConfig()
  if (!cfg) return ''
  return cfg.notificationRecipient || cfg.fromAddress
}

/**
 * Build a nodemailer transporter from the active configuration.
 * Returns `null` when SMTP is not configured.
 *
 * Cached by a config-hash key on globalThis. The cache invalidates
 * automatically when the operator rotates credentials (different
 * hash → fresh build). Within the cache window, multiple sendMail
 * calls share one transporter instance — keeping nodemailer's
 * `pool: true` actually meaningful for TCP/TLS keep-alive across
 * the queue's 30-second sweeps.
 */
declare global {
  var __cavecmsMailTransporter:
    | { hash: string; transporter: Transporter }
    | null
    | undefined
}

function configHash(cfg: ResolvedSmtpConfig): string {
  // Compact deterministic hash. Don't bother with crypto — this is
  // a cache key, not a security boundary, and operators rotate
  // credentials rarely enough that collisions are an absurdity.
  return [
    cfg.host,
    cfg.port,
    cfg.secure ? '1' : '0',
    cfg.user ?? '',
    cfg.password ?? '',
    cfg.fromAddress,
  ].join('|')
}

export async function getTransporter(): Promise<Transporter | null> {
  const cfg = await getActiveSmtpConfig()
  if (!cfg) return null
  const hash = configHash(cfg)
  const cached = globalThis.__cavecmsMailTransporter
  if (cached && cached.hash === hash) {
    return cached.transporter
  }
  // Different hash → operator rotated config. Tear down the old
  // pool so its TCP connections close cleanly.
  if (cached) {
    try {
      cached.transporter.close()
    } catch {
      /* nodemailer may already be torn down */
    }
  }
  const nodemailer = await loadNodemailer()
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    // 465 = implicit TLS; 587 = STARTTLS (requireTLS); 25 = plain
    // (only sane on a trusted internal relay).
    secure: cfg.secure || cfg.port === 465,
    requireTLS: !cfg.secure && cfg.port === 587,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    // Generous timeouts — small SMTP relays (shared hosts, cheap
    // SES tiers) can take 10-12s to issue the SMTP banner under
    // load. The verify probe uses the same shape, so timeouts here
    // match what the operator already saw work during their Test
    // Connection step.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
  globalThis.__cavecmsMailTransporter = { hash, transporter }
  return transporter
}

/**
 * Resolves the `From:` header value for the active configuration.
 * Returns `null` when SMTP isn't configured. Format follows RFC 5322 —
 * `"Display Name" <email@host>` when fromName is set, else bare email.
 */
export async function getFromHeader(): Promise<string | null> {
  const cfg = await getActiveSmtpConfig()
  if (!cfg) return null
  if (cfg.fromName) {
    // Strip any quote/CRLF the operator might have typed — defends
    // against header injection from a hostile fromName value.
    const safeName = cfg.fromName.replace(/["\r\n]/g, '')
    return `"${safeName}" <${cfg.fromAddress}>`
  }
  return cfg.fromAddress
}

/**
 * Probe an SMTP candidate configuration WITHOUT persisting it.
 * Builds a one-shot nodemailer transporter from the supplied values
 * and calls `transporter.verify()`, which performs the full handshake
 * (TCP connect → STARTTLS upgrade if requested → AUTH PLAIN/LOGIN
 * with the supplied credentials). Returns `{ ok: true }` on success
 * or `{ ok: false, error }` with a stable, operator-friendly reason.
 *
 * Used by:
 *   - Settings → Email "Test connection" button (instant feedback)
 *   - Settings PATCH route — server-side gate before allowing
 *     `enabled: true` to be persisted (operator can't save broken
 *     credentials in the "on" state)
 */
export async function verifyTransport(
  cfg: Partial<ResolvedSmtpConfig>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!cfg.host || !cfg.port || !cfg.fromAddress) {
    return { ok: false, error: 'Missing host, port, or from-address.' }
  }
  let transporter
  try {
    const nodemailer = await loadNodemailer()
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure || cfg.port === 465,
      requireTLS: !cfg.secure && cfg.port === 587,
      auth: cfg.user
        ? { user: cfg.user, pass: cfg.password ?? '' }
        : undefined,
      // Implicit `pool: false` — one-shot probe, no keep-alive.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message.slice(0, 200) : 'transport_build_failed',
    }
  }
  try {
    await transporter.verify()
    return { ok: true }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // Default to a generic operator-facing message. We log the raw
    // error to the server console for debugging but NEVER echo it
    // verbatim — nodemailer's error strings can include host:port
    // and other internals that aren't safe to surface to a hostile
    // admin probing for SSRF / internal-port-scan leverage.
    let friendly = 'SMTP verification failed. Check your credentials and try again.'
    if (/EAUTH|authentication failed|invalid login|535/i.test(raw)) {
      friendly = "We connected to the server but the username or password was rejected."
    } else if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND/i.test(raw)) {
      friendly = "Couldn't reach the SMTP server. Check the host and port."
    } else if (/STARTTLS|TLS|certificate|self.signed|self-signed|UNABLE_TO_VERIFY/i.test(raw)) {
      friendly = "The server's TLS certificate didn't pass. Check your secure / port settings."
    } else {
      // Unknown error class — log the raw to server console for
      // ops debugging; operator sees the generic friendly above.
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'smtp_verify_unmatched_error',
          err: raw.slice(0, 400),
        }),
      )
    }
    return { ok: false, error: friendly }
  } finally {
    try {
      transporter?.close()
    } catch {
      /* nodemailer may already have torn the connection */
    }
  }
}

// CRLF stripping for header-bearing fields (subject, addresses).
// MIME headers terminate on CR/LF; embedding either byte lets an
// attacker inject extra headers (e.g. an additional BCC for data
// exfiltration). Every callsite that builds a subject from a lead's
// `name` should pipe through here.
export function stripCrLf(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}
