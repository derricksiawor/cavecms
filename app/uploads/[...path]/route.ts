// Streams uploaded variants from disk when the operator's reverse proxy
// (nginx / Apache) isn't aliasing /uploads/* to UPLOADS_ROOT directly.
//
// In a fully-tuned production deploy, nginx (Appendix A in
// instructions.md) or Apache (Appendix B) serves /uploads/* directly
// from disk for performance. But shipping a CaveCMS install behind a
// minimal proxy that only `proxy_pass`-es everything to the Node port
// must STILL work — the in-wizard logo preview, the rendered site
// header / footer logo, and the admin media picker thumbnails all
// reference /uploads/variants/<uuid>-*.webp by relative URL. Without
// this route the Node listener has no handler for /uploads/*, every
// image request 404s, and the operator sees broken-image glyphs across
// the wizard + admin + public site.
//
// The vhost alias remains the preferred (faster) path in production.
// When it's present, requests for /uploads/* never reach Next.js. When
// it's absent, this route ensures the same URL still resolves to the
// same file with the same bytes, just via Node's pipe instead of nginx
// sendfile.
//
// Security:
// - `brochures-private/*` is operator-private and gated behind signed
//   tokens at /api/brochure/[token]. Direct disk reads of those PDFs
//   are forbidden — return 404 (mirrors the nginx vhost's
//   `location ^~ /uploads/brochures-private/` block).
// - Defence-in-depth path-traversal check: reject any segment of `..`,
//   leading `/`, or null byte BEFORE resolving against UPLOADS_ROOT.
//   The Next.js dynamic-route segment matcher already prevents `..`
//   from appearing in `params.path`, but explicit verification keeps
//   the invariant local to this file.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  // Operator-uploaded custom fonts (served self-hosted from /uploads/fonts/).
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

function safeJoin(root: string, segments: string[]): string | null {
  for (const seg of segments) {
    if (!seg) return null
    if (seg === '.' || seg === '..') return null
    if (seg.includes('\0')) return null
    if (seg.includes('/') || seg.includes('\\')) return null
  }
  const resolved = path.resolve(root, ...segments)
  const rootResolved = path.resolve(root) + path.sep
  if (!resolved.startsWith(rootResolved) && resolved !== path.resolve(root)) {
    return null
  }
  return resolved
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await ctx.params
  if (!Array.isArray(segments) || segments.length === 0) {
    return new NextResponse(null, { status: 404 })
  }

  // Operator-private brochure attachments — disk-level access forbidden
  // regardless of session. Public access flows through
  // /api/brochure/[token] which validates a signed download token.
  if (segments[0] === 'brochures-private') {
    return new NextResponse(null, { status: 404 })
  }

  const filePath = safeJoin(env.UPLOADS_ROOT, segments)
  if (!filePath) {
    return new NextResponse(null, { status: 404 })
  }

  let info
  try {
    info = await stat(filePath)
  } catch {
    return new NextResponse(null, { status: 404 })
  }
  if (!info.isFile()) {
    return new NextResponse(null, { status: 404 })
  }

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME[ext] ?? 'application/octet-stream'

  const nodeStream = createReadStream(filePath)
  const webStream = Readable.toWeb(nodeStream) as ReadableStream

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(info.size),
      'Cache-Control': 'public, max-age=2592000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
