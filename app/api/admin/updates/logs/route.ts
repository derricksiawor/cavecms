import { existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'

// GET /api/admin/updates/logs — admin-gated tails of the update
// orchestrator's log files, for the "View technical details" affordance in
// the update modal's failed state. Before this existed a failed update gave
// the operator a one-line error and NO way to see what actually happened —
// the step logs sat on disk with nothing in the product surfacing them.
//
// Security shape:
//   - The client sends NOTHING — no paths, no names, no params. The set of
//     readable files is a fixed allowlist of basenames inside the resolved
//     log dir, so this can never become an arbitrary-file-read.
//   - Tails only (last TAIL_BYTES per file) — bounded response regardless
//     of how large a build log grew.
//   - Admin role + read rate limit, same gate as the status route.

export const dynamic = 'force-dynamic'

// Keep in sync with the orchestrator's per-step log names
// (scripts/cavecms-update.sh) + the apply route's spawn log.
const LOG_BASENAMES = [
  'cavecms-update-spawn.log',
  'preflight.log',
  'tarball-download.log',
  'tarball-extract.log',
  'snapshot.log',
  'db-backup.log',
  'install-migrate.log',
  'pnpm-install.log',
  'build.log',
  'pm2-reload.log',
  'pm2-save.log',
  'verify-loop.log',
  'watchdog-spawn.log',
  'watchdog.log',
] as const

const TAIL_BYTES = 16 * 1024 // per file — plenty for "what failed", bounded for the wire

// Read-side mirror of the apply route's resolveWritableLogDir() candidate
// order. Reading doesn't need writability — pick the first dir that exists.
function resolveLogDir(): string | null {
  const candidates = [
    process.env.CAVECMS_LOG_DIR,
    process.env.CAVECMS_STATE_DIR && join(process.env.CAVECMS_STATE_DIR, 'logs'),
    '/var/log/cavecms',
    join(tmpdir(), 'cavecms'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

function tailFile(path: string): { tail: string; sizeBytes: number; mtime: string } | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.size === 0) return null
      const start = Math.max(0, st.size - TAIL_BYTES)
      const len = st.size - start
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, start)
      let tail = buf.toString('utf8')
      // Drop a partial first line when we cut mid-file.
      if (start > 0) {
        const nl = tail.indexOf('\n')
        if (nl >= 0) tail = tail.slice(nl + 1)
      }
      return { tail, sizeBytes: st.size, mtime: st.mtime.toISOString() }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)

  const dir = resolveLogDir()
  const logs: Array<{ name: string; tail: string; sizeBytes: number; mtime: string }> = []
  if (dir) {
    for (const name of LOG_BASENAMES) {
      const entry = tailFile(join(dir, name))
      if (entry) logs.push({ name, ...entry })
    }
    // Most-recently-written first — the file that just failed leads.
    logs.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  }

  return new Response(JSON.stringify({ dir, logs }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
