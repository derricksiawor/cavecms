import { escapeHtml, safeSubjectFragment, wrap } from '../escape'

// New-teammate invite. An admin created an account for this person; this
// tells them it exists, where to sign in, and that the admin will hand
// them the starter password directly (the password is NEVER emailed —
// they choose their own at first sign-in anyway, must_rotate_password).
export function userInviteEmail(args: {
  to: string
  name: string | null
  siteName: string
  signInUrl: string
  invitedBy: string | null
}) {
  const safeSite = safeSubjectFragment(args.siteName) || 'CaveCMS'
  const safeUrl = escapeHtml(args.signInUrl)
  const greeting = args.name ? `Hi ${escapeHtml(args.name)},` : 'Hi,'
  const inviter = args.invitedBy
    ? `${escapeHtml(args.invitedBy)} created`
    : 'An administrator created'
  const inviterText = args.invitedBy
    ? `${args.invitedBy} created`
    : 'An administrator created'

  const html = wrap(
    `<h2 style="margin:0 0 16px">You now have a ${escapeHtml(safeSite)} account</h2>` +
      `<p style="margin:0 0 16px">${greeting}</p>` +
      `<p style="margin:0 0 16px">${inviter} an account for you on ${escapeHtml(
        safeSite,
      )}. Your administrator will share your starter password with you directly — it is not included in this email.</p>` +
      `<p style="margin:0 0 24px">` +
      `<a href="${safeUrl}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;` +
      `padding:12px 28px;border-radius:8px;font-weight:600">Sign in</a>` +
      `</p>` +
      `<p style="margin:0 0 8px;font-size:13px;color:#666">The starter password works once — you will choose your own the first time you sign in.</p>` +
      `<p style="margin:0;font-size:13px;color:#666">If the button does not work, copy and paste this address into your browser:<br>` +
      `<span style="word-break:break-all">${safeUrl}</span></p>`,
    safeSite,
  )

  const text =
    `You now have a ${safeSite} account\n\n` +
    `${args.name ? `Hi ${args.name},` : 'Hi,'}\n\n` +
    `${inviterText} an account for you on ${safeSite}. Your administrator will share your starter password with you directly — it is not included in this email.\n\n` +
    `Sign in:\n${args.signInUrl}\n\n` +
    `The starter password works once — you will choose your own the first time you sign in.`

  return {
    to: args.to,
    subject: `Your ${safeSite} account is ready`,
    html,
    text,
  }
}
