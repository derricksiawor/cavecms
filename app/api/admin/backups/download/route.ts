import { createReadStream, existsSync, statSync } from 'node:fs'
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

  const file = new URL(req.url).searchParams.get('file') ?? ''
  if (!isValidArchiveBasename(file)) throw new HttpError(400, 'invalid_file')
  const path = join(resolveBackupDir(), file)
  if (!existsSync(path) || !statSync(path).isFile()) throw new HttpError(404, 'not_found')

  const size = statSync(path).size
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
