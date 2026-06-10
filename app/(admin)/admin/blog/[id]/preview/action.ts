'use server'
import { requireRole } from '@/lib/auth/requireRole'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { renderMarkdown } from '@/lib/cms/markdown'

// Server action that runs the sanitize pipeline on the editor's
// in-progress markdown so the client can show the same HTML the
// public route will eventually emit. requireRole gates access —
// only signed-in admin/editor accounts can preview; viewers and
// anonymous callers get a thrown HttpError from requireRole that
// Next.js converts to a server-action error.
//
// checkMutationRate caps abuse: even though Next's server-action
// origin check blocks classic CSRF, a logged-in editor pulled to a
// malicious page could be coerced into hammering the unified +
// rehype-sanitize pipeline (CPU-bound). The mutation bucket is
// shared with PATCH so a preview-loop attacker also burns their
// real save budget.
//
// The body length cap mirrors the PATCH route — anything bigger is
// rejected before the pipeline runs so the editor can't be used as
// a CPU exhaustion vector against the server.
const BODY_MD_MAX = 5_000_000

export async function previewMarkdown(md: string): Promise<string> {
  const ctx = await requireRole(['admin', 'editor'])
  checkMutationRate(ctx.userId)
  if (typeof md !== 'string') return ''
  if (md.length > BODY_MD_MAX) {
    throw new Error('body_too_large')
  }
  return renderMarkdown(md)
}
