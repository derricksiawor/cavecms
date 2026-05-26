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

// Inject `id` slug attributes on h2/h3/h4 in the sanitized HTML so
// /admin/help#ai-assistant scrolls to the right section. The shared
// `renderMarkdown` sanitizer strips `id` to keep the blog pipeline
// strict; we add them back here because this source is a fixed,
// repo-controlled file with no untrusted input.
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function injectHeadingAnchors(html: string): string {
  // [\s\S]+? (rather than [^<]+?) so headings with inline children
  // — e.g. `<h3>Use the <code>token</code></h3>` — still get an id.
  // slugifyHeading strips inner tags before slugging.
  //
  // Two same-text headings under different sections would otherwise
  // produce duplicate ids; we suffix collisions with `-2`, `-3`, ...
  // so each id stays unique and the browser scrolls to the closest
  // one when an anchor URL is followed.
  const seen = new Map<string, number>()
  return html.replace(/<(h[234])>([\s\S]+?)<\/\1>/g, (full, tag, inner) => {
    const base = slugifyHeading(inner)
    if (!base) return full
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const slug = count === 1 ? base : `${base}-${count}`
    return `<${tag} id="${slug}">${inner}</${tag}>`
  })
}

function loadHelpHtml(): Promise<string> {
  cachedHtml ??= (async () => {
    try {
      const md = await readFile(
        path.join(process.cwd(), 'docs/admin-help.md'),
        'utf8',
      )
      const rendered = await renderMarkdown(md)
      return injectHeadingAnchors(rendered)
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
