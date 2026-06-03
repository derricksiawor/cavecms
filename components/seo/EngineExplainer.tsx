import { EngineLogo } from './EngineLogo'

// The honest "which engines can you actually submit to" card. Most SEO
// tools pretend you can push to a dozen engines; the truth is you submit
// to three consoles (Google, Bing, Yandex) and everything else either
// rides one of those indexes or simply crawls you. This card states that
// plainly — no fake "Submit to DuckDuckGo" buttons — so the operator
// understands exactly what coverage they're getting.
//
// Pure server-safe component (no client state): it's reference copy.

interface Row {
  logo: string | null
  name: string
  /** What you actually do for this engine. */
  reality: string
}

const ROWS: Row[] = [
  {
    logo: '/icons/googlesearchconsole.svg',
    name: 'Google',
    reality:
      'Verify in Search Console and submit your sitemap. General indexing is sitemap + crawl — there is no instant-submit for ordinary pages.',
  },
  {
    logo: '/icons/bing.svg',
    name: 'Bing',
    reality:
      'Verify in Bing Webmaster Tools and submit your sitemap. Bing can import everything from Search Console in one click, and it also accepts your IndexNow key.',
  },
  {
    logo: '/icons/duckduckgo.svg',
    name: 'DuckDuckGo & Yahoo',
    reality:
      'Both are powered by Bing. Set up Bing and you are covered — there is nothing separate to submit.',
  },
  {
    logo: '/icons/yandex.svg',
    name: 'Yandex',
    reality:
      'Verify in Yandex Webmaster and submit your sitemap. Yandex also consumes your IndexNow key.',
  },
  {
    logo: '/icons/brave.svg',
    name: 'Brave',
    reality:
      'Runs its own independent index with no submission tool. It finds you by crawling and by links from other sites — keep your sitemap healthy and earn good inbound links.',
  },
  {
    logo: null,
    name: 'Ask & others',
    reality:
      'No webmaster console. They pick you up through general crawling — nothing to submit.',
  },
]

export function EngineExplainer() {
  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
          The honest map
        </p>
        <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
          Where your pages actually go
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-warm-stone">
          You only ever submit to three places — Google, Bing, and Yandex.
          Everything else either rides one of those indexes or simply crawls
          you. Here is the real picture, with no busywork.
        </p>
      </header>

      <ul className="mt-6 space-y-3">
        {ROWS.map((row) => (
          <li
            key={row.name}
            className="flex items-start gap-4 rounded-xl bg-cream-100/40 p-4"
          >
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cream-50 ring-1 ring-warm-stone/15">
              <EngineLogo logo={row.logo} name={row.name} size={24} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-near-black">
                {row.name}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-warm-stone">
                {row.reality}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-5 rounded-xl border border-copper-300/40 bg-copper-500/[0.06] p-4">
        <p className="text-sm leading-relaxed text-near-black/80">
          <span className="font-semibold text-copper-700">
            IndexNow
          </span>{' '}
          sends one ping that notifies Bing, Yandex, Seznam, and Naver the
          moment a page changes — a head start on top of the usual crawl.{' '}
          <span className="font-semibold text-copper-700">
            Google&rsquo;s Indexing API
          </span>{' '}
          is officially only for job-posting and live-event pages; for
          everything else, Google relies on your sitemap and crawl.
        </p>
      </div>
    </article>
  )
}
