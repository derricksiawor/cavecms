import { redirect } from 'next/navigation'
import { requireAuth, HttpError } from '@/lib/auth/requireRole'
import type { AuthContext } from '@/lib/auth/requireRole'
import { RotateForm } from './RotateForm'

export const dynamic = 'force-dynamic'

export function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

// First-login / forced password rotation. A user created by an admin lands
// here because login minted a pwp=true session and the admin layout (plus the
// login redirect) route pwp users to this page. getSession() treats a pwp
// session as "no session", so we read the raw context via requireAuth(), which
// PRESERVES pwp instead of throwing.
export default async function RotatePage() {
  let ctx: AuthContext
  try {
    ctx = await requireAuth()
  } catch (err) {
    // No valid session at all (not signed in, deactivated, revoked). Mirror the
    // admin-layout policy: redirect to "/" rather than leaking the login path.
    if (err instanceof HttpError) redirect('/')
    throw err
  }

  // A fully-authenticated user doesn't owe a rotation — send them on to the
  // dashboard. (They change their password under Settings, not here.)
  if (!ctx.pwp) redirect('/admin')

  return <RotateForm email={ctx.email} />
}
