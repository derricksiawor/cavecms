import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { registry, type SettingsKey } from '@/lib/cms/settings-registry'
import { SecuritySettingsForm } from './SecuritySettingsForm'

// Admin-only security configuration. Six independent settings keys,
// each with its own card + save + reauth flow. Server component reads
// all six keys + the operator's detected IP (used for lockout-safety
// previews — "your CIDR list must include 203.0.113.42 or save will
// fail"). The form is custom (not the generic SettingsForm) because
// each card needs cross-field validation surfaces (verify-recaptcha
// modal, IP allowlist live-check, pending-login-path confirm banner).

const SECURITY_KEYS: SettingsKey[] = [
  'security_login_path',
  'security_recaptcha',
  'security_ip_lists',
  'security_login_thresholds',
  'security_maintenance',
  'security_suspicious_blocks',
]

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date
}

interface PendingRow {
  previous_path: string
  new_path: string
  expires_at: Date | string
  confirmed_at: Date | string | null
}

export default async function SecuritySettingsPage() {
  await requireRoleOrRedirect(['admin'])

  // Read all security_* rows in one query; missing rows surface as
  // synthesized {version:0, value: registry.default} entries so the
  // form can save them on first edit (PATCH route handles the INSERT
  // path when version=0). Order isn't important — the form arranges
  // cards in its own order.
  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    WHERE \`key\` LIKE 'security\\_%'
    ORDER BY \`key\`
  `)) as unknown as [SettingRow[]]

  const parsed = rawRows.map((r) => ({
    ...r,
    value:
      typeof r.value === 'string'
        ? (() => {
            try {
              return JSON.parse(r.value as string)
            } catch {
              return r.value
            }
          })()
        : r.value,
  }))

  // Credential redaction — strip `security_recaptcha.secretKey`
  // server-side before the value reaches the client form. Mirrors
  // the HubSpot / Zoho CRM / SMTP redaction pattern: the form
  // arrives with an empty string and re-submits as empty when the
  // operator doesn't touch the input; the PATCH route's credential-
  // preserving merge restores the stored value at write time so the
  // saved secret is never clobbered.
  function redactRecaptchaSecret(row: SettingRow): SettingRow {
    if (row.key !== 'security_recaptcha') return row
    if (!row.value || typeof row.value !== 'object') return row
    const v = { ...(row.value as Record<string, unknown>) }
    if (typeof v.secretKey === 'string' && (v.secretKey as string).length > 0) {
      v.secretKey = ''
    }
    return { ...row, value: v }
  }

  const byKey = new Map(parsed.map((r) => [r.key, r]))
  const synthesizedNow = new Date()
  const rows = SECURITY_KEYS.map((k) => {
    const existing = byKey.get(k)
    if (existing) return redactRecaptchaSecret(existing)
    return {
      key: k,
      value: registry[k].default,
      version: 0,
      updated_at: synthesizedNow,
    }
  })

  // Pending login-path row (if any) — banner copy depends on whether
  // a confirm-or-revert is in flight. Singleton with id=1.
  const [pendingRows] = (await db.execute(sql`
    SELECT previous_path, new_path, expires_at, confirmed_at
    FROM security_login_path_pending
    WHERE id = 1
  `)) as unknown as [PendingRow[]]
  const pendingRaw = pendingRows[0] ?? null
  const pending = pendingRaw
    ? {
        previousPath: pendingRaw.previous_path,
        newPath: pendingRaw.new_path,
        expiresAt:
          typeof pendingRaw.expires_at === 'string'
            ? new Date(pendingRaw.expires_at).getTime()
            : pendingRaw.expires_at.getTime(),
        confirmed: pendingRaw.confirmed_at !== null,
      }
    : null

  // Saver's detected IP. Drives the "your IP" preview in the IP-list
  // and maintenance cards so the operator can see at a glance whether
  // their proposed CIDR includes them. Read from the SAME helper the
  // PATCH guard uses so what shows here == what the guard sees.
  const h = await headers()
  const headerObj: Record<string, string | undefined> = {}
  h.forEach((v, k) => {
    headerObj[k] = v
  })
  const saverIp = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Security
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Your admin login path, bot protection on every form, the IPs allowed
        to reach the admin, login rate-limits, and maintenance mode.
        We&rsquo;ll ask for your password before any change goes live, and
        each card has its own &ldquo;you can&rsquo;t lock yourself out&rdquo;
        guard.
      </p>
      <SecuritySettingsForm
        initial={rows}
        saverIp={saverIp}
        pending={pending}
      />
    </div>
  )
}
