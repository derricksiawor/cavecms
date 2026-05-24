// CSP builder used by middleware. Lives outside middleware.ts so the
// app/layout.tsx + future Edge contexts can share one source of truth
// for which third-party origins each integration toggle unlocks.
// Edge-safe: pure string-building, no Node imports, no DB calls.
//
// SECURITY MODEL
// Base directives are the locked-down site default — same shape as
// the previous inline middleware csp(). Each integration toggle
// appends ONLY the additional origins that integration actually
// needs. When a toggle flips off, those origins disappear from CSP
// at the next middleware request (3s cache TTL via security-config).
// Net: a disabled integration is invisible — its origins aren't in
// CSP, its script tags aren't injected, its endpoints aren't
// allow-listed by connect-src.

export interface IntegrationsCspFlags {
  gtm: boolean
  ga4: boolean
  googleAds: boolean
  hotjar: boolean
  zohoSalesIqRegion: 'com' | 'eu' | 'in' | 'com.au' | 'jp' | null
  hubspotTracking: boolean
}

export function buildCsp(nonce: string, isProd: boolean, integrations?: IntegrationsCspFlags): string {
  const scriptSrc = isProd
    ? [`'nonce-${nonce}'`, "'strict-dynamic'"]
    : [`'nonce-${nonce}'`, "'strict-dynamic'", "'unsafe-eval'"]
  const connectSrc: string[] = ["'self'", 'https://www.google.com', 'https://www.gstatic.com', 'https://www.recaptcha.net']
  const frameSrc: string[] = ['https://www.google.com', 'https://maps.google.com', 'https://www.recaptcha.net']
  const imgSrc: string[] = ["'self'", 'data:']

  const i = integrations
  // ─── GTM / GA4 / Google Ads ───
  // All three share the gtag.js loader hosted at
  // www.googletagmanager.com. Connect-src extends to the various
  // GA + DoubleClick endpoints the loader hits at runtime. img-src
  // covers the 1x1 collection pixels.
  if (i?.gtm || i?.ga4 || i?.googleAds) {
    scriptSrc.push('https://www.googletagmanager.com', 'https://www.google-analytics.com')
    connectSrc.push(
      'https://*.google-analytics.com',
      'https://*.analytics.google.com',
      'https://*.g.doubleclick.net',
      'https://www.googletagmanager.com',
    )
    imgSrc.push('https://www.google-analytics.com', 'https://www.googletagmanager.com')
  }
  if (i?.gtm) frameSrc.push('https://www.googletagmanager.com')

  // Google Ads needs extra hosts beyond the gtag.js loader. Verified
  // live via Playwright + Network capture:
  //   * googleads.g.doubleclick.net   — viewthrough conversion endpoint
  //                                      (already covered by *.g.doubleclick.net)
  //   * www.google.com/ccm/collect    — Conversion measurement
  //   * www.google.com/rmkt/collect   — Remarketing collect
  //   * www.google.com/pagead/1p-user-list/<id>/ — Enhanced-conversions
  //                                                user-list iframe + img
  //   * www.googleadservices.com      — Ads server / pixel host
  //
  // Country-TLD variants (www.google.com.gh, .co.uk, .de, etc.) are
  // geo-routed by Google for first-party user-list matching. We do
  // NOT allow-list every country TLD — operators serving a single
  // local market can extend CSP via the operator-config layer if
  // their country's enhanced-conversions matching needs it.
  if (i?.googleAds) {
    scriptSrc.push('https://www.google.com', 'https://www.googleadservices.com')
    connectSrc.push('https://www.google.com', 'https://www.googleadservices.com')
    imgSrc.push('https://www.google.com', 'https://www.googleadservices.com')
    frameSrc.push('https://www.google.com', 'https://www.googleadservices.com')
  }

  // ─── Hotjar ───
  if (i?.hotjar) {
    scriptSrc.push('https://static.hotjar.com', 'https://script.hotjar.com')
    connectSrc.push('https://*.hotjar.com', 'wss://*.hotjar.com')
    imgSrc.push('https://*.hotjar.com')
    frameSrc.push('https://vars.hotjar.com')
  }

  // ─── HubSpot tracking ───
  // Tracking script only — Forms-API submission is server-to-server
  // and needs no CSP allowance.
  if (i?.hubspotTracking) {
    scriptSrc.push(
      'https://js.hs-scripts.com',
      'https://js.hs-analytics.net',
      'https://js.hsadspixel.net',
      'https://js.hs-banner.com',
      'https://js.hubspot.com',
    )
    connectSrc.push('https://forms.hubspot.com', 'https://api.hubapi.com', 'https://track.hubspot.com')
    imgSrc.push('https://track.hubspot.com')
  }

  // ─── Zoho SalesIQ widget ───
  // Region-scoped. SalesIQ uses TWO host families at runtime:
  //   `salesiq.zoho.<region>`        — the script loader (snippet src)
  //   `salesiq.zohopublic.<region>`  — the widget's XHR + websocket
  //                                    channels, image assets, iframe
  //                                    panels. The widget loads from
  //                                    .zoho.<region> then upgrades
  //                                    to .zohopublic.<region> for
  //                                    visitor session API calls.
  // Verified via live browser-network capture: omitting zohopublic
  // causes the widget to load but silently fail on every channel
  // request with `csp` blocked status.
  if (i?.zohoSalesIqRegion) {
    const r = i.zohoSalesIqRegion
    scriptSrc.push(`https://salesiq.zoho.${r}`, `https://salesiq.zohopublic.${r}`)
    connectSrc.push(
      `https://salesiq.zoho.${r}`,
      `https://salesiq.zohopublic.${r}`,
      `wss://salesiq.zohopublic.${r}`,
    )
    imgSrc.push(`https://salesiq.zoho.${r}`, `https://salesiq.zohopublic.${r}`)
    frameSrc.push(`https://salesiq.zoho.${r}`, `https://salesiq.zohopublic.${r}`)
  }

  const directives = [
    "default-src 'self'",
    `img-src ${dedupe(imgSrc).join(' ')}`,
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `connect-src ${dedupe(connectSrc).join(' ')}`,
    `frame-src ${dedupe(frameSrc).join(' ')}`,
    "object-src 'none'",
    "media-src 'none'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]
  if (isProd) directives.push('upgrade-insecure-requests')
  return directives.join('; ')
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr))
}
