import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { ConsentGatedScripts, type GatedScript } from '@/components/consent/ConsentGatedScripts'

// Server component that injects analytics/tracking/chat snippets
// into the document <head>. Mounted once at the top of the body in
// app/layout.tsx (Next renders into <head> when this returns
// <script> tags from the top of the tree per RFC).
//
// Suppression model:
//   - Suppressed on /admin/* — the operator doesn't need analytics
//     tracking themselves while editing pages.
//   - When a toggle is off, emit ZERO bytes for that integration —
//     no empty <script>, no preconnect, no comment. The CSP allowance
//     for that origin is also gone (see lib/security/buildCsp.ts),
//     so the integration is invisible end-to-end.
//
// CSP-nonce model:
//   - Every inline <script> carries nonce={nonce} pulled from the
//     middleware-set x-csp-nonce header. CSP3 strict-dynamic + nonce
//     means script-src 'unsafe-inline' is never enabled — only
//     scripts WE explicitly nonce + the scripts THEY load (per
//     strict-dynamic propagation) can execute.

export async function ThirdPartyScripts() {
  const h = await headers()
  const pathname = h.get('x-pathname') ?? ''
  // Exact-or-slash match — `startsWith('/admin')` would also match a
  // hypothetical future public route like `/administer` or `/admins-only`.
  if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/')) return null

  const nonce = h.get('x-csp-nonce') ?? ''
  const [gtm, ga4, ads, hotjar, salesiq, hubspot] = await Promise.all([
    getSetting('integrations_gtm'),
    getSetting('integrations_ga4'),
    getSetting('integrations_google_ads'),
    getSetting('integrations_hotjar'),
    getSetting('integrations_zoho_salesiq'),
    getSetting('integrations_hubspot'),
  ])
  // Any tracker that the consent banner could gate? When none are enabled the
  // consent state is irrelevant, so we skip the read entirely (zero extra cost
  // on the common integration-free install).
  const anyTracker =
    gtm.enabled || ga4.enabled || ads.enabled || hotjar.enabled || salesiq.enabled || hubspot.enabled

  // Determine whether a consent banner is active — FAIL CLOSED. We deliberately
  // do NOT use getSetting() here: it fails OPEN (returns the registry default
  // `enabled:false` on a DB error, a tampered/unparseable row, OR a Zod
  // validation failure), which would silently ungate the trackers below. So we
  // read the raw row and treat any read/parse failure — or a present-but-
  // unparseable row — as "banner active → gate". A genuinely-absent row (no
  // banner ever configured) or an explicit `enabled:false` means load freely.
  let cookieEnabled = false
  let cookieConsentMode = true
  if (anyTracker) {
    try {
      const [rows] = (await db.execute(
        sql`SELECT value FROM settings WHERE \`key\` = 'cookie_consent' LIMIT 1`,
      )) as unknown as [Array<{ value: unknown }>]
      if (rows.length) {
        try {
          const raw = rows[0]!.value
          const v = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
            enabled?: unknown
            googleConsentMode?: unknown
          }
          cookieEnabled = v?.enabled === true
          cookieConsentMode = v?.googleConsentMode !== false
        } catch {
          cookieEnabled = true // row present but unparseable → fail closed
        }
      }
    } catch {
      cookieEnabled = true // DB read failed → fail closed
    }
  }

  // GA4 + Ads share the gtag.js loader. When GTM is enabled and
  // ga4.viaGtm is true, suppress the standalone GA4 loader to avoid
  // double-counting (GA4 fires inside the GTM container instead).
  const ga4Standalone = ga4.enabled && !(gtm.enabled && ga4.viaGtm)
  const needsGtag = ga4Standalone || ads.enabled

  // GDPR: when the consent banner is on (with Google Consent Mode), set ALL
  // consent signals to 'denied' BEFORE any Google tag boots, so GA4 / Ads /
  // GTM store nothing until the visitor grants. The client banner flips the
  // granted categories via gtag('consent','update', …). This snippet MUST
  // render before the GTM container + gtag loader below.
  const consentDefault =
    cookieEnabled && cookieConsentMode && (gtm.enabled || ga4Standalone || ads.enabled)

  // The non-Google vendors don't support Consent Mode, so when the banner is
  // enabled they must be LOAD-gated client-side (inject only on category
  // grant). When the banner is OFF they render server-side immediately, as
  // before. Category mapping is the GDPR-safe default; an absent category =
  // never granted = never loads.
  const gated: GatedScript[] = []
  if (cookieEnabled) {
    if (hotjar.enabled && hotjar.siteId)
      gated.push({ id: 'cavecms-hotjar', category: 'analytics', html: hotjarSnippet(hotjar.siteId, hotjar.snippetVersion) })
    if (hubspot.enabled && hubspot.trackingEnabled && hubspot.portalId)
      gated.push({ id: 'hs-script-loader', category: 'marketing', src: `https://js.hs-scripts.com/${encodeURIComponent(hubspot.portalId)}.js`, async: true, defer: true })
    if (salesiq.enabled && salesiq.widgetCode)
      gated.push({ id: 'cavecms-salesiq', category: 'preferences', html: salesIqSnippet(salesiq.widgetCode, salesiq.region) })
  }

  return (
    <>
      {/* ─── Consent Mode v2 default (denied) ─── */}
      {consentDefault && (
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: consentDefaultSnippet() }} />
      )}

      {/* ─── GTM ─── */}
      {gtm.enabled && gtm.containerId && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: gtmHeadSnippet(gtm.containerId),
          }}
        />
      )}

      {/* ─── gtag.js loader (shared by GA4 standalone + Ads) ─── */}
      {needsGtag && (
        <>
          <script
            nonce={nonce}
            async
            src={`https://www.googletagmanager.com/gtag/js?id=${ga4Standalone && ga4.measurementId ? encodeURIComponent(ga4.measurementId) : encodeURIComponent(ads.conversionId ?? '')}`}
          />
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{ __html: gtagInitSnippet(ga4Standalone ? ga4.measurementId : null, ads.enabled ? ads.conversionId : null) }}
          />
        </>
      )}

      {/* ─── Non-Google trackers ─── */}
      {cookieEnabled ? (
        // Banner on → load only after the mapped category is granted.
        <ConsentGatedScripts scripts={gated} />
      ) : (
        // Banner off → server-side immediate (no consent layer configured).
        <>
          {hotjar.enabled && hotjar.siteId && (
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: hotjarSnippet(hotjar.siteId, hotjar.snippetVersion) }} />
          )}
          {hubspot.enabled && hubspot.trackingEnabled && hubspot.portalId && (
            <script nonce={nonce} id="hs-script-loader" async defer src={`https://js.hs-scripts.com/${encodeURIComponent(hubspot.portalId)}.js`} />
          )}
          {salesiq.enabled && salesiq.widgetCode && (
            <script nonce={nonce} dangerouslySetInnerHTML={{ __html: salesIqSnippet(salesiq.widgetCode, salesiq.region) }} />
          )}
        </>
      )}
    </>
  )
}

// Companion: GTM also needs an iframe in <body> for the no-script
// fallback. Mount this separately near the top of <body>.
export async function ThirdPartyBodyScripts() {
  const h = await headers()
  const pathname = h.get('x-pathname') ?? ''
  if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/')) return null
  const gtm = await getSetting('integrations_gtm')
  if (!gtm.enabled || !gtm.containerId) return null
  return (
    <noscript>
      <iframe
        src={`https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(gtm.containerId)}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
      />
    </noscript>
  )
}

// Snippet builders. Static strings — operator-controlled inputs go
// through encodeURIComponent at the call site so a malformed
// containerId / siteId / measurementId can't break out of the
// surrounding string context. CSP nonce + strict-dynamic is the
// real defence; this is belt-and-braces input sanitisation.

// Consent Mode v2 default — runs before any Google tag. Defines gtag/dataLayer
// (idempotent with the later init), denies every storage signal except
// security_storage, and gives the client banner 500ms to send an update so a
// returning visitor's stored grant applies before the first hit fires.
function consentDefaultSnippet(): string {
  return `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',functionality_storage:'denied',personalization_storage:'denied',security_storage:'granted',wait_for_update:500});gtag('set','url_passthrough',true);`
}

function gtmHeadSnippet(containerId: string): string {
  const id = JSON.stringify(containerId)
  return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${id});`
}

function gtagInitSnippet(measurementId: string | null | undefined, adsId: string | null | undefined): string {
  const parts: string[] = [
    'window.dataLayer = window.dataLayer || [];',
    'function gtag(){dataLayer.push(arguments);}',
    "gtag('js', new Date());",
  ]
  if (measurementId) parts.push(`gtag('config', ${JSON.stringify(measurementId)});`)
  if (adsId) parts.push(`gtag('config', ${JSON.stringify(adsId)});`)
  return parts.join('\n')
}

function hotjarSnippet(siteId: string, snippetVersion: number): string {
  const id = JSON.stringify(siteId)
  const ver = Number(snippetVersion) || 6
  return `(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${id},hjsv:${ver}};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`
}

function salesIqSnippet(widgetCode: string, region: string): string {
  const code = JSON.stringify(widgetCode)
  const r = JSON.stringify(region)
  return `window.$zoho=window.$zoho||{};$zoho.salesiq=$zoho.salesiq||{widgetcode:${code},values:{},ready:function(){}};var d=document,s=d.createElement('script');s.type='text/javascript';s.id='zsiqscript';s.defer=true;s.src='https://salesiq.zoho.'+${r}+'/widget';var t=d.getElementsByTagName('script')[0];t.parentNode.insertBefore(s,t);`
}
