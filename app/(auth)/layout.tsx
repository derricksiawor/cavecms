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
      <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-16">
        {children}
      </div>
    </main>
  )
}
