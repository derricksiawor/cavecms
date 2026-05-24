import { escapeHtml, safeSubjectFragment, wrap } from '../escape'

// Sales notification: brochure request landed for a specific
// project. Includes the project name so a SDR can prioritize hot
// projects on the day.
export function brochureSalesEmail(
  to: string,
  name: string,
  email: string,
  phone: string | null,
  projectName: string,
) {
  const phoneFrag = phone ? ` · ${escapeHtml(phone)}` : ''
  const html = wrap(
    `<h2 style="margin:0 0 16px">New brochure request</h2>` +
      `<p>Project: <strong>${escapeHtml(projectName)}</strong></p>` +
      `<p>${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;${phoneFrag}</p>`,
  )
  const text =
    `New brochure request\n` +
    `Project: ${projectName}\n` +
    `${name} <${email}>${phone ? ` · ${phone}` : ''}`
  return {
    to,
    subject: `Brochure: ${safeSubjectFragment(projectName)} — ${safeSubjectFragment(name)}`,
    html,
    text,
  }
}

// Delivery email to the visitor with a single-use signed download
// link. The download URL is consumed via /api/brochure/[token];
// the link expires after the configured TTL OR on first use,
// whichever comes first (CAS on brochure_token_used_at).
export function brochureDelivery(
  toName: string,
  toEmail: string,
  projectName: string,
  downloadUrl: string,
) {
  const html = wrap(
    `<p>Hi ${escapeHtml(toName)},</p>` +
      `<p>Thanks for your interest in <strong>${escapeHtml(projectName)}</strong>. ` +
      `Your brochure is ready to download:</p>` +
      `<p><a href="${escapeHtml(downloadUrl)}" style="display:inline-block;background:#7a5230;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Download brochure</a></p>` +
      `<p style="font-size:12px;color:#666">This link works once and expires in 7 days. ` +
      `If it expires, request a fresh copy from our team.</p>`,
  )
  const text =
    `Hi ${toName},\n\n` +
    `Your ${projectName} brochure is ready to download:\n\n` +
    `${downloadUrl}\n\n` +
    `This link works once and expires in 7 days.`
  return {
    to: toEmail,
    subject: `Your ${safeSubjectFragment(projectName)} brochure`,
    html,
    text,
  }
}
