// Empty-home failsafe (spec §2.4). Rendered by `app/page.tsx` when the
// `is_home=1` row is missing or soft-deleted. The acceptance test
// greps the unauthenticated HTML for `/admin` and MUST return zero —
// so this component carries NO admin URL, no edit hint, no Link to
// `/admin/pages` etc.
//
// The corresponding recovery affordance lives ONLY in the admin bar
// (rendered for authenticated admin sessions). For unauthenticated
// visitors the bar is not injected, so the rendered HTML contains
// zero `/admin/...` substrings.
//
// Styling mirrors the existing splash-fallback aesthetic in the
// pre-PR-2 `app/page.tsx` (cream background, copper accents, serif
// headline) so a soft-deleted home doesn't look broken — just
// "under maintenance".

export function HomePageEmptyState() {
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

      <section className="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center px-8 py-24 sm:px-12">
        <p className="text-xs font-semibold uppercase tracking-[0.42em] text-copper-600 animate-bwc-rise">
          Best World Properties
        </p>
        <h1 className="mt-8 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-6xl lg:text-7xl leading-[1.05] animate-bwc-rise [animation-delay:120ms]">
          This site is being updated.
        </h1>
        <p className="mt-8 max-w-xl text-base font-medium leading-relaxed text-warm-stone sm:text-lg animate-bwc-rise [animation-delay:260ms]">
          Please check back shortly.
        </p>
      </section>
    </main>
  )
}
