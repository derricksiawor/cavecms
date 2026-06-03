'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Map as MapIcon, ExternalLink, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { Switch } from '@/components/inline-edit/Switch'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { SeoCard } from '@/components/seo/SeoCard'
import { CopyField } from '@/components/seo/CopyField'

// ── Shapes mirroring seo_sitemap + seo_robots ──
interface SitemapValue {
  enabled: boolean
  includePages: boolean
  includePosts: boolean
  includeProjects: boolean
  includeImages: boolean
  excludeNoindex: boolean
}
interface RobotsValue {
  extraRules: string
}

export function SitemapsCrawlClient({
  sitemap,
  robots,
  origin,
  defaults,
}: {
  sitemap: { value: unknown; version: number }
  robots: { value: unknown; version: number }
  origin: string | null
  /** Registry defaults for the two keys, passed from the server page so
   *  this client never imports the server-only settings registry. */
  defaults: { seo_sitemap: SitemapValue; seo_robots: RobotsValue }
}) {
  // Merge each stored value over its registry default so every key is
  // present + controlled regardless of the stored row shape. The casts
  // ride on the merged object.
  const sitemapValue = {
    ...defaults.seo_sitemap,
    ...((sitemap.value as Partial<SitemapValue> | null) ?? {}),
  } as SitemapValue
  const robotsValue = {
    ...defaults.seo_robots,
    ...((robots.value as Partial<RobotsValue> | null) ?? {}),
  } as RobotsValue

  // Lift the sitemap card's LIVE `enabled` into the parent so the robots
  // preview can reflect whether the `Sitemap:` line will actually be
  // emitted. app/robots.ts omits that line when seo_sitemap.enabled is
  // false — the preview must mirror that, not hardcode `true`. Seeded
  // from the merged stored value; SitemapCard pushes every toggle change
  // up via onEnabledChange (purely presentational for the preview — the
  // managed renderer remains authoritative).
  const [sitemapEnabled, setSitemapEnabled] = useState(sitemapValue.enabled)

  return (
    <section className="mt-10 space-y-6">
      <SitemapCard
        initial={sitemapValue}
        version={sitemap.version}
        origin={origin}
        onEnabledChange={setSitemapEnabled}
      />
      <RobotsCard
        initial={robotsValue}
        version={robots.version}
        origin={origin}
        sitemapEnabled={sitemapEnabled}
      />
    </section>
  )
}

// ───────────────────────────── Sitemap ─────────────────────────────

function SitemapCard({
  initial,
  version: initialVersion,
  origin,
  onEnabledChange,
}: {
  initial: SitemapValue
  version: number
  origin: string | null
  /** Bubble the LIVE `enabled` toggle up so the sibling robots preview can
   *  mirror whether the `Sitemap:` line will be emitted. */
  onEnabledChange: (enabled: boolean) => void
}) {
  const toast = useToast()
  const [form, setForm] = useState<SitemapValue>(initial)
  const [pristine, setPristine] = useState<SitemapValue>(initial)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  const enabled = form.enabled

  // Keep the parent's lifted copy in sync with this card's live toggle so
  // the robots preview tracks it as the operator flips it (before save).
  useEffect(() => {
    onEnabledChange(enabled)
  }, [enabled, onEnabledChange])

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'seo_sitemap', value: form, version }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('Those sitemap settings look off — please try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      // Adopt the authoritative server version (additive). A no-op save
      // returns 200 without bumping the DB version — blind v + 1 desyncs
      // the client and 409s the next save.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setPristine(form)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('Sitemap settings saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  const sitemapUrl = origin ? `${origin}/sitemap.xml` : null

  return (
    <SeoCard
      title="XML sitemap"
      eyebrow="Sitemaps"
      help="A machine-readable list of every page on your site that you hand to search engines so nothing gets missed. On for most sites."
      dirty={dirty}
      busy={busy}
      onSave={() => void save()}
      onUndo={() => setForm(pristine)}
    >
      <div className="space-y-6">
        <Switch
          label="Generate a sitemap"
          help="The master switch. When off, search engines fall back to crawling your links — slower and less reliable."
          checked={enabled}
          onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
        />

        <div
          className={clsx(
            'space-y-5 rounded-2xl bg-cream-100/35 p-5 transition-opacity duration-standard',
            enabled ? 'opacity-100' : 'pointer-events-none opacity-50',
          )}
          aria-hidden={!enabled}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
            What to include
          </p>
          <div className="space-y-4">
            <Switch
              label="Pages"
              help="Your standard content pages."
              checked={form.includePages}
              onChange={(v) => setForm((f) => ({ ...f, includePages: v }))}
              disabled={!enabled}
            />
            <Switch
              label="Blog posts"
              checked={form.includePosts}
              onChange={(v) => setForm((f) => ({ ...f, includePosts: v }))}
              disabled={!enabled}
            />
            <Switch
              label="Projects"
              checked={form.includeProjects}
              onChange={(v) => setForm((f) => ({ ...f, includeProjects: v }))}
              disabled={!enabled}
            />
            <Switch
              label="Images"
              help="Lists the images on each page so they can appear in image search."
              checked={form.includeImages}
              onChange={(v) => setForm((f) => ({ ...f, includeImages: v }))}
              disabled={!enabled}
            />
            <Switch
              label="Leave out hidden pages"
              help="Keeps any page you’ve set to “not in search” out of the sitemap, so your signals stay consistent. Recommended on."
              checked={form.excludeNoindex}
              onChange={(v) => setForm((f) => ({ ...f, excludeNoindex: v }))}
              disabled={!enabled}
            />
          </div>
        </div>

        {/* Link to the live sitemap. */}
        <div className="flex items-start gap-3 rounded-xl bg-cream-100/40 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-copper-500/12 text-copper-700">
            <MapIcon size={16} strokeWidth={1.9} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-relaxed text-warm-stone">
              {sitemapUrl
                ? 'This is your live sitemap — the exact file you submit to each search console.'
                : 'Your live sitemap appears at /sitemap.xml once you’ve set your Site URL under Settings → General.'}
            </p>
            {sitemapUrl && (
              <div className="mt-2.5">
                <CopyField
                  value={sitemapUrl}
                  toastMessage="Sitemap URL copied."
                  help={
                    <a
                      href="/sitemap.xml"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-copper-700 underline-offset-2 hover:underline"
                    >
                      View your live sitemap
                      <ExternalLink size={12} strokeWidth={2} aria-hidden />
                    </a>
                  }
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </SeoCard>
  )
}

// ───────────────────────────── robots.txt ─────────────────────────────

// The managed lines that robots.ts ALWAYS emits — kept in sync with
// app/robots.ts (MANAGED_DISALLOW + the Allow:/ and Sitemap line). The
// preview composes the operator's additions ON TOP of these so what they
// see here matches the file crawlers actually receive.
const MANAGED_DISALLOW = ['/admin', '/api/']

// Client mirror of robots.ts's parseExtraRules — same recognised
// directives, same skip-everything-else discipline. Used ONLY for the
// live preview + the additive-only warning; the server is the source of
// truth and re-validates on save.
//
// ⚠ TRIPLICATED PARSER — keep all THREE in sync when changing the set of
// recognised directives or their semantics:
//   1. THIS function (client live-preview + ignored-lines warning).
//   2. app/robots.ts `parseExtraRules` (the authoritative renderer that
//      actually emits robots.txt to crawlers).
//   3. the `seo_robots`.extraRules `.refine(...)` in
//      lib/cms/settings-registry.ts (the save-time validation gate).
// They are NOT refactored into one shared module on purpose: a live
// preview runs client-side and can't round-trip through the server
// renderer on every keystroke, and the registry refine must run in the
// edge/runtime-agnostic validation layer. If they drift, the operator's
// preview will lie about what crawlers receive — so any change here MUST
// be mirrored to the other two.
function parseExtraRules(extraRules: string): {
  disallow: string[]
  allow: string[]
  crawlDelay?: number
  /** Lines that won't take effect (new groups, Sitemap/Host, re-opening
   *  the protected surface, or full-site Disallow) — surfaced as a warning. */
  ignored: string[]
} {
  const disallow: string[] = []
  const allow: string[] = []
  const ignored: string[] = []
  let crawlDelay: number | undefined

  for (const raw of extraRules.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const dis = /^disallow\s*:\s*(.*)$/i.exec(line)
    if (dis) {
      const path = (dis[1] ?? '').trim()
      if (path === '' || path === '/') {
        if (path === '/') ignored.push(line)
        continue
      }
      disallow.push(path)
      continue
    }

    const alw = /^allow\s*:\s*(.*)$/i.exec(line)
    if (alw) {
      const path = (alw[1] ?? '').trim()
      if (path === '') continue
      if (/^\/(admin|api)\b/i.test(path)) {
        ignored.push(line)
        continue
      }
      allow.push(path)
      continue
    }

    const cd = /^crawl-delay\s*:\s*(\d+(?:\.\d+)?)\s*$/i.exec(line)
    if (cd) {
      const n = Number(cd[1] ?? '')
      if (Number.isFinite(n) && n >= 0) crawlDelay = n
      continue
    }

    // User-agent / Sitemap / Host / unknown → ignored (won't take effect).
    if (
      /^user-agent\s*:/i.test(line) ||
      /^sitemap\s*:/i.test(line) ||
      /^host\s*:/i.test(line)
    ) {
      ignored.push(line)
      continue
    }
    ignored.push(line)
  }

  return { disallow, allow, crawlDelay, ignored }
}

// Compose the FULL resulting robots.txt the way crawlers will see it —
// the single managed `User-agent: *` group with the managed Disallows
// re-asserted first, then the operator's parsed additions, then the
// Sitemap line (only when the sitemap is enabled) + Host.
function composeRobots(
  extraRules: string,
  origin: string | null,
  sitemapEnabled: boolean,
): string {
  const host = origin ? new URL(origin).host : null
  const parsed = parseExtraRules(extraRules)
  const disallow = Array.from(new Set([...MANAGED_DISALLOW, ...parsed.disallow]))
  const allow = Array.from(new Set(['/', ...parsed.allow]))

  const lines: string[] = ['User-agent: *']
  for (const a of allow) lines.push(`Allow: ${a}`)
  for (const d of disallow) lines.push(`Disallow: ${d}`)
  if (parsed.crawlDelay !== undefined) lines.push(`Crawl-delay: ${parsed.crawlDelay}`)
  lines.push('')
  if (sitemapEnabled && origin) lines.push(`Sitemap: ${origin}/sitemap.xml`)
  if (host) lines.push(`Host: ${host}`)
  return lines.join('\n')
}

function RobotsCard({
  initial,
  version: initialVersion,
  origin,
  sitemapEnabled,
}: {
  initial: RobotsValue
  version: number
  origin: string | null
  /** The sibling sitemap card's LIVE `enabled` value — threaded in so the
   *  preview's `Sitemap:` line matches what app/robots.ts actually emits
   *  (which omits it when seo_sitemap.enabled is false). */
  sitemapEnabled: boolean
}) {
  const toast = useToast()
  const [form, setForm] = useState<RobotsValue>(initial)
  const [pristine, setPristine] = useState<RobotsValue>(initial)
  const [version, setVersion] = useState(initialVersion)
  const [busy, setBusy] = useState(false)
  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  const ignored = useMemo(
    () => parseExtraRules(form.extraRules).ignored,
    [form.extraRules],
  )
  // Pass the LIVE sitemap-enabled flag (lifted from the sibling card) into
  // composeRobots so the preview's `Sitemap:` line appears only when the
  // sitemap is actually on — mirroring app/robots.ts exactly, instead of
  // the old hardcoded `true` that showed the line even when disabled.
  const preview = useMemo(
    () => composeRobots(form.extraRules, origin, sitemapEnabled),
    [form.extraRules, origin, sitemapEnabled],
  )

  const save = useCallback(async () => {
    if (busy || !dirty) return
    setBusy(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: 'seo_robots',
          value: { extraRules: form.extraRules },
          version,
        }),
      })
      if (r.status === 400 || r.status === 422) {
        toast.error('Some of those rules can’t be applied — see the note below and adjust.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      // Adopt the authoritative server version (additive) — no-op saves
      // don't bump the DB version, so blind v + 1 desyncs + 409s next.
      const respBody = (await r.json().catch(() => null)) as { version?: number } | null
      setPristine(form)
      setVersion(typeof respBody?.version === 'number' ? respBody.version : (v) => v + 1)
      toast.success('robots.txt rules saved.')
    } finally {
      setBusy(false)
    }
  }, [busy, dirty, form, version, toast])

  return (
    <SeoCard
      title="Crawl rules (robots.txt)"
      eyebrow="Crawling"
      help="Extra instructions for search engine crawlers. Your admin and internal pages are always kept private — you can only add more restrictions here, never remove the built-in ones."
      dirty={dirty}
      busy={busy}
      onSave={() => void save()}
      onUndo={() => setForm(pristine)}
    >
      <div className="space-y-5">
        {/* Additive-only explainer. */}
        <div className="flex items-start gap-3 rounded-xl border border-copper-300/40 bg-copper-500/5 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-copper-500/12 text-copper-700">
            <AlertTriangle size={16} strokeWidth={2} aria-hidden />
          </span>
          <p className="text-[13px] leading-relaxed text-warm-stone">
            <strong className="font-semibold text-near-black">
              You can only add restrictions.
            </strong>{' '}
            Add lines like{' '}
            <code className="font-mono text-[12px] text-near-black">
              Disallow: /private
            </code>
            ,{' '}
            <code className="font-mono text-[12px] text-near-black">
              Allow: /public
            </code>
            , or{' '}
            <code className="font-mono text-[12px] text-near-black">
              Crawl-delay: 10
            </code>
            . You can’t open your admin or internal pages to crawlers, and you
            can’t hide your whole site here — use the search-visibility switch
            for that.
          </p>
        </div>

        <label className="block">
          <span className="block text-sm font-medium text-near-black">
            Your additional rules
          </span>
          <textarea
            value={form.extraRules}
            onChange={(e) => setForm({ extraRules: e.target.value })}
            maxLength={4000}
            rows={6}
            spellCheck={false}
            placeholder={'# One rule per line, for example:\nDisallow: /drafts\nCrawl-delay: 10'}
            className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 font-mono text-[12px] leading-relaxed text-near-black placeholder:text-warm-stone/50 transition-all duration-quick ease-standard hover:border-warm-stone/40 focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40"
          />
          <span className="mt-1 block text-[11px] text-warm-stone">
            Lines beginning with <code className="font-mono">#</code> are notes
            and ignored by crawlers.
          </span>
        </label>

        {/* Warning for lines that won't take effect — warn, don't block. */}
        {ignored.length > 0 && (
          <div className="rounded-xl border border-amber-300/50 bg-amber-50/40 p-4">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
              <AlertTriangle size={15} strokeWidth={2} aria-hidden />
              Some lines won’t take effect
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-warm-stone">
              These either try to open a protected area, hide your whole site,
              or use a directive that’s managed for you — they’ll be left out:
            </p>
            <ul className="mt-2 space-y-1">
              {ignored.map((line, i) => (
                <li
                  key={`${line}-${i}`}
                  className="break-all rounded-md bg-amber-100/50 px-2.5 py-1 font-mono text-[11px] text-amber-900"
                >
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* LIVE preview of the FULL resulting robots.txt. */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
              What crawlers will see
            </p>
            <a
              href="/robots.txt"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-copper-700 underline-offset-2 hover:underline"
            >
              View your live robots.txt
              <ExternalLink size={12} strokeWidth={2} aria-hidden />
            </a>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-warm-stone/20 bg-near-black/95 p-4 font-mono text-[12px] leading-relaxed text-cream-50">
            {preview}
          </pre>
          <p className="mt-1.5 text-[11px] text-warm-stone">
            The <span className="font-mono">Sitemap</span> line appears only
            while your sitemap is turned on above. The first two{' '}
            <span className="font-mono">Disallow</span> lines are always present
            to keep your admin and internal pages private.
          </p>
        </div>
      </div>
    </SeoCard>
  )
}
