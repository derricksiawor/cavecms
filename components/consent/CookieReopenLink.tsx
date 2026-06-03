'use client'

// Footer "Cookie preferences" link. Re-opens the consent banner (in its
// Customise view) by calling the global hook the CookieConsent island exposes,
// falling back to the custom event. Rendered only when the banner is enabled.
export function CookieReopenLink({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (typeof window === 'undefined') return
        if (typeof window.cavecmsOpenCookiePrefs === 'function') window.cavecmsOpenCookiePrefs()
        else window.dispatchEvent(new CustomEvent('cavecms:open-cookie-prefs'))
      }}
    >
      {label}
    </button>
  )
}
