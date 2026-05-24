import Link from 'next/link'

// Themed 404 page — matches the error.tsx aesthetic. Triggered by
// `notFound()` calls in route handlers (e.g. project/[slug] when a
// slug doesn't resolve) and Next's auto-404 for unmatched paths.
// Server-rendered: no `'use client'`, no `reset()` handler — a 404
// is terminal, the visitor either follows a link back or types a
// new URL.

export const metadata = {
  title: 'Page not found — Best World Properties',
  robots: { index: false, follow: false },
}

export default function NotFound() {
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
        <p className="text-xs font-semibold uppercase tracking-[0.42em] text-copper-600">
          Best World Properties
        </p>
        <p className="mt-8 font-serif text-9xl font-bold tracking-tight text-near-black/15">
          404
        </p>
        <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl leading-[1.02]">
          We couldn&apos;t find that page.
        </h1>
        <p className="mt-8 max-w-2xl text-base font-medium leading-relaxed text-warm-stone sm:text-lg">
          The link may be outdated, or the page may have moved. Use the
          links below to find your way back.
        </p>
        <div className="mt-16 flex flex-wrap gap-8 text-[11px] font-semibold uppercase tracking-[0.32em] text-near-black/80">
          <Link
            href="/"
            className="inline-flex items-center gap-3 hover:text-near-black"
          >
            <span className="block h-px w-12 bg-copper-500" />
            Home
          </Link>
          <Link
            href="/projects"
            className="inline-flex items-center gap-3 hover:text-near-black"
          >
            <span className="block h-px w-12 bg-copper-500" />
            Projects
          </Link>
          <Link
            href="/contact"
            className="inline-flex items-center gap-3 hover:text-near-black"
          >
            <span className="block h-px w-12 bg-copper-500" />
            Contact
          </Link>
        </div>
      </div>
    </main>
  )
}
