import Link from 'next/link'
import { headers } from 'next/headers'
import { after } from 'next/server'
import { recordNotFound } from '@/lib/cms/notFoundLog'

// Themed 404 page — matches the error.tsx aesthetic. Triggered by
// `notFound()` calls in route handlers (e.g. project/[slug] when a
// slug doesn't resolve) and Next's auto-404 for unmatched paths.
// Server-rendered: no `'use client'`, no `reset()` handler — a 404
// is terminal, the visitor either follows a link back or types a
// new URL.

export const metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
}

// Reading headers() opts this into dynamic rendering — required so we can
// see the original requested path and record the 404.
export const dynamic = 'force-dynamic'

export default async function NotFound() {
  // Middleware sets x-pathname to the ORIGINAL requested path on every
  // request (middleware.ts), surviving the CMS rewrite. Record the 404 for
  // the operator's 404 log via after() — it runs AFTER the response is sent,
  // so the DB write never adds latency to the 404 render (and a 404 flood of
  // distinct paths can't turn the page into a synchronous DB-write amplifier).
  const h = await headers()
  // x-pathname carries the requested path (set by middleware). For a missing
  // single-segment slug, middleware rewrites to /cms-render/<slug> and Next
  // 15.5 standalone re-runs middleware on that internal path, so x-pathname
  // can arrive as "/cms-render/<slug>" — recover the original public path.
  const raw = h.get('x-pathname')
  const path = raw?.startsWith('/cms-render/') ? raw.slice('/cms-render'.length) : raw
  const referer = h.get('referer')
  if (path) {
    // Record via after() so the DB write runs AFTER the response — never adds
    // latency to the 404 render nor amplifies a 404 flood into blocking writes.
    after(() => recordNotFound(path, referer))
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-cream">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-[10%] h-[520px] w-[520px] rounded-full bg-copper-200/40 blur-[140px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 right-[5%] h-[480px] w-[480px] rounded-full bg-copper-300/30 blur-[140px]"
      />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col items-start justify-center px-8 py-24 sm:px-12">
        <p className="mt-8 font-serif text-9xl font-bold tracking-tight text-near-black/15">
          404
        </p>
        <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl leading-[1.02]">
          We couldn&apos;t find that page.
        </h1>
        <p className="mt-8 max-w-2xl text-base font-medium leading-relaxed text-warm-stone sm:text-lg">
          The link may be outdated, or the page may have moved. Head back
          to the home page to find your way around.
        </p>
        <div className="mt-16 flex flex-wrap gap-8 text-[11px] font-semibold uppercase tracking-[0.32em] text-near-black/80">
          <Link
            href="/"
            className="inline-flex items-center gap-3 hover:text-near-black"
          >
            <span className="block h-px w-12 bg-copper-500" />
            Home
          </Link>
        </div>
      </div>
    </main>
  )
}
