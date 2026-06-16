import Link from 'next/link'

// Friendly dead-end for an invalid / expired / already-used reset link.
// No login-path leak, no hint about whether the token ever existed.
export function ResetExpired() {
  return (
    <div className="w-full max-w-md">
      <div className="relative overflow-hidden bg-cream-50/90 backdrop-blur-sm px-10 py-12 sm:px-14 sm:py-16 text-center shadow-[0_30px_80px_-30px_rgba(184,115,51,0.18)]">
        <div className="pointer-events-none absolute top-0 left-0 h-px w-16 bg-gradient-to-r from-copper-500 to-transparent" />
        <div className="pointer-events-none absolute bottom-0 right-0 h-px w-16 bg-gradient-to-l from-copper-500 to-transparent" />

        <p className="text-xs font-semibold tracking-[0.32em] uppercase text-copper-600">
          CaveCMS
        </p>
        <h1 className="mt-4 font-serif text-3xl sm:text-4xl font-bold text-near-black tracking-tight leading-[1.05]">
          This link has expired
        </h1>
        <p className="mt-3 text-sm font-medium text-warm-stone tracking-wide">
          Password-reset links can be used once and expire after a short while.
          Ask your administrator to send you a fresh link.
        </p>

        <div className="mt-10">
          <Link
            href="/"
            className="inline-flex w-fit items-center justify-center bg-near-black px-10 py-4 text-sm font-semibold tracking-[0.18em] uppercase text-cream-50 transition-all duration-standard hover:bg-copper-600 hover:shadow-[0_20px_50px_-15px_rgba(184,115,51,0.5)] hover:scale-[1.02]"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  )
}
