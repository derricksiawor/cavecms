import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { resolveBackupDir, isValidArchiveBasename } from '@/lib/backups/store'

// GET /api/admin/backups/download?file=<basename> — stream a local backup to
// the operator. Basename is strictly validated (no traversal). Admin-gated.

export const dynamic = 'force-dynamic'

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)

  // Block cross-site forced downloads (drive-by): a backup made with
  // --include-env carries secrets. Browsers send Sec-Fetch-Site on navigations
  // — reject anything that isn't same-origin / same-site / a direct address-bar
  // navigation. (CORS already prevents an attacker page from READING the bytes;
  // this stops it from triggering the download to the admin's disk at all.)
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    throw new HttpError(403, 'cross_site_download_blocked')
  }

  const file = new URL(req.url).searchParams.get('file') ?? ''
  if (!isValidArchiveBasename(file)) throw new HttpError(400, 'invalid_file')
  const path = join(resolveBackupDir(), file)
  let st
  try {
    st = statSync(path)
  } catch {
    throw new HttpError(404, 'not_found')
  }
  if (!st.isFile()) throw new HttpError(404, 'not_found')

  const size = st.size
  const nodeStream = createReadStream(path)
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream

  return new Response(webStream, {
    status: 200,
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${file}"`,
      'cache-control': 'private, no-store',
    },
  })
})
