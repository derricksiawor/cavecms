import Link from 'next/link'
import { sql } from 'drizzle-orm'
import {
  ArrowUpRight,
  Check,
  Circle,
  Globe,
  Map as MapIcon,
  ShieldCheck,
  Zap,
  EyeOff,
  FileWarning,
} from 'lucide-react'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { getSetting } from '@/lib/cms/getSettings'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { isMissingTable } from '@/lib/db/errors'
import { EngineLogo } from '@/components/seo/EngineLogo'
import { VERIFY_ENGINES } from '@/components/seo/engines'

// SEO Overview — the hub of the SEO section. A setup-progress checklist,
// per-engine verification status, and two cheap "quick win" counts
// (noindexed published pages, published pages missing a meta
// description). Every tile links into the sub-page that fixes it, so an
// operator can read the whole SEO posture at a glance and click straight
// to the work (#0.592 — content links by association, not just chrome).
//
// All reads are cheap COUNT/scalar queries fired in parallel; the page is
// force-dynamic (settings + content change between visits) and never
// caches a stale posture.

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface CountRow {
  n: number | string
}

// One COUNT across a content table with a WHERE clause. posts may not
// exist on early deploys — feature-detect + treat as 0.
async function countSafe(query: ReturnType<typeof sql>): Promise<number> {
  try {
    const [rows] = (await db.execute(query)) as unknown as [CountRow[]]
    return Number(rows[0]?.n ?? 0)
  } catch (err) {
    if (isMissingTable(err)) return 0
    throw err
  }
}

export default async function SeoOverviewPage() {
  await requireRoleOrRedirect(['admin'])

  // Fire every read in parallel — settings + the cheap content counts.
  const [
    origin,
    sitemap,
    webmaster,
    indexnow,
    indexing,
    noindexPages,
    noindexProjects,
    noindexPosts,
    noDescPages,
    noDescProjects,
    noDescPosts,
  ] = await Promise.all([
    getSiteOrigin(),
    getSetting('seo_sitemap'),
    getSetting('seo_webmaster'),
    getSetting('seo_indexnow'),
    getSetting('seo_indexing'),
    countSafe(sql`SELECT COUNT(*) AS n FROM pages WHERE published = 1 AND deleted_at IS NULL AND robots_noindex = 1`),
    countSafe(sql`SELECT COUNT(*) AS n FROM projects WHERE published = TRUE AND deleted_at IS NULL AND robots_noindex = 1`),
    countSafe(sql`SELECT COUNT(*) AS n FROM posts WHERE published = TRUE AND deleted_at IS NULL AND robots_noindex = 1`),
    countSafe(sql`SELECT COUNT(*) AS n FROM pages WHERE published = 1 AND deleted_at IS NULL AND (seo_description IS NULL OR seo_description = '')`),
    countSafe(sql`SELECT COUNT(*) AS n FROM projects WHERE published = TRUE AND deleted_at IS NULL AND (seo_description IS NULL OR seo_description = '')`),
    countSafe(sql`SELECT COUNT(*) AS n FROM posts WHERE published = TRUE AND deleted_at IS NULL AND (seo_description IS NULL OR seo_description = '')`),
  ])

  const verificationCount = VERIFY_ENGINES.reduce(
    (n, e) => n + ((webmaster[e.key]?.length ?? 0) > 0 ? 1 : 0),
    0,
  )
  const anyVerification = verificationCount > 0
  const discouraged = indexing.discourageSearchEngines === true

  const checklist = [
    {
      icon: Globe,
      label: 'Site URL is set',
      done: !!origin,
      detail: origin
        ? origin
        : 'Search engines need your public address before anything else works.',
      href: '/admin/settings',
      cta: 'Set it in Settings → General',
    },
    {
      icon: MapIcon,
      label: 'Sitemap is on',
      done: sitemap.enabled === true,
      detail:
        sitemap.enabled === true
          ? 'Crawlers can discover every published page.'
          : 'Your sitemap is off — engines can’t see your full page list.',
      href: '/admin/seo/sitemaps',
      cta: 'Open Sitemaps & Crawl',
    },
    {
      icon: ShieldCheck,
      label: 'Ownership verified with at least one engine',
      done: anyVerification,
      detail: anyVerification
        ? `Verified with ${verificationCount} of ${VERIFY_ENGINES.length} consoles.`
        : 'Add a verification code so you can manage your site in a search console.',
      href: '/admin/seo/connect',
      cta: 'Open Connect & Verify',
    },
    {
      icon: Zap,
      label: 'Instant indexing (IndexNow) is on',
      done: indexnow.enabled === true && !!indexnow.key,
      detail:
        indexnow.enabled === true && !!indexnow.key
          ? 'New and changed pages ping Bing, Yandex, and more the moment they publish.'
          : 'Turn on IndexNow to notify engines instantly when a page changes.',
      href: '/admin/seo/connect',
      cta: 'Open Connect & Verify',
    },
  ]

  const doneCount = checklist.filter((c) => c.done).length
  const noindexTotal = noindexPages + noindexProjects + noindexPosts
  const noDescTotal = noDescPages + noDescProjects + noDescPosts

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Search engine optimisation
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        SEO
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Everything search engines need to find, understand, and rank your site
        — in one place. Start with the checklist below, then fine-tune your
        titles, social cards, sitemaps, and search-console connections.
      </p>

      {/* Loud banner when the whole site is set to discourage engines. */}
      {discouraged && (
        <div className="mt-8 flex items-start gap-3 rounded-2xl border border-red-300/60 bg-red-50/60 p-5">
          <EyeOff className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-red-900">
              Your site is hidden from search engines
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-red-800">
              “Discourage search engines” is on, so every page asks not to be
              indexed. Turn it off when you’re ready to be found.{' '}
              <Link
                href="/admin/seo/titles"
                className="font-semibold underline underline-offset-2"
              >
                Manage it in Titles &amp; Meta →
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* ── Setup progress ── */}
      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">
            Setup progress
          </h2>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-copper-700">
            {doneCount} of {checklist.length} done
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {checklist.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="group flex flex-col gap-2 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5 backdrop-blur-sm transition-all duration-quick ease-standard hover:border-copper-300 hover:bg-cream-100/50"
            >
              <span className="flex items-center justify-between">
                <span
                  className={
                    item.done
                      ? 'inline-flex h-9 w-9 items-center justify-center rounded-xl bg-copper-500/15 text-copper-700'
                      : 'inline-flex h-9 w-9 items-center justify-center rounded-xl bg-warm-stone/10 text-warm-stone'
                  }
                >
                  <item.icon className="h-5 w-5" aria-hidden />
                </span>
                {item.done ? (
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-copper-700">
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    Done
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                    <Circle className="h-3 w-3" aria-hidden />
                    To do
                  </span>
                )}
              </span>
              <span className="text-sm font-semibold text-near-black">
                {item.label}
              </span>
              <span className="text-[13px] leading-relaxed text-warm-stone">
                {item.detail}
              </span>
              {!item.done && (
                <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-copper-700">
                  {item.cta}
                  <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden />
                </span>
              )}
            </Link>
          ))}
        </div>
      </section>

      {/* ── Verification status per engine ── */}
      <section className="mt-10">
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">
          Search console verification
        </h2>
        <p className="mt-1 text-sm text-warm-stone">
          Whether each console can confirm you own this site.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {VERIFY_ENGINES.map((engine) => {
            const verified = (webmaster[engine.key]?.length ?? 0) > 0
            return (
              <div
                key={engine.key}
                className="flex items-center gap-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4 backdrop-blur-sm"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cream-50 ring-1 ring-warm-stone/15">
                  <EngineLogo logo={engine.logo} name={engine.name} size={24} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-near-black">
                    {engine.name}
                  </p>
                  <p
                    className={
                      verified
                        ? 'text-[11px] font-semibold uppercase tracking-[0.14em] text-copper-700'
                        : 'text-[11px] font-semibold uppercase tracking-[0.14em] text-warm-stone'
                    }
                  >
                    {verified ? 'Verified' : 'Not verified'}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
        <Link
          href="/admin/seo/connect"
          className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-copper-700 hover:text-copper-800"
        >
          Add or update verification codes
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </section>

      {/* ── Quick wins ── */}
      <section className="mt-10">
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">
          Quick wins
        </h2>
        <p className="mt-1 text-sm text-warm-stone">
          Small fixes that improve how your published content shows up in
          search.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <QuickWin
            icon={FileWarning}
            count={noDescTotal}
            title="Published items with no meta description"
            doneCopy="Every published page, post, and project has a meta description."
            todoCopy="Without a description, search engines write their own snippet for you. Add one to control how each result reads."
            href="/admin/seo/titles"
            cta="Set description templates"
          />
          <QuickWin
            icon={EyeOff}
            count={noindexTotal}
            title="Published items asking not to be indexed"
            doneCopy="No published item is hidden from search by a noindex flag."
            todoCopy="These pages are published but tell engines to skip them. Intentional for thank-you or utility pages — worth a check otherwise."
            href="/admin/pages"
            cta="Review your pages"
            // A noindex count is informational, not always a problem — it
            // reads as a neutral "worth a look", never an alarm.
            neutral
          />
        </div>
      </section>
    </div>
  )
}

function QuickWin({
  icon: Icon,
  count,
  title,
  doneCopy,
  todoCopy,
  href,
  cta,
  neutral = false,
}: {
  icon: typeof FileWarning
  count: number
  title: string
  doneCopy: string
  todoCopy: string
  href: string
  cta: string
  neutral?: boolean
}) {
  const clear = count === 0
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <span
          className={
            clear
              ? 'inline-flex h-9 w-9 items-center justify-center rounded-xl bg-copper-500/15 text-copper-700'
              : neutral
                ? 'inline-flex h-9 w-9 items-center justify-center rounded-xl bg-warm-stone/10 text-warm-stone'
                : 'inline-flex h-9 w-9 items-center justify-center rounded-xl bg-copper-500/15 text-copper-700'
          }
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <span
          className={
            clear
              ? 'font-serif text-3xl font-bold tabular-nums text-copper-700'
              : 'font-serif text-3xl font-bold tabular-nums text-near-black'
          }
        >
          {count}
        </span>
      </div>
      <p className="text-sm font-semibold text-near-black">{title}</p>
      <p className="text-[13px] leading-relaxed text-warm-stone">
        {clear ? doneCopy : todoCopy}
      </p>
      {!clear && (
        <Link
          href={href}
          className="inline-flex w-fit items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-copper-700 hover:text-copper-800"
        >
          {cta}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      )}
    </div>
  )
}
