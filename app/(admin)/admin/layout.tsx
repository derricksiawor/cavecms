import { redirect } from 'next/navigation'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import type { AuthContext } from '@/lib/auth/requireRole'
import { AdminSidebar } from '@/components/admin/Sidebar'
import { AdminTopbar } from '@/components/admin/Topbar'
import { UpdateBanner } from '@/components/admin/UpdateBanner'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'
import { ToastProvider } from '@/components/inline-edit/Toast'
import { CommandPaletteProvider } from '@/components/admin/CommandPalette'

export const dynamic = 'force-dynamic'

export function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Narrow the catch to HttpError ONLY — a DB outage / unexpected throw must
  // bubble so the error surfaces in logs + a 500 page, not silently redirect
  // every user to /. Same for the NEXT_REDIRECT thrown by redirect() itself.
  let ctx: AuthContext
  try {
    ctx = await requireRole(['admin', 'editor', 'viewer'])
  } catch (err) {
    if (err instanceof HttpError) {
      redirect('/')
    }
    throw err
  }
  if (ctx.pwp) redirect('/auth/rotate')

  return (
    // No `overflow-hidden` on the outer wrapper: CSS spec says
    // `position: sticky` is silently broken when ANY ancestor has
    // `overflow: hidden | auto | scroll` (the sidebar then scrolls
    // with the page instead of sticking). The ambient blur below is
    // `fixed`-positioned so it doesn't need the parent to clip — it
    // sits relative to the viewport regardless.
    <div className="relative min-h-screen bg-cream">
      {/* Ambient depth — single soft glow, never overpowers content. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed -top-32 left-[20%] h-[420px] w-[420px] rounded-full bg-copper-200/30 blur-[140px]"
      />

      <ToastProvider>
        <CommandPaletteProvider>
          <div className="relative z-10 flex min-h-screen">
            <AdminSidebar role={ctx.role} />
            <div className="flex min-w-0 flex-1 flex-col">
              <AdminTopbar email={ctx.email} role={ctx.role} />
              {/* Update banner — only admins can act on updates, so we
                  skip the per-page network round-trip for viewers/editors.
                  `currentSha` is resolved server-side so the banner can
                  skip its bootstrap fetches entirely on local-dev installs
                  (sha === 'dev'). */}
              {ctx.role === 'admin' && (
                <UpdateBanner currentSha={getCurrentVersion().sha} />
              )}
              <main className="flex-1 px-8 py-12 sm:px-12 lg:px-20 lg:py-20">
                {children}
              </main>
            </div>
          </div>
        </CommandPaletteProvider>
      </ToastProvider>
    </div>
  )
}
