import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { renderMarkdown } from '@/lib/cms/markdown'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

// One-shot module-scope render. The help doc is repo-static — the file
// only changes when a new build deploys, at which point the module is
// re-initialised. Caching here avoids re-reading + re-rendering the
// markdown on every request (markdown pipeline is unified + remark +
// rehype-sanitize + stringify — heavier than a strcmp).
//
// On a missing-file error (e.g. docs/ not bundled in .next/standalone),
// we render a graceful fallback instead of throwing into the Next
// error boundary. next.config.ts also adds an explicit trace include
// so this fallback should never fire in a well-built deploy.
const FALLBACK_HTML =
  '<h1>Admin help</h1>' +
  '<p>The help content is temporarily unavailable. Please ping the admin channel.</p>'

let cachedHtml: Promise<string> | null = null

function loadHelpHtml(): Promise<string> {
  cachedHtml ??= (async () => {
    try {
      const md = await readFile(
        path.join(process.cwd(), 'docs/admin-help.md'),
        'utf8',
      )
      return await renderMarkdown(md)
    } catch (err) {
      // On failure DO NOT cache the error path — a transient EBUSY /
      // EMFILE should be retried on the next request. Reset the cache
      // so the next call attempts to read again.
      cachedHtml = null
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'admin_help_render_failed',
          err_name: err instanceof Error ? err.name : 'unknown',
        }),
      )
      return FALLBACK_HTML
    }
  })()
  return cachedHtml
}

export default async function Help() {
  await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const html = await loadHelpHtml()
  return (
    <div className="max-w-3xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Reference
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Admin help
      </h1>
      <article
        className="prose prose-lg mt-10 max-w-none prose-headings:font-serif prose-headings:tracking-tight prose-headings:text-near-black prose-p:text-warm-stone prose-strong:text-near-black prose-a:text-copper-700 prose-li:text-warm-stone"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
