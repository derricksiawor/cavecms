import 'server-only'
import { NextResponse } from 'next/server'
import { withError } from '@/lib/api/withError'
import { getSession } from '@/lib/auth/getSession'
import { resolveEditTarget } from '@/lib/admin-bar/resolveEditTarget'
import { canEditTarget } from '@/lib/admin-bar/roleAllowlist'

// Backs the public admin bar's client-side per-navigation resolve of
// the "Edit X" target. Called by `AdminBarClient` whenever the
// pathname changes to a route that might map to an admin-editable
// resource. Requires a valid session — unauth requests get 401 with
// no information disclosure (no login URL, no admin path hints).
//
// Why an endpoint at all (vs. server-rendering per route): Next 15's
// root layout does NOT re-render on soft Link navigations, so the
// bar's editTarget would otherwise go stale until a hard reload.
// Client-side refetch via this route closes the gap.
//
// Cache-Control: private, no-store. The resolver itself is already
// unstable_cache-d on the server (300 s revalidate, per-slug tags),
// so repeat hits for the same slug are near-instant; we just don't
// want intermediaries caching this auth-gated response.

export const GET = withError(async (req: Request) => {
  const session = await getSession()
  if (!session) {
    return new NextResponse(
      JSON.stringify({ error: 'unauthenticated' }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      },
    )
  }
  const url = new URL(req.url)
  const path = url.searchParams.get('path') ?? ''
  // Hard cap on pathname length — the resolver itself slug-caps, but
  // bounding the input keeps the regex evaluation cheap on bad input.
  if (path.length === 0 || path.length > 256) {
    return new NextResponse(JSON.stringify({ target: null }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  }
  const rawTarget = await resolveEditTarget(path)
  // Mirror the bar's role gate so the API never leaks an admin URL
  // for a resource the requester can't edit.
  const target =
    rawTarget && canEditTarget(rawTarget.kind, session.role) ? rawTarget : null
  return new NextResponse(JSON.stringify({ target }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
