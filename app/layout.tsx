import { headers } from 'next/headers'
import { Montserrat, Marcellus } from 'next/font/google'
import { organizationLd } from '@/lib/seo/jsonLd'
import { safeJsonForScript } from '@/lib/seo/escape'
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

export const metadata = {
  title: 'CaveCMS',
  description: 'A CaveCMS-powered site.',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-csp-nonce') ?? ''

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
  return (
    <html
      lang="en"
      className={`${montserrat.variable} ${marcellus.variable}`}
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
        {/* Third-party analytics / tracking / chat. Every <script>
           carries the request nonce; toggles off emit zero bytes. */}
        <ThirdPartyScripts />
      </head>
      <body className="flex min-h-screen flex-col font-sans antialiased bg-cream text-near-black">
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
          <AdminBar />
          <SiteHeader />
          <div className="flex flex-1 flex-col">
            {children}
          </div>
          <SiteFooter />
          <MobileCtaBar />
        </MotionProvider>
      </body>
    </html>
  )
}
