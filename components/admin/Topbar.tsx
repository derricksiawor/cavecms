import type { Role } from '@/lib/auth/requireRole'
import { LogoutButton } from './LogoutButton'
import { AdminMobileNav } from './MobileNav'
import { CommandPaletteTrigger } from './CommandPalette'

export function AdminTopbar({ email, role }: { email: string; role: Role }) {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-warm-stone/15 bg-cream/85 px-6 py-4 backdrop-blur-md sm:px-10 lg:px-12">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <p className="truncate text-sm font-semibold text-near-black">
          {email}
        </p>
        <span
          aria-hidden="true"
          className="hidden h-px w-6 bg-copper-500 sm:inline-block"
        />
        <p className="hidden text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600 sm:block">
          {role}
        </p>
      </div>
      <div className="flex flex-1 items-center justify-end gap-3 sm:flex-none">
        <div className="hidden sm:block">
          <CommandPaletteTrigger />
        </div>
        <LogoutButton />
        {/* Hamburger is hidden at lg+ since the Sidebar handles
           navigation there. Below lg the Sidebar is `hidden`, so this
           drawer is the ONLY nav surface — without it a phone user
           could not reach Leads/Projects/etc. */}
        <AdminMobileNav role={role} />
      </div>
    </header>
  )
}
