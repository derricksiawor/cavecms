export const dynamic = 'force-dynamic'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-cream">
      {/* Layered ambient glows — gives the page real depth without borders. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -left-24 h-[480px] w-[480px] rounded-full bg-copper-300/30 blur-[120px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 right-[-10rem] h-[520px] w-[520px] rounded-full bg-copper-200/40 blur-[140px]"
      />
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-16">
        {children}

        <div className="mt-10 flex w-full max-w-xs items-center gap-5">
          <span aria-hidden="true" className="h-px flex-1 bg-gradient-to-r from-transparent to-obsidian/20" />
          <p className="whitespace-nowrap text-[10px] uppercase tracking-[0.2em] text-obsidian/50">
            A Time Macro LLC Product
          </p>
          <span aria-hidden="true" className="h-px flex-1 bg-gradient-to-l from-transparent to-obsidian/20" />
        </div>
      </div>
    </main>
  )
}
