import { cookies } from 'next/headers'
import { z } from 'zod'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { EDIT_MODE_COOKIE, cookieFlags } from '@/lib/auth/cookies'

const Body = z.object({ on: z.boolean() })

// Edit-mode cookie lives WAY shorter than the auth JWT (8h). An admin
// who toggles edit on and walks away from a kiosk shouldn't keep edit
// chrome up for the full JWT window — 2h is the typical focused-editing
// session ceiling; beyond that, toggling again is a deliberate gesture.
// Independent of JWT_TTL_SECONDS so a JWT rotation doesn't accidentally
// move this anchor.
const EDIT_MODE_TTL_SECONDS = 60 * 60 * 2

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  const { on } = Body.parse(await req.json())
  const c = await cookies()
  if (on) {
    c.set(EDIT_MODE_COOKIE, '1', cookieFlags(EDIT_MODE_TTL_SECONDS))
  } else {
    // `cookies().delete(name)` emits a bare deletion cookie without
    // Secure/Path/SameSite. The production cookie is `__Host-bwc_edit_mode`
    // and the `__Host-` prefix REQUIRES the deletion cookie to carry
    // matching Secure=true + Path=/ flags or the browser silently
    // rejects the deletion. Result: cookie persists, page stays editable.
    // Setting an empty value with maxAge=0 and the same flag set as the
    // original cookie guarantees the browser recognises the deletion.
    c.set(EDIT_MODE_COOKIE, '', cookieFlags(0))
  }
  return new Response(JSON.stringify({ on }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
