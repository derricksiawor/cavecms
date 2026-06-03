// Shared engine metadata for the SEO Connect & Verify surfaces. One
// source of truth so the IndexNow toggle, the explainer card, and any
// future engine-aware UI agree on labels, logos, and the honest
// "what does submitting here actually do" copy.
//
// `logo` points at a downloaded official brand SVG under /public/icons
// (#0.57 — never hand-rolled). Engines WITHOUT a usable official square
// mark (the IndexNow protocol itself; Seznam, whose only official asset is
// a wide wordmark unreadable at tile size) carry `logo: null`, and
// EngineLogo falls back to a clean lucide glyph (#0.58) — never an
// invented or hand-drawn logo.

import type { Engine } from '@/lib/seo/indexnow/submit'

export interface EngineMeta {
  /** The IndexNow engine key (matches lib/seo/indexnow/submit Engine). */
  key: Engine
  /** Operator-facing name. */
  name: string
  /** Path to the official brand SVG, or null when none exists. */
  logo: string | null
  /** One plain line: what pinging this endpoint actually does. */
  note: string
}

// The five IndexNow endpoints. `indexnow` is the shared clearing-house
// (one ping fans out to the whole IndexNow network); the others are the
// engines that ALSO consume IndexNow directly.
export const INDEXNOW_ENGINES: EngineMeta[] = [
  {
    key: 'indexnow',
    name: 'IndexNow',
    logo: null,
    note: 'One ping shared with the whole IndexNow network.',
  },
  {
    key: 'bing',
    name: 'Bing',
    logo: '/icons/bing.svg',
    note: 'Microsoft Bing — also covers DuckDuckGo and Yahoo.',
  },
  {
    key: 'yandex',
    name: 'Yandex',
    logo: '/icons/yandex.svg',
    note: 'Yandex Search — the major engine in Russia and nearby.',
  },
  {
    key: 'seznam',
    name: 'Seznam',
    logo: null,
    note: 'Seznam — the leading search engine in Czechia.',
  },
  {
    key: 'naver',
    name: 'Naver',
    logo: '/icons/naver.svg',
    note: 'Naver — the leading search portal in South Korea.',
  },
]

// Verification consoles (Connect & Verify guides). These are the engines
// with a real webmaster console where you verify ownership + submit a
// sitemap. Google / Bing / Yandex are the three that matter for most
// sites; Pinterest is a bonus for image-heavy sites.
export const VERIFY_ENGINES: {
  key: 'google' | 'bing' | 'yandex'
  name: string
  logo: string
  consoleName: string
  consoleUrl: string
} [] = [
  {
    key: 'google',
    name: 'Google',
    logo: '/icons/googlesearchconsole.svg',
    consoleName: 'Google Search Console',
    consoleUrl: 'https://search.google.com/search-console',
  },
  {
    key: 'bing',
    name: 'Bing',
    logo: '/icons/bing.svg',
    consoleName: 'Bing Webmaster Tools',
    consoleUrl: 'https://www.bing.com/webmasters',
  },
  {
    key: 'yandex',
    name: 'Yandex',
    logo: '/icons/yandex.svg',
    consoleName: 'Yandex Webmaster',
    consoleUrl: 'https://webmaster.yandex.com',
  },
]
