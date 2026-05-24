import 'server-only'
import { headers, cookies } from 'next/headers'
import { env } from '@/lib/env'
import { getSession } from '@/lib/auth/getSession'
import { shouldRenderAdminBar } from '@/lib/admin-bar/shouldRender'
import { resolveEditTarget } from '@/lib/admin-bar/resolveEditTarget'
import { canEditTarget } from '@/lib/admin-bar/roleAllowlist'
import { EDIT_MODE_COOKIE_NAME } from '@/lib/auth/cookie-names'
import { AdminBarShell } from './AdminBarShell'

// Server-side entry point for the public admin bar. Gates on SESSION
// only (not path) so the bar's client island stays mounted across
// soft navigations between /admin and / — Next 15's root layout
// doesn't re-render on Link nav, so any path-gating done here would
// freeze the bar's visibility to whatever it decided at first load.
// The actual path-based show/hide lives in `AdminBarShell` (client),
// which reads `usePathname()` and re-evaluates per nav.
//
// Signed-out visitors get null here -> ZERO client JS for the bar.
// That's the public-facing contract: nothing for non-operators.
//
// We DO still compute an initial editTarget server-side so the
// signed-in user sees the right "Edit X" pill at first paint without
// waiting for a client fetch. Subsequent navigations refetch via
// `/api/admin-bar/edit-target`.

export async function AdminBar() {
  const session = await getSession()
  if (!session) return null

  const pathname = (await headers()).get('x-pathname') ?? '/'
  // Server-side path-gate uses env.LOGIN_PATH (which MUST stay
  // server-only — never ship the secret login path to the client).
  // This catches /admin AND /${LOGIN_PATH} on initial render. The
  // client mirror in AdminBarShell handles subsequent navigation
  // WITHIN public routes; cross-boundary nav (admin ↔ public) is
  // forced to hard navigation by the bar's plain <a> links and the
  // admin sidebar's Preview-site link, so the bar's mount lifecycle
  // is always anchored to a fresh server render across that
  // boundary.
  if (!shouldRenderAdminBar(pathname, env.LOGIN_PATH)) return null

  const raw = await resolveEditTarget(pathname)
  const initialEditTarget =
    raw && canEditTarget(raw.kind, session.role) ? raw : null

  // Edit-mode flag is a cookie set by /api/cms/edit-mode (POST {on:true}).
  // We read it server-side so the AdminBar's Outline-toggle pill renders
  // ONLY when the operator is actively in edit mode on this page render.
  // The flag survives soft navs because it's a cookie; the bar's client
  // shell doesn't re-evaluate it per nav, but the EditModePill's toggle
  // calls router.refresh which re-mounts the bar with the new value.
  const editMode =
    (await cookies()).get(EDIT_MODE_COOKIE_NAME)?.value === '1'

  return (
    <AdminBarShell
      email={session.email}
      role={session.role}
      initialPathname={pathname}
      initialEditTarget={initialEditTarget}
      editMode={editMode}
    />
  )
}
