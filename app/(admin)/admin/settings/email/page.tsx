import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry } from '@/lib/cms/settings-registry'
import { EmailSettingsClient } from './EmailSettingsClient'

// Admin-only SMTP / outbound email configuration.
//
// Used by: lead notification emails, password-reset flow (future),
// update-available notifications (Settings → Updates).
//
// Credential redaction: the SMTP password is stripped from the
// payload on the server before reaching the client form. The form
// shows "Password saved — replace?" when a value is on file; an
// empty input on save means "keep the existing password" (the
// PATCH route preserves the stored value). Mirrors the HubSpot
// privateAppAccessToken and Zoho OAuth-secret pattern in
// `app/(admin)/admin/settings/integrations/page.tsx`.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
}

export default async function EmailSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    WHERE \`key\` = 'smtp_config'
    LIMIT 1
  `)) as unknown as [SettingRow[]]

  const synthesizedNow = new Date()
  const raw = rows[0]
  const parsedValue =
    raw && typeof raw.value === 'string'
      ? (() => {
          try {
            return JSON.parse(raw.value as string)
          } catch {
            return registry.smtp_config.default
          }
        })()
      : (raw?.value ?? registry.smtp_config.default)

  // Server-side credential redaction. Strip password before the row
  // ever reaches the client bundle.
  const passwordOnFile =
    !!parsedValue &&
    typeof parsedValue === 'object' &&
    typeof (parsedValue as { password?: unknown }).password === 'string' &&
    ((parsedValue as { password: string }).password.length > 0)
  const redacted =
    parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
      ? { ...(parsedValue as Record<string, unknown>), password: '' }
      : parsedValue

  const initial = {
    key: 'smtp_config' as const,
    value: redacted,
    version: raw?.version ?? 0,
    updatedAt:
      raw?.updated_at instanceof Date
        ? raw.updated_at.toISOString()
        : typeof raw?.updated_at === 'string'
          ? raw.updated_at
          : synthesizedNow.toISOString(),
    passwordOnFile,
  }

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Email
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Connect a transactional email provider (SendGrid, Mailgun, AWS SES,
        Postmark, etc.) so CaveCMS can send lead notifications, password
        reset links, and update alerts to you.
      </p>

      <EmailSettingsClient initial={initial} />
    </div>
  )
}
