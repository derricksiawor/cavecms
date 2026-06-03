import { NextResponse, type NextRequest } from 'next/server'
import { loadBlogLoopPage } from '@/lib/cms/hydrate'
import { SLUG_RE } from '@/lib/cms/slug'

// Load-more pagination data source for the Posts widget (#4). The 'current'
// (blog archive) source renders its first page server-side via postsLoop; when
// the operator picks the `load-more` pagination mode, the client appender
// (PostsLoadMore) fetches the NEXT page's cards from here and appends them in
// place, preserving scroll + announcing via aria-live.
//
// CONTRACT
//   GET /api/blog/loop?page=N[&category=<slug>][&tag=<slug>][&perPage=K]
//   → { items: HydratedPostLoopItem[], page, perPage, hasPrev, hasNext, basePath }
//
// The slice reuses the SAME bounded keyset/OFFSET query the server render uses
// (loadBlogLoopPage → fetchPostsLoopSlice), so an appended page is byte-
// identical to a server-rendered one. `category`/`tag` are SLUG_RE-validated
// here so a malformed value can never reach the parameterised taxonomy join.
// `page` is clamped inside the slice (MAX_LOOP_PAGE), so a crafted ?page=
// can't ask the DB to skip an unbounded offset (#0.251).
//
// force-dynamic + no caching: the blog index is itself force-dynamic; appended
// pages must reflect the same live publish state.
export const dynamic = 'force-dynamic'

function intParam(v: string | null, fallback: number): number {
  if (typeof v !== 'string') return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function slugParam(v: string | null): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > 120) return undefined
  return SLUG_RE.test(v) ? v : undefined
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const page = Math.max(1, intParam(sp.get('page'), 1))
  // A category XOR tag filter. If both are (somehow) present, category wins —
  // the same precedence the archive routes use.
  const rawCategory = slugParam(sp.get('category'))
  const rawTag = rawCategory ? undefined : slugParam(sp.get('tag'))
  // perPage is OPTIONAL — when absent the slice falls back to
  // blog_settings.postsPerPage (the canonical page size). A provided value is
  // clamped inside loadBlogLoopPage/fetchPostsLoopSlice to [1, 50].
  const rawPerPage = sp.get('perPage')
  const perPage = rawPerPage !== null ? intParam(rawPerPage, NaN) : undefined

  try {
    const slice = await loadBlogLoopPage({
      page,
      perPage: typeof perPage === 'number' && Number.isFinite(perPage) ? perPage : undefined,
      category: rawCategory,
      tag: rawTag,
    })
    return NextResponse.json(slice, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'blog_loop_route_failed',
        err_name: err instanceof Error ? err.name : 'unknown',
      }),
    )
    // Fail soft — the appender treats a non-OK response as "no more to load"
    // and stops, leaving the server-rendered first page intact.
    return NextResponse.json({ error: 'unavailable' }, { status: 500 })
  }
}
