import 'server-only'
import { redirect } from 'next/navigation'
import {
  requireRole,
  HttpError,
  type Role,
  type AuthContext,
} from './requireRole'

// Server-side wrapper that turns an HttpError(403) into a transparent
// redirect to a target path (default '/'). The admin layout already
// authenticates the session and rejects unauthenticated visitors;
// individual admin pages that NARROW the role beyond what the layout
// allows (e.g. /admin/settings requires 'admin' while layout allows
// 'viewer') need this helper so a viewer typing the URL directly
// lands cleanly on the homepage rather than seeing the Next error
// boundary.
//
// Why not handle this in the layout: the layout runs ONCE for the
// whole admin group with the broadest allow-list. Per-page narrowing
// can't be expressed in a single layout call.
export async function requireRoleOrRedirect(
  allowed: Role[],
  redirectTo = '/',
): Promise<AuthContext> {
  try {
    return await requireRole(allowed)
  } catch (err) {
    if (err instanceof HttpError) redirect(redirectTo)
    throw err
  }
}
