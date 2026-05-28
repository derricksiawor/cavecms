import type { SectionSpec } from './types'

// Generic, brand-neutral legal-page content (Privacy Policy + Terms of
// Service) shared by EVERY install, regardless of which industry
// template the operator picks.
//
// Why this lives here (pure data, no DB import) rather than inline in
// db/seeds/systemPageBlocks.ts:
//   - The contributor `db:seed` path seeds these via systemPageBlocks.
//   - The customer install path (app/api/install/template) seeds them
//     into the preserved legal pages when they're empty. That route
//     must NOT transitively import the node DB client that
//     systemPageBlocks pulls in. Keeping the SectionSpec data in a
//     dependency-free module lets both consumers import it cleanly.
//
// The copy is deliberately placeholder scaffolding ([Your Company],
// hello@yourdomain.com, etc.) — every operator edits it to match their
// jurisdiction + the data they actually collect. Shipping populated,
// editable legal pages beats shipping two empty pages the operator
// discovers are blank only when a visitor clicks the footer link.

const PH = {
  company: '[Your Company]',
  email: 'hello@yourdomain.com',
  phone: '+1 555 0100',
  addressLong: '123 Your Street, Suite 100, Your City, State 00000',
  emailHref: 'mailto:hello@yourdomain.com',
} as const

const PRIVACY_BODY = `
<p>This page sets out what personal data ${PH.company} collects through this website, what we do with it, and the rights you have over it. Replace the placeholder copy with language that matches your jurisdiction and the data you actually collect.</p>

<h3>Who we are</h3>
<p>${PH.company} is the data controller responsible for personal data collected through this website. You can reach us at <a href="${PH.emailHref}">${PH.email}</a> or by post at ${PH.addressLong}.</p>

<h3>What we collect</h3>
<ul>
  <li><strong>Contact-form submissions:</strong> the name, email, and message you send via the contact form.</li>
  <li><strong>Newsletter subscriptions:</strong> the email address you provide.</li>
  <li><strong>Usage data:</strong> basic analytics about how visitors navigate the site (page URLs, referrer, device type, anonymised IP).</li>
  <li><strong>Cookies:</strong> we use a small number of cookies — essential ones to keep the site working and, optionally, analytics cookies you can decline.</li>
</ul>

<h3>What we do with it</h3>
<ul>
  <li><strong>Respond to enquiries</strong> you send through the contact form or by email.</li>
  <li><strong>Send newsletters</strong> only when you have opted in. Every newsletter includes a one-click unsubscribe.</li>
  <li><strong>Understand what works</strong> on the site through aggregate analytics. We do not sell your personal data to anyone.</li>
</ul>

<h3>Your rights</h3>
<p>You can request a copy of the personal data we hold about you, ask us to correct or delete it, or object to a specific use. Write to <a href="${PH.emailHref}">${PH.email}</a> and we will respond within 30 days.</p>

<h3>Sharing and storage</h3>
<p>We share personal data with the service providers we use to run this site (hosting, email delivery, analytics). We do not transfer your data outside the regions we operate in without notifying you. We keep contact-form submissions for as long as the conversation is active, and newsletter subscriptions until you unsubscribe.</p>

<h3>Updates</h3>
<p>We update this policy when our practices change. The current version is dated below; major changes will be flagged on this page.</p>
`.trim()

const TERMS_BODY = `
<p>These terms govern your use of this website operated by ${PH.company}. They sit alongside the contracts and agreements you sign with us for specific work. Replace the placeholder language with terms that match the products or services you sell.</p>

<h3>Using the site</h3>
<p>You may browse this site, share links to its pages, and quote short extracts with a clear credit. You may not republish, resell, or repackage substantial portions of our content without written permission.</p>

<h3>Content on the site</h3>
<p>Information on this site is for general guidance. Prices, examples, descriptions, and project information are invitations to discuss — they are not binding offers and do not by themselves create a contract. A contract only arises once both parties have signed a written agreement.</p>

<h3>Accuracy and changes</h3>
<p>We do our best to keep the site accurate and up to date, but we do not warrant that every piece of information is current or free from error. We may update or remove content without notice.</p>

<h3>Your information</h3>
<p>When you contact us through this site you submit personal data, which we handle according to our <a href="/privacy">Privacy Policy</a>. Please do not send confidential or sensitive material through the contact form.</p>

<h3>Intellectual property</h3>
<p>The text, images, brand marks, and code on this site belong to ${PH.company} or to the partners and rights-holders we license them from.</p>

<h3>Liability</h3>
<p>We are not liable for indirect or consequential loss arising from your use of this site. Nothing in these terms limits liability for fraud, death, or personal injury caused by negligence to the extent that the law does not allow such limits.</p>

<h3>Governing law</h3>
<p>These terms are governed by the laws applicable at our place of business. Replace this line with the jurisdiction you operate in.</p>

<h3>Contact</h3>
<p>Questions about these terms go to <a href="${PH.emailHref}">${PH.email}</a> or ${PH.phone}.</p>
`.trim()

export const PRIVACY_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Legal', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Privacy Policy', level: 'h1', size: 'display-xl', alignment: 'left', tone: 'obsidian', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: PRIVACY_BODY, size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
]

export const TERMS_SECTIONS: SectionSpec[] = [
  {
    kind: 'section',
    meta: { columns: 1, background: 'ivory', padding: 'md' },
    columns: [{ kind: 'column', widgets: [
      { kind: 'widget', blockType: 'lx_eyebrow', data: { text: 'Legal', prefix: 'none', tone: 'champagne', alignment: 'left', animation: 'fade-in' } },
      { kind: 'widget', blockType: 'lx_heading', data: { text: 'Terms of Service', level: 'h1', size: 'display-xl', alignment: 'left', tone: 'obsidian', italic: false, animation: 'slide-up' }, meta: { marginTop: 'sm' } },
      { kind: 'widget', blockType: 'lx_text', data: { body_richtext: TERMS_BODY, size: 'body-md', alignment: 'left', tone: 'obsidian', maxWidth: 'medium', animation: 'fade-in' }, meta: { marginTop: 'md' } },
    ] }],
  },
]
