import 'server-only'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { env } from '@/lib/env'

// Filesystem layout, anchored at UPLOADS_ROOT (env-validated). setup.sh
// (Plan 09) provisions the four subdirs under `bwc:bwc 750`. The same-fs
// assertion catches a misconfigured production mount before any upload —
// rename(2) is atomic only when source and dest share a filesystem.
//
//   <root>/.tmp/<uuid>/       temp dir per upload (cleaned on success or
//                             retry); contains `original`, `thumb.webp`,
//                             `md.webp`, `lg.webp`, `og.jpg` OR
//                             `upload.pdf` depending on kind
//   <root>/originals/<uuid>   archived raw upload (audited, never served)
//   <root>/variants/<uuid>-*  served by nginx via /uploads/variants/
//   <root>/brochures-private  PDFs — served only via /api/brochure/[token]
const ROOT = env.UPLOADS_ROOT

export const PATHS = {
  tmp: path.join(ROOT, '.tmp'),
  originals: path.join(ROOT, 'originals'),
  variants: path.join(ROOT, 'variants'),
  brochures: path.join(ROOT, 'brochures-private'),
} as const

/**
 * Asserts every storage subdir lives on the same filesystem as the root.
 * rename(2) is atomic within an fs but falls back to a non-atomic copy +
 * unlink across fs boundaries — which defeats the temp+rename guarantee.
 *
 * Called ONCE at boot from instrumentation.ts (in production). Per-request
 * checks are wasted IO — the mount state only changes via operator action
 * that warrants a restart. In dev/test the check verifies dirs exist but
 * tolerates missing ones (contributors haven't run setup.sh yet); prod
 * refuses to boot until all four are mounted together.
 */
export async function assertSameFs(): Promise<void> {
  const dirs = [PATHS.tmp, PATHS.originals, PATHS.variants, PATHS.brochures]
  const isProd = env.NODE_ENV === 'production'
  const stats: Array<{ dev: number } | null> = await Promise.all(
    dirs.map((d) =>
      stat(d).catch((err: unknown) => {
        if (isProd) throw err
        // Dev/test: missing dir is OK. Log so contributors notice.
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'uploads_dir_missing',
          dir: d,
          err: err instanceof Error ? err.message : String(err),
        }))
        return null
      }),
    ),
  )
  // Same-fs check only meaningful when every dir exists.
  if (stats.some((s) => s === null)) return
  const first = stats[0]
  if (!first) throw new Error('uploads_fs_misconfig')
  for (let i = 1; i < stats.length; i++) {
    const s = stats[i]
    if (!s || s.dev !== first.dev) {
      throw new Error('uploads_fs_misconfig')
    }
  }
}

export async function tmpDirFor(uuid: string): Promise<string> {
  const dir = path.join(PATHS.tmp, uuid)
  await mkdir(dir, { recursive: true, mode: 0o750 })
  return dir
}

/**
 * Atomic write into the final tree: ensure dest dir exists, then
 * rename(srcPath, destPath). Caller must guarantee srcPath is on the same
 * filesystem as destPath (assertSameFs validates this at boot).
 */
export async function writeFinal(
  srcPath: string,
  destPath: string,
): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true, mode: 0o750 })
  await rename(srcPath, destPath)
}

export async function cleanupTmp(uuid: string): Promise<void> {
  await rm(path.join(PATHS.tmp, uuid), { recursive: true, force: true })
}
