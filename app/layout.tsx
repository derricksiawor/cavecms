import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Montserrat, Marcellus } from 'next/font/google'
import { organizationLd } from '@/lib/seo/jsonLd'
import { safeJsonForScript } from '@/lib/seo/escape'
import { getSetting } from '@/lib/cms/getSettings'
import { resolveMedia } from '@/lib/cms/resolveMedia'
import { brandVarsCss } from '@/lib/cms/themeCss'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import { AdminBar } from '@/components/admin-bar/AdminBar'
import { MotionProvider } from '@/components/motion/MotionProvider'
import { ThirdPartyScripts, ThirdPartyBodyScripts } from '@/components/ThirdPartyScripts'
import { MobileCtaBar } from '@/components/MobileCtaBar'
import './globals.css'

const montserrat = Montserrat({
  subsets: ['latin'],
  variable: '--font-montserrat',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
})

const marcellus = Marcellus({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
  weight: ['400'],
})

// Typography pairing: Marcellus (serif) for all headings/titles,
// Montserrat (sans) for body copy, UI elements, buttons, eyebrows.
// Matches the client's original brand identity.

// Root metadata. title/description stay neutral defaults (real pages
// override them via their own generateMetadata). The favicon is
// operator-configurable under Settings → SEO (default_seo.favicon):
// when set we emit a <link rel="icon"> pointing at the uploaded image's
// processed variant; when null we emit nothing here and Next's file
// convention serves the bundled app/favicon.ico.
export async function generateMetadata(): Promise<Metadata> {
  const base: Metadata = {
    title: 'CaveCMS',
    description: 'A CaveCMS-powered site.',
  }
  try {
    const seo = await getSetting('default_seo')
    const fav = seo?.favicon
    if (fav?.media_id) {
      const media = await resolveMedia(fav.media_id)
      const url = media?.md ?? media?.thumb ?? media?.lg ?? null
      if (url) {
        // webp variants from the media pipeline — supported by every
        // current browser. Operators are guided to upload a square
        // source so the tab icon isn't letterboxed.
        base.icons = {
          icon: [{ url, type: 'image/webp' }],
          apple: [{ url }],
          shortcut: [{ url }],
        }
      }
    }
  } catch {
    // Settings/media read hiccup — degrade to the bundled favicon
    // convention rather than break document <head> rendering.
  }
  return base
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const h = await headers()
  const nonce = h.get('x-csp-nonce') ?? ''

  // Suppress the site chrome (header / footer / mobile CTA / admin
  // bar) on the install wizard. The wizard owns its full viewport —
  // showing a SiteHeader that links to /projects, /services, etc.
  // while the operator is still in the install flow is confusing and
  // can leak unconfigured links / brand text. Middleware sets
  // `x-pathname` on every request; we read it here.
  const pathname = h.get('x-pathname') ?? ''
  const isInstallWizard = pathname === '/install' || pathname.startsWith('/install/')

  // AdminBar is a server-component bootstrap that gates ONLY on
  // session presence. If a session exists, it renders a client
  // `AdminBarShell` that owns visibility per navigation via
  // `usePathname()` — this is the only reliable way to flip the bar
  // on/off across soft Link navs in Next 15, since the root layout
  // doesn't re-render on navigation. Signed-out visitors get null
  // (zero client JS for the bar), preserving the "public site pays
  // nothing for admin features" contract.
  //
  // SiteHeader's top-offset rule in globals.css uses a `:has()`
  // selector to detect the bar's presence — no body attribute needed
  // (and a body attribute set here wouldn't update on navigation
  // anyway since layouts don't re-render).

  // Organization JSON-LD is emitted at the layout level so every
  // public route inherits it. Per-route LD that describes a specific
  // entity (Residence, BlogPosting) is added by the route itself;
  // both coexist via multiple application/ld+json script tags.
  const orgLd = await organizationLd()

  // Operator brand palette → injected CSS-var overrides. getSetting
  // fails-closed to the registry default, so a missing/garbage row
  // yields the luxury defaults. brandVarsCss re-validates every hex.
  const palette = await getSetting('theme_palette')
  const brandCss = brandVarsCss(palette)
  return (
    <html
      lang="en"
      className={`${montserrat.variable} ${marcellus.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="csp-nonce" content={nonce} />
        <script
          type="application/ld+json"
          // safeJsonForScript escapes </script>, --> and U+2028/U+2029
          // so admin-controlled fields can never break out of the
          // script tag even if CSP strict-dynamic is ever relaxed.
          dangerouslySetInnerHTML={{ __html: safeJsonForScript(orgLd) }}
        />
        <style
          nonce={nonce}
          // Brand palette overrides (Settings → Theme). UN-layered so it
          // beats the @layer-base defaults in globals.css. Body is hex-only,
          // re-validated in brandVarsCss — no operator free-text reaches CSS.
          //
          // suppressHydrationWarning: the browser strips the `nonce`
          // attribute value from the DOM after applying CSP (security
          // behaviour), so the client hydrates seeing nonce="" while the
          // server rendered the real nonce. The CSS content is identical
          // server/client — only the browser-cleared nonce differs, which
          // is expected, so we suppress the otherwise-spurious warning.
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: brandCss }}
        />
        {/* Third-party analytics / tracking / chat. Every <script>
           carries the request nonce; toggles off emit zero bytes. */}
        <ThirdPartyScripts />
      </head>
      <body
        className="flex min-h-screen flex-col font-sans antialiased"
        // Base surface follows Settings → Theme (Light/Dark mode). Defaults
        // to the brand light surface (ivory) — unifies the page base onto
        // the luxury palette; content blocks render their own tones.
        style={{ background: 'var(--brand-base-bg)', color: 'var(--brand-base-fg)' }}
      >
        {/* Public header + footer are mounted at the root so every
           public page inherits them. Admin routes have their own
           layout shell and these components self-suppress by reading
           the x-pathname middleware header. AdminBar's server
           component gates on session; the client shell inside owns
           per-navigation visibility (see comment above).

           Body is a `min-h-screen flex-col` container and the children
           wrapper is `flex-1` so the SiteFooter sticks to the viewport
           bottom on short pages (empty seeded About / 404 / draft with
           no blocks). Without this, the footer floats mid-viewport on
           any page whose content is shorter than the viewport.

           MotionProvider wraps the whole tree to set up GSAP once
           and refresh ScrollTrigger on App Router navigation. It
           renders no wrapper DOM — the AdminBar / SiteHeader /
           children / SiteFooter visual order is unchanged. */}
        <ThirdPartyBodyScripts />
        <MotionProvider>
          {isInstallWizard ? (
            // Bare install-wizard chrome: no site header, no footer,
            // no admin bar, no mobile CTA. The wizard renders its
            // own bounded layout with the CaveCMS wordmark only.
            <div className="flex flex-1 flex-col">{children}</div>
          ) : (
            <>
              <AdminBar />
              <SiteHeader />
              <div className="flex flex-1 flex-col">{children}</div>
              <SiteFooter />
              <MobileCtaBar />
            </>
          )}
        </MotionProvider>
      </body>
    </html>
  )
}
