import { writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { readJsonBody } from '@/lib/api/jsonBody'
import { getSetting } from '@/lib/cms/getSettings'
import { PATHS } from '@/lib/media/storage'
import { sniffFontFormat } from '@/lib/typography/fontFormat'
import {
  GOOGLE_FONTS,
  googleFontBySlug,
  googleKey,
  type GoogleFontMeta,
} from '@/lib/typography/googleFonts'
import {
  mutateGoogleFonts,
  type GoogleActivatedFont,
} from '@/lib/typography/googleFontsStore'

// "All Google Fonts, self-hosted on demand."
//
// GET  — return the full ~1,934-family metadata catalog + the operator's
//        already-activated list, for the admin picker.
// POST — ACTIVATE one family: the SERVER fetches its woff2 ONCE from Google,
//        verifies it, stores it self-hosted under UPLOADS_ROOT/fonts, and
//        registers it in the `google_fonts` setting. After this, the public
//        layout emits a self-hosted @font-face for it — a VISITOR never talks
//        to Google (privacy / GDPR; the product's self-hosted promise).
//
// Session-admin only — requireCsrf rejects a bearer token (no CSRF header),
// so API tokens can't trigger activation fetches.

const MAX_FONT = 5 * 1024 * 1024 // 5 MB ceiling on a downloaded woff2.
const MAX_FONTS = 100 // mirrors settings-registry google_fonts .max(100).
const FETCH_TIMEOUT_MS = 10_000

// SSRF guard: the activation flow ONLY ever talks to these two Google hosts.
// The CSS2 endpoint returns @font-face rules whose `src` points at gstatic;
// we refuse to follow a `src` to any other host (a poisoned/MITM'd CSS
// response can't redirect us into fetching from an arbitrary origin).
const GOOGLE_CSS_HOST = 'fonts.googleapis.com'
const GSTATIC_HOST = 'fonts.gstatic.com'

// A real desktop Chrome UA. Google's CSS2 endpoint serves woff2 `src` URLs
// ONLY to browsers that advertise woff2 support; without a browser UA it
// returns legacy ttf. This is the SERVER's one-time activation fetch — the
// ONLY external request the whole feature makes on the public/visitor path's
// behalf. Visitors themselves are NEVER pointed at Google.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function googleCss2Url(meta: GoogleFontMeta): string {
  // Family name: spaces → '+' per the CSS2 API. Variable families request the
  // full wght axis; static families request 400 (the regular weight we store).
  const family = meta.family.replace(/ /g, '+')
  const axis = meta.variable
    ? `:wght@${meta.variable[0]}..${meta.variable[1]}`
    : ':wght@400'
  return `https://${GOOGLE_CSS_HOST}/css2?family=${family}${axis}&display=swap`
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    // `redirect: 'manual'`-equivalent isn't needed — we re-validate the final
    // host below — but we DO re-check the gstatic URL's host before download.
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// Pull the `latin`-subset woff2 src URL out of Google's CSS2 response. The
// response is a sequence of @font-face blocks, each preceded by a
// `/* latin */` (or `/* latin-ext */`, `/* cyrillic */`, …) comment. We want
// the plain `latin` block's gstatic woff2 URL. Falls back to the FIRST woff2
// src in the document if no `/* latin */` marker is found (some families only
// ship one subset).
function extractLatinWoff2Url(css: string): string | null {
  const blocks = css.split('@font-face')
  let firstWoff2: string | null = null
  let latinWoff2: string | null = null
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] ?? ''
    const m = block.match(/url\((https:\/\/[^)]+\.woff2)\)\s*format\(['"]woff2['"]\)/i)
    if (!m) continue
    const url = m[1]!
    if (!firstWoff2) firstWoff2 = url
    // The subset comment that introduces THIS @font-face lives at the tail of
    // the PREVIOUS split chunk.
    const lead = (blocks[i - 1] ?? '') + block
    if (/\/\*\s*latin\s*\*\//.test(lead.slice(-120)) && !latinWoff2) {
      latinWoff2 = url
    }
  }
  return latinWoff2 ?? firstWoff2
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// Build the activated-font registry entry from the metadata. Variable
// families store the wght range; static families store staticWeight 400.
function toActivatedFont(meta: GoogleFontMeta): GoogleActivatedFont {
  return {
    key: googleKey(meta.slug),
    family: meta.family,
    category: meta.category,
    file: `${googleKey(meta.slug)}.woff2`,
    format: 'woff2',
    ...(meta.variable
      ? { weightRange: [meta.variable[0], meta.variable[1]] as [number, number] }
      : { staticWeight: 400 }),
    ...(meta.italic ? { italic: true } : {}),
  }
}

export const GET = withError(async () => {
  await requireRole(['admin'])
  const activated = await getSetting('google_fonts')
  return NextResponse.json(
    { fonts: GOOGLE_FONTS, activated },
    {
      headers: {
        // Operator's own browser, short-lived private cache. The catalog is
        // static (regenerated only when we ship a new googleFontsData.json),
        // so 5 min keeps repeated picker opens cheap without staleness risk.
        'cache-control': 'private, max-age=300',
      },
    },
  )
})

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

  const body = (await readJsonBody(req)) as { slug?: unknown }
  const slug = typeof body.slug === 'string' ? body.slug : ''
  const meta = googleFontBySlug(slug)
  if (!meta) throw new HttpError(400, 'unknown_font')

  const key = googleKey(meta.slug)
  const fileName = `${key}.woff2`

  // Idempotent: already activated → return the existing entry unchanged. No
  // re-fetch, no duplicate row.
  const existing = await getSetting('google_fonts')
  const already = existing.find((f) => f.key === key)
  if (already) return NextResponse.json({ font: already })

  // Early cap reject (best-effort — the atomic re-check is inside the mutex).
  if (existing.length >= MAX_FONTS) throw new HttpError(400, 'too_many_fonts')

  // 1) Fetch the CSS2 stylesheet (browser UA → woff2 src). SSRF: this URL is
  //    constructed entirely from OUR catalog metadata + the fixed googleapis
  //    host, never from operator free-text.
  let cssRes: Response
  try {
    cssRes = await fetchWithTimeout(googleCss2Url(meta), {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/css,*/*;q=0.1' },
    })
  } catch {
    throw new HttpError(502, 'google_fetch_failed')
  }
  if (!cssRes.ok) throw new HttpError(502, 'google_fetch_failed')
  const css = await cssRes.text()

  // 2) Extract the latin woff2 URL and re-validate its host (SSRF). The src
  //    MUST point at gstatic — never an arbitrary origin a poisoned response
  //    might inject.
  const woff2Url = extractLatinWoff2Url(css)
  if (!woff2Url) throw new HttpError(502, 'no_woff2_in_css')
  if (hostOf(woff2Url) !== GSTATIC_HOST) throw new HttpError(502, 'unexpected_font_host')

  // 3) Download the woff2 (10 s timeout, cap 5 MB, magic-byte verified).
  let fontRes: Response
  try {
    fontRes = await fetchWithTimeout(woff2Url, {
      headers: { 'user-agent': BROWSER_UA },
    })
  } catch {
    throw new HttpError(502, 'google_fetch_failed')
  }
  if (!fontRes.ok) throw new HttpError(502, 'google_fetch_failed')

  // Reject oversize before buffering the whole body when the server declares
  // a content-length.
  const declared = Number(fontRes.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_FONT) {
    throw new HttpError(502, 'font_too_large')
  }
  const buf = Buffer.from(await fontRes.arrayBuffer())
  if (buf.byteLength > MAX_FONT) throw new HttpError(502, 'font_too_large')

  // Trust the BYTES, never the URL — the file must really be a woff2.
  const sniff = sniffFontFormat(buf)
  if (!sniff || sniff.format !== 'woff2') throw new HttpError(502, 'not_woff2')

  // 4) Store self-hosted under UPLOADS_ROOT/fonts.
  await mkdir(PATHS.fonts, { recursive: true, mode: 0o750 })
  await writeFile(path.join(PATHS.fonts, fileName), buf, { mode: 0o640 })

  // 5) Register via the mutex (re-checks idempotency + cap under lock).
  const font = toActivatedFont(meta)
  try {
    await mutateGoogleFonts(ctx.userId, (cur) => {
      // Another concurrent activation of the SAME font won the race — keep its
      // row, drop ours (we'll clean up the file below since it's identical).
      if (cur.some((f) => f.key === key)) return cur
      if (cur.length >= MAX_FONTS) throw new HttpError(400, 'too_many_fonts')
      return [...cur, font]
    })
  } catch (err) {
    // Lost the cap race (another activation filled the last slot) — drop the
    // orphaned file we just wrote, then surface the error.
    await rm(path.join(PATHS.fonts, fileName), { force: true }).catch(() => {})
    throw err
  }

  return NextResponse.json({ font })
})
