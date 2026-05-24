import { escapeHtml, safeSubjectFragment, wrap } from '../escape'

// Sales notification: project-specific inquiry. Pulls the
// project name through so the assigned sales rep can pick up the
// thread without cross-referencing the lead ID.
export function inquirySalesEmail(
  to: string,
  name: string,
  email: string,
  phone: string | null,
  message: string,
  projectName: string,
) {
  const phoneFrag = phone ? ` · ${escapeHtml(phone)}` : ''
  const html = wrap(
    `<h2 style="margin:0 0 16px">New project inquiry — ${escapeHtml(projectName)}</h2>` +
      `<p>${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;${phoneFrag}</p>` +
      `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
  )
  const text =
    `New project inquiry — ${projectName}\n` +
    `${name} <${email}>${phone ? ` · ${phone}` : ''}\n\n` +
    `${message}`
  return {
    to,
    subject: `Inquiry: ${safeSubjectFragment(projectName)} — ${safeSubjectFragment(name)}`,
    html,
    text,
  }
}

export function inquiryAutoReply(
  toName: string,
  toEmail: string,
  projectName: string,
) {
  const html = wrap(
    `<p>Hi ${escapeHtml(toName)},</p>` +
      `<p>Thanks for your interest in <strong>${escapeHtml(projectName)}</strong>. ` +
      `A member of our sales team will reach out soon.</p>`,
  )
  const text =
    `Hi ${toName},\n\n` +
    `Thanks for your interest in ${projectName}. ` +
    `A member of our sales team will reach out soon.`
  return {
    to: toEmail,
    subject: `We received your inquiry — ${safeSubjectFragment(projectName)}`,
    html,
    text,
  }
}
