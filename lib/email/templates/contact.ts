import { escapeHtml, safeSubjectFragment, wrap } from '../escape'

// Sales notification: lead landed via the /contact form. Every
// piece of user-supplied data flows through escapeHtml before
// concatenation — defense against HTML injection in the
// notification surface (sales reads this email; an injected
// <script> wouldn't execute but a malicious form-action could
// imitate an internal tool).
export function contactSalesEmail(
  to: string,
  name: string,
  email: string,
  phone: string,
  enquiryType: 'enquiry' | 'tour' | 'brochure',
  message: string | null,
  tourDate: string | null,
  tourTime: string | null,
  brochureProject: string | null,
) {
  let detailHtml = ''
  let detailText = ''

  if (enquiryType === 'tour') {
    const when = [tourDate, tourTime].filter(Boolean).join(' at ')
    detailHtml = `<p><strong>Tour request:</strong> ${escapeHtml(when)}</p>`
    detailText = `Tour request: ${when}\n`
  } else if (enquiryType === 'brochure') {
    detailHtml = `<p><strong>Brochure request:</strong> ${escapeHtml(brochureProject ?? '')}</p>`
    detailText = `Brochure request: ${brochureProject ?? ''}\n`
  }

  const messageFrag = message
    ? `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`
    : ''
  const messageText = message ? `\n${message}` : ''

  const html = wrap(
    `<h2 style="margin:0 0 16px">New contact lead</h2>` +
      `<p><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt; · ${escapeHtml(phone)}</p>` +
      detailHtml +
      messageFrag,
  )
  const text =
    `New contact lead\n\n` +
    `${name} <${email}> · ${phone}\n` +
    detailText +
    messageText

  return {
    to,
    subject: `New contact: ${safeSubjectFragment(name)}`,
    html,
    text,
  }
}

// Acknowledge to the visitor. Plain template so the sales team can
// follow up however they prefer without the auto-reply over-
// committing on response time.
export function contactAutoReply(toName: string, toEmail: string) {
  const html = wrap(
    `<p>Hi ${escapeHtml(toName)},</p>` +
      `<p>Thanks for reaching out to Best World Properties. ` +
      `We've received your message and will be in touch shortly.</p>`,
  )
  const text =
    `Hi ${toName},\n\n` +
    `Thanks for reaching out to Best World Properties. ` +
    `We've received your message and will be in touch shortly.`
  return {
    to: toEmail,
    subject: 'Thanks for contacting Best World Properties',
    html,
    text,
  }
}
