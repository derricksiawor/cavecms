import { escapeHtml, safeSubjectFragment, wrap } from '../escape'

// Password-reset link email. An admin issued a one-time link for a
// locked-out user; this delivers it. Outcome-led, plain, no jargon.
// resetUrl is an absolute https URL built from the operator's Site URL.
export function passwordResetEmail(
  to: string,
  resetUrl: string,
  siteName: string,
) {
  const safeName = safeSubjectFragment(siteName) || 'CaveCMS'
  const safeUrl = escapeHtml(resetUrl)

  const html = wrap(
    `<h2 style="margin:0 0 16px">Set a new password</h2>` +
      `<p style="margin:0 0 16px">An administrator generated a link for you to choose a new password for your ${escapeHtml(
        safeName,
      )} account. Use the button below to set it.</p>` +
      `<p style="margin:0 0 24px">` +
      `<a href="${safeUrl}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;` +
      `padding:12px 28px;border-radius:8px;font-weight:600">Choose a new password</a>` +
      `</p>` +
      `<p style="margin:0 0 8px;font-size:13px;color:#666">This link works once and expires in 60 minutes.</p>` +
      `<p style="margin:0;font-size:13px;color:#666">If the button does not work, copy and paste this address into your browser:<br>` +
      `<span style="word-break:break-all">${safeUrl}</span></p>` +
      `<p style="margin:16px 0 0;font-size:13px;color:#666">If you were not expecting this, you can ignore this email and your password stays the same.</p>`,
    safeName,
  )

  const text =
    `Set a new password\n\n` +
    `An administrator generated a link for you to choose a new password for your ${safeName} account.\n\n` +
    `Choose a new password:\n${resetUrl}\n\n` +
    `This link works once and expires in 60 minutes.\n\n` +
    `If you were not expecting this, you can ignore this email and your password stays the same.`

  return {
    to,
    subject: `Set a new password for your ${safeName} account`,
    html,
    text,
  }
}
