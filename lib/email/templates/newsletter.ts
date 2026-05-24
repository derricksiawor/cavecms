import { escapeHtml, wrap } from '../escape'

// Double-opt-in confirmation. Two links: the primary "confirm"
// button promotes the subscriber from pending_confirmation →
// active; the secondary "didn't request this?" link unsubscribes
// (rotates the token + marks status=unsubscribed). Both URLs are
// pre-built with the same token so the recipient never has to
// type a code.
export function newsletterConfirm(
  toEmail: string,
  confirmUrl: string,
  unsubscribeUrl: string,
) {
  // footerHtml is rendered raw after the default footer paragraph,
  // not nested inside it — keeps the "Didn't request this?" block-
  // level <p> separate from the brand footer's <p>.
  const html = wrap(
    `<p>Please confirm your subscription to Best World Properties news ` +
      `and project updates:</p>` +
      `<p><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#7a5230;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px">Confirm subscription</a></p>`,
    'Best World Properties',
    `<p style="font-size:11px;color:#888;margin-top:8px">Didn't request this? ` +
      `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#888">Unsubscribe</a>.</p>`,
  )
  const text =
    `Confirm your subscription: ${confirmUrl}\n\n` +
    `Didn't request this? Unsubscribe: ${unsubscribeUrl}`
  return {
    to: toEmail,
    subject: 'Confirm your subscription',
    html,
    text,
  }
}
