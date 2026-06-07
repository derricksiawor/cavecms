import { z } from 'zod'
import { RESERVED } from '@/lib/cms/page-slug'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().or(z.string().startsWith('mysql://')),
  JWT_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  PREVIEW_SECRET: z.string().min(32),
  BROCHURE_SECRET: z.string().min(32),
  // Bearer token for `/api/internal/revalidate-tags`. The cron-purge
  // script (`scripts/cron-purge.ts`) POSTs to that endpoint over loopback
  // so `revalidateTag` fires inside Next's request-context (it
  // invariant-throws from a plain Node CLI process). Separate secret
  // per project standards "Separate secrets per concern (JWT/CSRF/PREVIEW/
  // BROCHURE/INTERNAL_REVALIDATE — if one leaks, others are safe)".
  // Generate with: openssl rand -base64 64 | tr -d '\n'
  //
  // Charset restricted to printable ASCII so the route's bearer-token
  // comparison via `Buffer.from(secret)` produces a byte length that
  // equals the character length. A multi-byte UTF-8 value here would
  // make the `presented.length !== expected.length` pre-check (which
  // protects `timingSafeEqual` from throwing) behave differently than
  // intuition suggests for character-counting operators.
  INTERNAL_REVALIDATE_SECRET: z
    .string()
    .min(32)
    .regex(
      /^[\x20-\x7e]+$/,
      'INTERNAL_REVALIDATE_SECRET must be printable ASCII (matches openssl rand -base64 64 output)',
    ),
  // AES-256-GCM master key for `lib/security/secretCipher.ts` — used to
  // encrypt operator-provided secrets stored in the settings table
  // (ai_config.apiKey today; SMTP password on follow-up). Must decode
  // from base64 to exactly 32 bytes. Generate with:
  //   openssl rand -base64 32
  // Distinct from JWT/CSRF/PREVIEW/BROCHURE/INTERNAL_REVALIDATE per the
  // "separate secrets per concern" rule — if this leaks, only stored
  // settings ciphertext is exposed (and only for keys whose plaintext
  // an attacker hasn't already exfiltrated some other way). Rotating
  // requires re-entering every encrypted secret in the dashboard; the
  // helper crashes loudly on a mismatched envelope so silent corruption
  // is impossible.
  SECRETS_ENCRYPTION_KEY: z
    .string()
    // Strict base64 alphabet check first — Node's Buffer.from(...,
    // 'base64') silently strips non-base64 chars, so a copy-paste with
    // embedded whitespace would decode to a DIFFERENT 32-byte key than
    // intended. Reject any non-base64 input upfront.
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'SECRETS_ENCRYPTION_KEY must be plain base64 (no whitespace, no newlines)')
    // Then enforce exact decoded length. Buffer.from() never throws —
    // it returns whatever it could decode — so we don't wrap in try/catch.
    .refine(
      (s) => Buffer.from(s, 'base64').length === 32,
      'SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)',
    ),
  // LOGIN_PATH is the obscured admin login URL segment (e.g. `/laccess`).
  // The refinement below rejects any value that collides with the
  // page-slug RESERVED set so an admin can't accidentally configure a
  // login path that the middleware would later route to the pages CMS
  // dynamic render (spec §2.1). Fires at boot in BOTH Edge and Node
  // runtimes via the transitive load through middleware.ts →
  // lib/auth/jwt.ts → lib/env.ts.
  LOGIN_PATH: z
    .string()
    .regex(
      /^[a-z0-9-]{6,32}$/,
      'LOGIN_PATH must be 6-32 lowercase-ASCII-or-dash chars',
    )
    .refine((v) => !RESERVED.has(v.toLowerCase()), {
      message:
        'LOGIN_PATH collides with the reserved set (admin/api/blog/...)',
    }),
  // Break-glass: if set, getResolvedLoginPath() prefers this over the
  // DB-stored security_login_path. Set + restart when the operator
  // mistypes the new admin path or forgets it. Same shape constraint
  // as LOGIN_PATH so a typo can't accidentally collide with a CMS
  // slug. Documented in .notes/security-break-glass.md.
  LOGIN_PATH_OVERRIDE: z
    .string()
    .regex(/^[a-z0-9-]{6,32}$/, 'invalid_login_path_override_shape')
    .refine((v) => !RESERVED.has(v.toLowerCase()), 'collides_with_reserved')
    .optional(),
  // Break-glass: when set to '1' or 'true', the login route skips
  // reCAPTCHA verification entirely regardless of DB
  // security_recaptcha.enabledOnLogin. Use after a botched reCAPTCHA
  // key save that locks out login. The unset/empty default = false.
  SECURITY_DISABLE_LOGIN_RECAPTCHA: z
    .string()
    .optional()
    .transform((v) => v === '1' || v?.toLowerCase() === 'true'),
  // Break-glass: when set to '1' or 'true', middleware skips the IP
  // allowlist gate. Use after an IP allowlist save that excludes the
  // operator's current IP (e.g. an ISP rotation).
  SECURITY_DISABLE_IP_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) => v === '1' || v?.toLowerCase() === 'true'),
  PORT: z.coerce.number().int().default(3040),
  // JWT + CSRF lifetimes moved to `settings.session_config` (DB-
  // driven, configured via Settings → Security in the dashboard).
  // Zod-capped at 8h session / 24h absolute per the security
  // gold-standard, so an operator can't push past policy.
  DB_POOL_LIMIT: z.coerce.number().int().default(15),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(10000),
  HANDLER_TIMEOUT_MS: z.coerce.number().int().default(15000),
  // How many content-sync revert snapshots to retain (oldest pruned).
  CAVECMS_SYNC_BACKUP_KEEP: z.coerce.number().int().positive().default(10),
  // Optional bearer for /healthz verbose mode. Without it, verbose mode is
  // disabled in production. Generate with: openssl rand -hex 32
  HEALTHZ_TOKEN: z.string().min(32).optional(),
  // One-shot install-window bootstrap token (CLI-generated). Optional/legacy
  // — it only exists during the pre-install window. Routing it through the
  // schema gives it the same min-32 validation + boot duplicate-secret gate as
  // the other secrets (requireInstallToken still timing-safe-compares it).
  INSTALL_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
  // Used by healthz for build-info exposure. Set in deploy script.
  CAVECMS_COMMIT: z.string().default('unknown'),
  // Lockout tunables. Three tiers: failures-in-window → minutes-locked.
  LOCKOUT_THRESHOLDS: z.string().default('3,6,9'),
  LOCKOUT_DURATIONS_MIN: z.string().default('30,180,1440'),
  // reCAPTCHA v3.
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: z.string().optional(),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
  // Minimum acceptable score (0.0–1.0). 0.5 is the canonical threshold; for
  // Playwright runs (real browser flagged as bot) drop to 0.0 via .env override.
  RECAPTCHA_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),
  // Filesystem root for media uploads. setup.sh (Plan 09) provisions
  // {originals,variants,brochures-private,.tmp} under this path with
  // ownership `cavecms:cavecms 750`. Plan 02 media pipeline asserts every subdir
  // lives on the same filesystem (rename(2) is atomic only within an fs).
  // In production, must be absolute (refused at boot otherwise — see
  // superRefine below). Dev may point at a local writable path.
  UPLOADS_ROOT: z.string().min(1).default('/opt/cavecms/uploads'),
  // Site URL moved to `settings.site_general.siteUrl` — configured
  // via Settings → General in the dashboard, set during the install
  // wizard's "Site" step. No env fallback (rule: operators don't
  // edit .env on a public CMS).
  // Release timestamp used as sitemap.xml lastModified for static
  // paths. Pinning to a deploy-time constant (vs `new Date()` per
  // request) prevents crawlers from seeing every URL as "changed
  // every fetch" and burning crawl budget. Must parse as a valid
  // ISO 8601 date — boot fails loud on a typo'd value rather than
  // letting sitemap.xml 500 the first time it's fetched.
  CAVECMS_RELEASE_TS: z
    .string()
    .refine(
      (s) => !Number.isNaN(Date.parse(s)),
      'must_be_ISO_8601_datetime',
    )
    .default('2026-05-12T00:00:00Z'),
  // SMTP + lead-notification routing moved to `settings.smtp_config`
  // (DB-driven, configured via the Settings → Email dashboard page).
  // No env fallback — CaveCMS is a public CMS; operators don't edit
  // .env. See lib/email/transport.ts.
  // Hard cap on rows returned by /api/admin/leads/export. Each row
  // costs DB read time + ~500 bytes of stream output; 100k is the
  // safe default for a single-fork PM2 box with default heap. Ops
  // can tune up/down per environment without a redeploy.
  LEADS_EXPORT_MAX_ROWS: z.coerce.number().int().min(100).max(1_000_000).default(100_000),
  // Hard cap on rows /api/admin/newsletter/export streams. The
  // newsletter table is bounded by the unique email index (one row
  // per subscriber); 50k is the default policy ceiling. Same min/max
  // bounds as the leads export so an ops misconfiguration can't crash
  // the box.
  NEWSLETTER_EXPORT_MAX_ROWS: z.coerce.number().int().min(100).max(1_000_000).default(50_000),
}).passthrough().superRefine((e, ctx) => {
  // Both keys must be set together or both unset. A site-key-only deploy
  // would render the widget client-side but fail every server verification.
  const a = !!e.NEXT_PUBLIC_RECAPTCHA_SITE_KEY
  const b = !!e.RECAPTCHA_SECRET_KEY
  if (a !== b) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RECAPTCHA_SECRET_KEY'],
      message: 'NEXT_PUBLIC_RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY must both be set or both unset',
    })
  }
  const isBuildPhase = process.env['NEXT_PHASE'] === 'phase-production-build'
  // Loud warning (not blocking) when CAVECMS_COMMIT defaults to 'unknown' in
  // production — a deploy script that forgot to set it leaves /healthz and
  // post-mortem tooling with no way to tie a running PID to a commit.
  // Gated by !isBuildPhase so the warning fires once on the SERVER start,
  // not seven times during `next build`'s per-route static analysis.
  if (e.NODE_ENV === 'production' && !isBuildPhase && e.CAVECMS_COMMIT === 'unknown') {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'CAVECMS_COMMIT is "unknown" in production — set it in the deploy script (e.g. CAVECMS_COMMIT=$(git rev-parse --short HEAD))',
    }))
  }
  // Production refuses a relative UPLOADS_ROOT. rename(2) crossing a CWD that
  // can change under us is one stat-call away from a permanent corruption.
  if (e.NODE_ENV === 'production' && !isBuildPhase && !e.UPLOADS_ROOT.startsWith('/')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['UPLOADS_ROOT'],
      message: 'UPLOADS_ROOT must be an absolute path in production',
    })
  }
  // SMTP validation now lives at the Settings → Email save path
  // (lib/cms/settings-registry.ts smtpConfig schema + the
  // verify-before-enable gate in app/api/admin/settings/route.ts).
  // No env-time validation because there are no env-time SMTP knobs.
})

export const env = Env.parse(process.env)
export type AppEnv = typeof env

// Loud at-boot warnings for any active break-glass envs. These
// envs disable security gates by design (recovery from a botched
// settings save) but should never be "set and forgotten" — log
// them at every boot so an operator scanning startup output catches
// a stale override. Suppressed in test runs to keep the suite quiet.
if (env.NODE_ENV !== 'test') {
  if (env.LOGIN_PATH_OVERRIDE) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'security_break_glass_active',
      knob: 'LOGIN_PATH_OVERRIDE',
      value: env.LOGIN_PATH_OVERRIDE,
      note: 'DB-stored login path is shadowed. Remove this env when no longer needed.',
    }))
  }
  if (env.SECURITY_DISABLE_LOGIN_RECAPTCHA) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'security_break_glass_active',
      knob: 'SECURITY_DISABLE_LOGIN_RECAPTCHA',
      note: 'Login route is skipping reCAPTCHA verification.',
    }))
  }
  if (env.SECURITY_DISABLE_IP_ALLOWLIST) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'security_break_glass_active',
      knob: 'SECURITY_DISABLE_IP_ALLOWLIST',
      note: 'Middleware is skipping the IP allowlist gate on /admin.',
    }))
  }
}
