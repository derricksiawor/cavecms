// Required legal notice when the reCAPTCHA v3 badge is hidden via CSS.
// Per Google's Branding Guidelines, hiding the badge is allowed only if
// every form displays this text with the two links below.
// https://developers.google.com/recaptcha/docs/faq#id-like-to-hide-the-recaptcha-badge.-what-is-allowed

export function RecaptchaNotice({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[11px] font-medium leading-relaxed text-near-black/55 tracking-wide ${className}`.trim()}>
      Protected by reCAPTCHA — Google&apos;s{' '}
      <a
        href="https://policies.google.com/privacy"
        target="_blank"
        rel="noopener noreferrer"
        className="text-copper-600 transition-colors hover:text-copper-700"
      >
        Privacy Policy
      </a>{' '}
      and{' '}
      <a
        href="https://policies.google.com/terms"
        target="_blank"
        rel="noopener noreferrer"
        className="text-copper-600 transition-colors hover:text-copper-700"
      >
        Terms of Service
      </a>{' '}
      apply.
    </p>
  )
}
