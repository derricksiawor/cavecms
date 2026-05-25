'use client'

import { useEffect } from 'react'

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Server-side errors are logged via structured console.error in route handlers.
    // Capture client-side occurrence for telemetry.
    console.error('[cavecms] route error:', error.name, error.digest)
  }, [error])

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
        <h1 className="mt-8 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-6xl leading-[1.02]">
          Something interrupted the page.
        </h1>
        <p className="mt-10 max-w-2xl text-base font-medium leading-relaxed text-warm-stone sm:text-lg">
          We&apos;re looking into it. Please try again in a moment.
        </p>
        <button
          onClick={reset}
          className="mt-16 inline-flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.32em] text-near-black/80 hover:text-near-black"
        >
          <span className="block h-px w-12 bg-copper-500" />
          Try again
        </button>
      </div>
    </main>
  )
}
