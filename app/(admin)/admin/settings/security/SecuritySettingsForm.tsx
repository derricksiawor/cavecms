'use client'

import { useEffect, useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/inline-edit/Switch'
import { PasswordPromptModal } from '@/components/admin/PasswordPromptModal'
import { usePasswordReauth } from '@/hooks/usePasswordReauth'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { cidrMatch, parseCidr } from '@/lib/security/ipMatch'
import { RecaptchaVerifyModal } from './RecaptchaVerifyModal'

// Per-card draft + version state. Each card is independent — a failed
// save on one card doesn't roll back successful saves on another.
// Mirrors the broader SettingsForm pattern but with custom UI per
// security key (live IP preview, verify-keys modal, pending-confirm
// banner) that the generic ZodForm widgets can't express.

interface Row {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
}

interface PendingState {
  previousPath: string
  newPath: string
  expiresAt: number
  confirmed: boolean
}

interface Props {
  initial: Row[]
  saverIp: string
  pending: PendingState | null
}

// Strongly-typed value shapes (mirrors Zod registry — duplicated here
// so the client form has compile-time guarantees without importing the
// server-only registry module).

interface LoginPathValue {
  path: string
}
interface RecaptchaValue {
  enabled: boolean
  enabledOnLogin: boolean
  version: 'v2' | 'v3'
  siteKey?: string
  secretKey?: string
  minScore: number
}
interface IpListsValue {
  allowlist: { enabled: boolean; cidrs: string[] }
  blocklist: { enabled: boolean; cidrs: string[] }
}
interface LoginThresholdsValue {
  perIpLimit: number
  perIpWindowSec: number
  perEmailLimit: number
  perEmailWindowSec: number
}
interface MaintenanceValue {
  enabled: boolean
  message: string
  bypassIps: string[]
}
interface SuspiciousValue {
  blockMissingUserAgent: boolean
  blockBotUaPatterns: boolean
  blockProbePaths: boolean
}

function byKey<T>(rows: Row[], k: string): { value: T; version: number } {
  const r = rows.find((x) => x.key === k)
  if (!r) throw new Error(`security row missing: ${k}`)
  return { value: r.value as T, version: r.version }
}

// ───────────────────────── Component ─────────────────────────

export function SecuritySettingsForm({ initial, saverIp, pending }: Props) {
  const toast = useToast()
  const reauthCtl = usePasswordReauth('Enter your password to save these changes')
  const reauth = reauthCtl.ensureReauth

  // Per-card state. Initialized from server rows once.
  const lpInit = byKey<LoginPathValue>(initial, 'security_login_path')
  const [lp, setLp] = useState<LoginPathValue>(lpInit.value)
  const [lpVer, setLpVer] = useState(lpInit.version)
  const lpPristine = useMemo(() => lpInit.value, [lpInit.value])

  const rcInit = byKey<RecaptchaValue>(initial, 'security_recaptcha')
  const [rc, setRc] = useState<RecaptchaValue>(rcInit.value)
  const [rcVer, setRcVer] = useState(rcInit.version)
  const rcPristine = useMemo(() => rcInit.value, [rcInit.value])
  const [verifyOpen, setVerifyOpen] = useState(false)
  // True after a successful verify against the CURRENT typed keys.
  // Cleared whenever the operator edits any key / version field so a
  // stale verification can't satisfy the server guard.
  const [rcVerified, setRcVerified] = useState(false)

  const ipInit = byKey<IpListsValue>(initial, 'security_ip_lists')
  const [ip, setIp] = useState<IpListsValue>(ipInit.value)
  const [ipVer, setIpVer] = useState(ipInit.version)
  const ipPristine = useMemo(() => ipInit.value, [ipInit.value])

  const thInit = byKey<LoginThresholdsValue>(initial, 'security_login_thresholds')
  const [th, setTh] = useState<LoginThresholdsValue>(thInit.value)
  const [thVer, setThVer] = useState(thInit.version)
  const thPristine = useMemo(() => thInit.value, [thInit.value])

  const mtInit = byKey<MaintenanceValue>(initial, 'security_maintenance')
  const [mt, setMt] = useState<MaintenanceValue>(mtInit.value)
  const [mtVer, setMtVer] = useState(mtInit.version)
  const mtPristine = useMemo(() => mtInit.value, [mtInit.value])

  const spInit = byKey<SuspiciousValue>(initial, 'security_suspicious_blocks')
  const [sp, setSp] = useState<SuspiciousValue>(spInit.value)
  const [spVer, setSpVer] = useState(spInit.version)
  const spPristine = useMemo(() => spInit.value, [spInit.value])

  const [busy, setBusy] = useState<string | null>(null)

  const reauthFatal = reauthCtl.fatal
  const reauthClearFatal = reauthCtl.clearFatal
  useEffect(() => {
    if (reauthFatal === 'rate_limited') {
      toast.error('Too many tries — wait a moment and try again.')
      reauthClearFatal()
    } else if (reauthFatal === 'http') {
      toast.error("We couldn't verify your password. Try again.")
      reauthClearFatal()
    }
  }, [reauthFatal, reauthClearFatal, toast])

  // Shared save helper. Each card calls save(key, value, version,
  // setNewVersion) — handles reauth + CSRF + dirty-tracking +
  // server-error mapping in one place. The 422 path surfaces the
  // server's specific error code so the operator sees a precise
  // message ("Your current IP isn't in this allowlist") instead of a
  // generic "save failed".
  async function save<T>(
    key: string,
    value: T,
    version: number,
    setNewVersion: (v: number) => void,
  ): Promise<boolean> {
    if (busy) return false
    setBusy(key)
    try {
      if (!(await reauth())) return false
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value, version }),
      })
      if (r.status === 422) {
        const j = (await r.json().catch(() => null)) as { error?: string; message?: string; saverIp?: string } | null
        const code = j?.error ?? 'invalid'
        const msg = j?.message ?? lockoutMessageFor(code, j?.saverIp ?? null)
        toast.error(msg)
        return false
      }
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return false
      }
      if (r.status === 409) {
        toast.error('Someone else just saved this in another tab. Reload to see their changes.')
        return false
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return false
      }
      setNewVersion(version + 1)
      toast.success('Saved.')
      return true
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mt-10 space-y-6">
      {/* ─── Login path card ─── */}
      <LoginPathCard
        value={lp}
        pristine={lpPristine}
        version={lpVer}
        pending={pending}
        busy={busy === 'security_login_path'}
        onChange={setLp}
        onSave={async () => {
          const ok = await save('security_login_path', lp, lpVer, setLpVer)
          if (ok) {
            // Re-render the form with the new path. The PATCH handler
            // writes the pending row; refreshing surfaces the banner.
            window.location.reload()
          }
        }}
        onDiscard={() => setLp(lpPristine)}
      />

      {/* ─── reCAPTCHA card ─── */}
      <RecaptchaCard
        value={rc}
        pristine={rcPristine}
        version={rcVer}
        verified={rcVerified}
        busy={busy === 'security_recaptcha'}
        onChange={(v) => {
          setRc(v)
          // Invalidate verification whenever any auth-relevant field
          // changes — the server guard will re-check against the new
          // (siteKeyHash, secretKeyHash, version) tuple anyway, but
          // disabling the toggle client-side avoids a confusing 422.
          if (
            v.siteKey !== rc.siteKey ||
            v.secretKey !== rc.secretKey ||
            v.version !== rc.version
          ) {
            setRcVerified(false)
          }
        }}
        onOpenVerify={() => setVerifyOpen(true)}
        onSave={() => save('security_recaptcha', rc, rcVer, setRcVer)}
        onDiscard={() => {
          setRc(rcPristine)
          setRcVerified(false)
        }}
      />
      <RecaptchaVerifyModal
        open={verifyOpen}
        version={rc.version}
        siteKey={rc.siteKey ?? ''}
        secretKey={rc.secretKey ?? ''}
        onClose={() => setVerifyOpen(false)}
        onVerified={() => {
          setRcVerified(true)
          setVerifyOpen(false)
          toast.success('Keys verified — you can enable on login now.')
        }}
      />

      {/* ─── IP allow/blocklists ─── */}
      <IpListsCard
        value={ip}
        pristine={ipPristine}
        version={ipVer}
        saverIp={saverIp}
        busy={busy === 'security_ip_lists'}
        onChange={setIp}
        onSave={() => save('security_ip_lists', ip, ipVer, setIpVer)}
        onDiscard={() => setIp(ipPristine)}
      />

      {/* ─── Login thresholds ─── */}
      <ThresholdsCard
        value={th}
        pristine={thPristine}
        version={thVer}
        busy={busy === 'security_login_thresholds'}
        onChange={setTh}
        onSave={() => save('security_login_thresholds', th, thVer, setThVer)}
        onDiscard={() => setTh(thPristine)}
      />

      {/* ─── Maintenance ─── */}
      <MaintenanceCard
        value={mt}
        pristine={mtPristine}
        version={mtVer}
        saverIp={saverIp}
        busy={busy === 'security_maintenance'}
        onChange={setMt}
        onSave={() => save('security_maintenance', mt, mtVer, setMtVer)}
        onDiscard={() => setMt(mtPristine)}
      />

      {/* ─── Suspicious-request blocks ─── */}
      <SuspiciousCard
        value={sp}
        pristine={spPristine}
        version={spVer}
        busy={busy === 'security_suspicious_blocks'}
        onChange={setSp}
        onSave={() => save('security_suspicious_blocks', sp, spVer, setSpVer)}
        onDiscard={() => setSp(spPristine)}
      />

      <PasswordPromptModal {...reauthCtl.modalProps} />
    </section>
  )
}

function lockoutMessageFor(code: string, ip: string | null): string {
  switch (code) {
    case 'SAVER_IP_NOT_IN_ALLOWLIST':
      return `Your current IP (${ip ?? 'unknown'}) isn't in this allowlist. Add it (e.g. ${ip ?? '203.0.113.1'}/32) or you'll lose access immediately.`
    case 'SAVER_IP_NOT_IN_BYPASS':
      return `Your IP (${ip ?? 'unknown'}) isn't in the bypass list. Add it or you'll see the maintenance page yourself.`
    case 'RECAPTCHA_LOGIN_VERIFICATION_REQUIRED':
      return 'Click "Test these keys" and complete the challenge before enabling reCAPTCHA on the admin login.'
    case 'LOGIN_PATH_CHANGE_IN_FLIGHT':
      return 'A previous login-path change hasn\'t been confirmed yet. Confirm or wait for auto-revert before changing again.'
    case 'invalid_cidr':
      return 'One of your CIDR entries is malformed. Fix it and try again.'
    default:
      return 'That save was rejected by the lockout-safety guard. Please review and try again.'
  }
}

// ─────────────────── per-card components ───────────────────

function CardShell({
  eyebrow,
  heading,
  help,
  dirty,
  busy,
  onSave,
  onDiscard,
  saveDisabled,
  children,
}: {
  eyebrow: string
  heading: string
  help?: string
  dirty: boolean
  busy: boolean
  onSave: () => void
  onDiscard: () => void
  saveDisabled?: boolean
  children: React.ReactNode
}) {
  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
          {eyebrow}
        </p>
        <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
          {heading}
        </h2>
        {help && (
          <p className="mt-2 max-w-2xl text-sm text-warm-stone leading-relaxed">
            {help}
          </p>
        )}
      </header>
      {/* `flex flex-col gap-5` not `space-y-5`: the Switch primitive
          renders as `inline-flex`, and Tailwind's `space-y-*` margins
          are visual no-ops on inline children — they flow horizontally
          and wrap, which is exactly the broken layout the user
          flagged. Flex column gives every child block-level flex-item
          layout regardless of display, so the same wrapper works for
          Switch / <div> / <label> / <button> alike. */}
      <div className="mt-6 flex flex-col gap-5">{children}</div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={busy || !dirty || saveDisabled}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
            Undo changes
          </Button>
        )}
        {dirty && (
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-copper-700">
            <span className="inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper" />
            Unsaved changes
          </span>
        )}
      </div>
    </article>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
      {children}
    </span>
  )
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  return <span className="mt-1 block text-[11px] text-warm-stone/80">{children}</span>
}

// ─── Login path ───

function LoginPathCard({
  value,
  pristine,
  pending,
  busy,
  onChange,
  onSave,
  onDiscard,
}: {
  value: LoginPathValue
  pristine: LoginPathValue
  version: number
  pending: PendingState | null
  busy: boolean
  onChange: (v: LoginPathValue) => void
  onSave: () => void
  onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const shapeValid = /^[a-z0-9-]{6,32}$/.test(value.path)
  const pendingInFlight = pending && !pending.confirmed && pending.expiresAt > Date.now()
  return (
    <CardShell
      eyebrow="Admin"
      heading="Login path"
      help="The hidden URL that opens the admin sign-in page. Lowercase letters, digits, and dashes — 6 to 32 characters. After saving we'll open the new URL in a new tab — confirm it loads within 10 minutes or it auto-reverts."
      dirty={dirty}
      busy={busy}
      onSave={onSave}
      onDiscard={onDiscard}
      saveDisabled={!shapeValid || !!pendingInFlight}
    >
      {pendingInFlight && (
        <div className="rounded-xl bg-copper-50 border border-copper-300/40 p-4 text-sm">
          <p className="font-semibold text-copper-800">
            Confirm the new login path is reachable
          </p>
          <p className="mt-1 text-copper-700">
            We changed the path to <code className="font-mono">/{pending.newPath}</code>.
            Open it in a new tab and click <em>Confirm it works</em> there before{' '}
            {new Date(pending.expiresAt).toLocaleTimeString()} or we&rsquo;ll
            revert to <code className="font-mono">/{pending.previousPath}</code>.
          </p>
        </div>
      )}
      <label className="block">
        <FieldLabel>Login path segment</FieldLabel>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-sm font-medium text-warm-stone">/</span>
          <Input
            value={value.path}
            onChange={(e) => onChange({ path: e.target.value.toLowerCase().trim() })}
            maxLength={32}
            placeholder="baccess"
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>
        {!shapeValid && value.path.length > 0 && (
          <FieldHelp>
            Use 6&ndash;32 lowercase letters, digits, or dashes.
          </FieldHelp>
        )}
      </label>
    </CardShell>
  )
}

// ─── reCAPTCHA ───

function RecaptchaCard({
  value,
  pristine,
  verified,
  busy,
  onChange,
  onOpenVerify,
  onSave,
  onDiscard,
}: {
  value: RecaptchaValue
  pristine: RecaptchaValue
  version: number
  verified: boolean
  busy: boolean
  onChange: (v: RecaptchaValue) => void
  onOpenVerify: () => void
  onSave: () => void
  onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  // Login toggle gated until verify has succeeded against the current
  // keys, OR the pristine value already had it enabled (operator
  // isn't flipping it ON, only re-saving the row).
  const requireVerify =
    value.enabledOnLogin &&
    (!pristine.enabledOnLogin ||
      pristine.siteKey !== value.siteKey ||
      pristine.secretKey !== value.secretKey ||
      pristine.version !== value.version)
  const keysComplete = !!value.siteKey && !!value.secretKey
  return (
    <CardShell
      eyebrow="Bots"
      heading="reCAPTCHA"
      help="Google reCAPTCHA on every public form. Enabling on the admin login is gated behind a working-keys test so wrong keys can't lock you out."
      dirty={dirty}
      busy={busy}
      onSave={onSave}
      onDiscard={onDiscard}
      saveDisabled={(value.enabled && !keysComplete) || (requireVerify && !verified)}
    >
      <div>
        <FieldLabel>Version</FieldLabel>
        <div className="mt-1.5 flex gap-2">
          {(['v3', 'v2'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange({ ...value, version: v })}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${value.version === v ? 'bg-near-black text-cream-50' : 'bg-cream-50 text-near-black border border-warm-stone/30 hover:bg-cream-100'}`}
            >
              {v === 'v3' ? 'v3 (invisible, score-based)' : 'v2 (checkbox)'}
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <FieldLabel>Site key (public)</FieldLabel>
        <Input
          className="mt-1.5"
          value={value.siteKey ?? ''}
          onChange={(e) => onChange({ ...value, siteKey: e.target.value.trim() || undefined })}
          maxLength={120}
          placeholder="6Lc…"
          spellCheck={false}
          autoCapitalize="off"
        />
      </label>
      <label className="block">
        <FieldLabel>Secret key (server)</FieldLabel>
        <Input
          className="mt-1.5"
          value={value.secretKey ?? ''}
          onChange={(e) => onChange({ ...value, secretKey: e.target.value.trim() || undefined })}
          maxLength={120}
          placeholder="6Lc…"
          spellCheck={false}
          autoCapitalize="off"
          type="password"
        />
        <FieldHelp>Stored encrypted-at-rest on the database. Never sent to browsers.</FieldHelp>
      </label>

      {value.version === 'v3' && (
        <label className="block">
          <FieldLabel>Minimum score (0.0 – 1.0)</FieldLabel>
          <Input
            className="mt-1.5"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={value.minScore}
            onChange={(e) => onChange({ ...value, minScore: Number(e.target.value) })}
          />
          <FieldHelp>0.5 is the canonical threshold. Lower for forgiving; higher for strict.</FieldHelp>
        </label>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Switch
          label="Enable on public forms"
          checked={value.enabled}
          onChange={(v) => onChange({ ...value, enabled: v, enabledOnLogin: v ? value.enabledOnLogin : false })}
          disabled={!keysComplete}
        />
        <Switch
          label="Enable on admin login"
          checked={value.enabledOnLogin}
          onChange={(v) => onChange({ ...value, enabledOnLogin: v })}
          disabled={!value.enabled || !keysComplete}
        />
      </div>

      <div className="rounded-xl bg-cream-100/60 p-4 text-sm">
        <p className="font-semibold text-near-black">Test these keys</p>
        <p className="mt-1 text-warm-stone">
          Required before turning on admin-login reCAPTCHA. Verification is
          valid for 5 minutes against these exact keys.
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-3"
          onClick={onOpenVerify}
          disabled={!keysComplete}
        >
          {verified ? '✓ Verified — re-test' : 'Test these keys'}
        </Button>
      </div>
    </CardShell>
  )
}

// ─── IP allow/blocklists ───

function IpListsCard({
  value,
  pristine,
  saverIp,
  busy,
  onChange,
  onSave,
  onDiscard,
}: {
  value: IpListsValue
  pristine: IpListsValue
  version: number
  saverIp: string
  busy: boolean
  onChange: (v: IpListsValue) => void
  onSave: () => void
  onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const allowlistIncludesSaver =
    !value.allowlist.enabled || value.allowlist.cidrs.some((c) => cidrMatch(saverIp, c))
  const anyAllowlistInvalid = value.allowlist.cidrs.some((c) => c && !parseCidr(c))
  const anyBlocklistInvalid = value.blocklist.cidrs.some((c) => c && !parseCidr(c))
  return (
    <CardShell
      eyebrow="Access"
      heading="IP allowlist & blocklist"
      help="Restrict who can reach /admin and block bad actors site-wide. Enter IPs or CIDR ranges (e.g. 203.0.113.42 or 203.0.113.0/24). Your current IP is shown below — keep it in the allowlist or you'll lose access immediately."
      dirty={dirty}
      busy={busy}
      onSave={onSave}
      onDiscard={onDiscard}
      saveDisabled={!allowlistIncludesSaver || anyAllowlistInvalid || anyBlocklistInvalid}
    >
      <div className="rounded-xl bg-cream-100/60 p-3 text-sm">
        <span className="text-warm-stone">Your current IP: </span>
        <code className="font-mono font-semibold text-near-black">{saverIp}</code>
      </div>

      {/* Allowlist */}
      <div>
        <div className="flex items-center gap-3">
          <Switch
            label="Restrict admin to listed IPs"
            checked={value.allowlist.enabled}
            onChange={(v) =>
              onChange({ ...value, allowlist: { ...value.allowlist, enabled: v } })
            }
          />
        </div>
        <p className="mt-2 text-xs text-warm-stone">
          When on, only the IPs / ranges below can reach <code>/admin</code> and
          <code> /api/admin</code>. Other IPs see 404.
        </p>
        <CidrList
          cidrs={value.allowlist.cidrs}
          maxItems={50}
          saverIp={saverIp}
          onChange={(cidrs) =>
            onChange({ ...value, allowlist: { ...value.allowlist, cidrs } })
          }
        />
        {!allowlistIncludesSaver && value.allowlist.enabled && (
          <p className="mt-2 text-xs font-medium text-red-700">
            Your IP isn&rsquo;t in this list. Saving will lock you out — add{' '}
            <code className="font-mono">{saverIp}/32</code> first.
          </p>
        )}
      </div>

      {/* Blocklist */}
      <div>
        <div className="flex items-center gap-3">
          <Switch
            label="Block listed IPs everywhere"
            checked={value.blocklist.enabled}
            onChange={(v) =>
              onChange({ ...value, blocklist: { ...value.blocklist, enabled: v } })
            }
          />
        </div>
        <p className="mt-2 text-xs text-warm-stone">
          When on, the IPs / ranges below get a 403 on every request site-wide.
        </p>
        <CidrList
          cidrs={value.blocklist.cidrs}
          maxItems={500}
          saverIp={saverIp}
          onChange={(cidrs) =>
            onChange({ ...value, blocklist: { ...value.blocklist, cidrs } })
          }
        />
      </div>
    </CardShell>
  )
}

function CidrList({
  cidrs,
  maxItems,
  saverIp,
  onChange,
}: {
  cidrs: string[]
  maxItems: number
  saverIp: string
  onChange: (cidrs: string[]) => void
}) {
  return (
    <div className="mt-3 space-y-2">
      {cidrs.map((c, i) => {
        const valid = !c || !!parseCidr(c)
        const includesSaver = !!c && valid && cidrMatch(saverIp, c)
        return (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={c}
              onChange={(e) => {
                const next = [...cidrs]
                next[i] = e.target.value.trim()
                onChange(next)
              }}
              maxLength={45}
              placeholder="203.0.113.42 or 203.0.113.0/24"
              spellCheck={false}
              autoCapitalize="off"
              className="flex-1"
            />
            <span
              className={`inline-flex h-6 min-w-[2rem] items-center justify-center rounded px-2 text-[10px] font-semibold uppercase ${valid ? (includesSaver ? 'bg-emerald-100 text-emerald-800' : 'bg-cream-100 text-warm-stone') : 'bg-red-100 text-red-800'}`}
              title={valid ? (includesSaver ? 'Includes your IP' : 'Valid CIDR') : 'Malformed CIDR'}
            >
              {valid ? (includesSaver ? '✓ you' : 'ok') : 'bad'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange(cidrs.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        )
      })}
      {cidrs.length < maxItems && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange([...cidrs, ''])}
        >
          + Add entry
        </Button>
      )}
    </div>
  )
}

// ─── Login thresholds ───

function ThresholdsCard({
  value,
  pristine,
  busy,
  onChange,
  onSave,
  onDiscard,
}: {
  value: LoginThresholdsValue
  pristine: LoginThresholdsValue
  version: number
  busy: boolean
  onChange: (v: LoginThresholdsValue) => void
  onSave: () => void
  onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  return (
    <CardShell
      eyebrow="Login"
      heading="Rate limits"
      help="How aggressively the login route locks out brute-force attempts. Bounds are conservative — you can't disable rate-limiting entirely. Lockout durations are still controlled by the deployment env LOCKOUT_DURATIONS_MIN."
      dirty={dirty}
      busy={busy}
      onSave={onSave}
      onDiscard={onDiscard}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          label="Max attempts per IP"
          value={value.perIpLimit}
          min={1}
          max={20}
          onChange={(n) => onChange({ ...value, perIpLimit: n })}
        />
        <NumberField
          label="Per-IP window (seconds)"
          value={value.perIpWindowSec}
          min={10}
          max={3600}
          onChange={(n) => onChange({ ...value, perIpWindowSec: n })}
        />
        <NumberField
          label="Max attempts per email"
          value={value.perEmailLimit}
          min={1}
          max={20}
          onChange={(n) => onChange({ ...value, perEmailLimit: n })}
        />
        <NumberField
          label="Per-email window (seconds)"
          value={value.perEmailWindowSec}
          min={10}
          max={86400}
          onChange={(n) => onChange({ ...value, perEmailWindowSec: n })}
        />
      </div>
    </CardShell>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  return (
    <label className="block">
      <FieldLabel>{label}</FieldLabel>
      <Input
        className="mt-1.5"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <FieldHelp>Range: {min}–{max}</FieldHelp>
    </label>
  )
}

// ─── Maintenance ───

function MaintenanceCard({
  value,
  pristine,
  saverIp,
  busy,
  onChange,
  onSave,
  onDiscard,
}: {
  value: MaintenanceValue
  pristine: MaintenanceValue
  version: number
  saverIp: string
  busy: boolean
  onChange: (v: MaintenanceValue) => void
  onSave: () => void
  onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const saverInBypass = value.bypassIps.some((c) => cidrMatch(saverIp, c))
  const cidrsValid = value.bypassIps.every((c) => !c || !!parseCidr(c))
  return (
    <CardShell
      eyebrow="Public"
      heading="Maintenance mode"
      help="Show a maintenance page to public visitors while you work on the site. Your IP can be added to the bypass list automatically so you keep browsing normally."
      dirty={dirty}
      busy={busy}
      onSave={onSave}
      onDiscard={onDiscard}
      saveDisabled={(value.enabled && !saverInBypass) || !cidrsValid}
    >
      <Switch
        label="Enable maintenance mode"
        checked={value.enabled}
        onChange={(v) => onChange({ ...value, enabled: v })}
      />
      <label className="block">
        <FieldLabel>Maintenance message</FieldLabel>
        <textarea
          className="mt-1.5 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black placeholder:text-warm-stone/60 transition-all focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40 min-h-[5rem] resize-y"
          maxLength={280}
          value={value.message}
          onChange={(e) => onChange({ ...value, message: e.target.value })}
          placeholder="Site under maintenance. Back shortly."
        />
      </label>
      <div>
        <FieldLabel>Bypass IPs (you can still browse)</FieldLabel>
        <CidrList
          cidrs={value.bypassIps}
          maxItems={20}
          saverIp={saverIp}
          onChange={(cidrs) => onChange({ ...value, bypassIps: cidrs })}
        />
        {value.enabled && !saverInBypass && (
          <button
            type="button"
            onClick={() => onChange({ ...value, bypassIps: [...value.bypassIps, `${saverIp}/32`] })}
            className="mt-2 text-xs font-semibold text-copper-700 underline"
          >
            + Add my IP ({saverIp}) to bypass list
          </button>
        )}
      </div>
    </CardShell>
  )
}

// ─── Suspicious blocks ───

function SuspiciousCard({
  value,
  pristine,
  busy,
  onChange,
  onSave,
  onDiscard,
}: {
  value: SuspiciousValue
  pristine: SuspiciousValue
  version: number
  busy: boolean
  onChange: (v: SuspiciousValue) => void
  onSave: () => void
  onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  return (
    <CardShell
      eyebrow="Bots"
      heading="Suspicious-request blocks"
      help="Drop obvious scanners + probe paths at the middleware before they touch any handler. The patterns are baked into the code so a typo here can't lock /admin out."
      dirty={dirty}
      busy={busy}
      onSave={onSave}
      onDiscard={onDiscard}
    >
      <Switch
        label="Block requests with no User-Agent"
        checked={value.blockMissingUserAgent}
        onChange={(v) => onChange({ ...value, blockMissingUserAgent: v })}
      />
      <Switch
        label="Block known attack-tool User-Agents (sqlmap, nikto, nuclei, …)"
        checked={value.blockBotUaPatterns}
        onChange={(v) => onChange({ ...value, blockBotUaPatterns: v })}
      />
      <Switch
        label="Block probe paths (.php, .env, wp-admin, …)"
        checked={value.blockProbePaths}
        onChange={(v) => onChange({ ...value, blockProbePaths: v })}
      />
    </CardShell>
  )
}
