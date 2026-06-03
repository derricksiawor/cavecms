import { withError } from '@/lib/api/withError'
import { requireRole, requireScope, HttpError } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { listRemoteBackups } from '@/lib/backups/cloud/remoteList'

// GET /api/admin/backups/destinations/remote-list?provider=gdrive|onedrive —
// admin-gated list of the remote backups for a connected provider, with compat
// badges (read from the cleartext sidecars). Read-only, no CSRF.

export const dynamic = 'force-dynamic'

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'backups', 'read')
  checkReadRate(ctx.userId)

  const provider = new URL(req.url).searchParams.get('provider')
  if (provider !== 'gdrive' && provider !== 'onedrive') {
    throw new HttpError(400, 'invalid_provider')
  }

  let backups
  try {
    backups = await listRemoteBackups(provider)
  } catch (err) {
    if (err instanceof Error && err.message === 'not_connected') {
      throw new HttpError(400, 'not_connected')
    }
    // Provider/network failure — surface a generic reachability error.
    throw new HttpError(502, 'provider_unreachable')
  }

  return new Response(JSON.stringify({ backups }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
