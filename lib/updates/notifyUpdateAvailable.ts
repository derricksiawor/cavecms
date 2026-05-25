import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { getSetting } from '@/lib/cms/getSettings'
import {
  getTransporter,
  getFromHeader,
  stripCrLf,
} from '@/lib/email/transport'
import { humaniseRelease, type HumanRelease } from './humaniseRelease'
import { escapeHtml } from '@/lib/email/escape'
import { getSiteOrigin, getSiteName } from '@/lib/cms/getSiteOrigin'

// Send a friendly "new version available" email to the operator's
// configured notification address. Idempotent against the
// `settings.updates_state.lastNotifiedSha` cursor — if we already
// emailed about this release, we no-op so a 12-hourly cron doesn't
// spam the operator's inbox.

interface Raw {
  sha: string
  ts: string
  changelog: string
  isSecurity: boolean
}

export async function notifyUpdateAvailable(latest: Raw): Promise<{
  sent: boolean
  reason?:
    | 'no_email_configured'
    | 'no_smtp'
    | 'no_site_url'
    | 'already_notified'
    | 'send_failed'
}> {
  const updatesCfg = await getSetting('updates')
  const recipient = updatesCfg.notificationEmail
  if (!recipient) {
    return { sent: false, reason: 'no_email_configured' }
  }

  const state = await getSetting('updates_state')
  if (state.lastNotifiedSha && latest.sha.startsWith(state.lastNotifiedSha)) {
    return { sent: false, reason: 'already_notified' }
  }

  // Site URL — required for the "Review and install" button URL.
  // No env fallback: operator MUST configure their own site URL
  // via Settings → General before update emails will fire. This
  // prevents one operator's CaveCMS from sending emails with links
  // to another operator's domain (e.g., the open-source default
  // could otherwise leak the project's staging URL).
  const siteOrigin = await getSiteOrigin()
  if (!siteOrigin) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'update_notify_no_site_url',
        note: 'Set Settings → General → Site URL before update emails can be sent.',
      }),
    )
    return { sent: false, reason: 'no_site_url' }
  }
  const siteName = await getSiteName()

  const transporter = await getTransporter()
  if (!transporter) {
    return { sent: false, reason: 'no_smtp' }
  }
  const from = await getFromHeader()
  if (!from) {
    return { sent: false, reason: 'no_smtp' }
  }

  const human: HumanRelease = humaniseRelease(latest)
  const updatesUrl = `${siteOrigin}/admin/settings/updates`

  const subject = stripCrLf(
    human.isSecurity
      ? `[Security] ${siteName} — update available`
      : `${siteName} — update available`,
  )

  const heading = human.isSecurity
    ? 'A security update is available'
    : 'A new version of CaveCMS is available'

  const text = [
    heading,
    '',
    human.title,
    `${human.versionLabel} · ${human.releasedAbsolute}`,
    '',
    human.body || '',
    '',
    `Review and install: ${updatesUrl}`,
    '',
    'You are receiving this because Email is configured under Settings → Updates.',
  ]
    .filter(Boolean)
    .join('\n')

  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1f1d1b;">
  <p style="font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${human.isSecurity ? '#b91c1c' : '#b87333'}; margin: 0 0 12px;">
    ${human.isSecurity ? 'Security update available' : 'Update available'}
  </p>
  <h1 style="font-family: Georgia, serif; font-size: 24px; line-height: 1.25; margin: 0 0 8px;">
    ${escapeHtml(human.title)}
  </h1>
  <p style="font-size: 13px; color: #8a7e74; margin: 0 0 24px;">
    ${escapeHtml(human.versionLabel)} · ${escapeHtml(human.releasedAbsolute)}
  </p>
  ${
    human.body
      ? `<div style="font-size: 14px; line-height: 1.6; white-space: pre-line; margin-bottom: 24px;">${escapeHtml(human.body)}</div>`
      : ''
  }
  <p style="margin: 32px 0;">
    <a href="${escapeHtml(updatesUrl)}" style="display: inline-block; background: #1f1d1b; color: #faf6f0; padding: 12px 24px; text-decoration: none; font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; font-weight: 600; border-radius: 999px;">
      Review and install
    </a>
  </p>
  <p style="font-size: 11px; color: #8a7e74; border-top: 1px solid #e5dfd6; padding-top: 16px; margin-top: 32px;">
    You're receiving this because an email address is set under Settings → Updates.
  </p>
</body></html>`

  // Claim-then-send: write lastNotifiedSha BEFORE attempting the
  // send. If the send fails, we lose this release's email but
  // never double-send — the operator's update banner still shows
  // the available release on every admin page load, so the email
  // is best-effort sugar on top of the canonical UI signal.
  //
  // Without this claim ordering, a crash between sendMail() and
  // the state write would leave lastNotifiedSha unchanged and the
  // next 12-hourly poll would re-send the same release email.
  // SMTP relays don't dedupe identical bodies; the operator would
  // get two notifications for one release.
  const now = new Date().toISOString()
  const newState = {
    ...state,
    lastNotifiedSha: latest.sha,
    lastNotifiedAt: now,
  }
  await db.execute(sql`
    INSERT INTO settings (\`key\`, value, version, updated_by)
    VALUES ('updates_state', ${JSON.stringify(newState)}, 1, NULL)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      version = version + 1
  `)

  try {
    await transporter.sendMail({
      from,
      to: recipient,
      subject,
      text,
      html,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'update_notify_send_failed',
        err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      }),
    )
    return { sent: false, reason: 'send_failed' }
  }

  // Forensic audit trail.
  await db.insert(auditLog).values({
    userId: null,
    action: 'notify',
    resourceType: 'updates',
    resourceId: latest.sha.slice(0, 12),
    diff: { recipient, isSecurity: latest.isSecurity },
  })

  return { sent: true }
}
