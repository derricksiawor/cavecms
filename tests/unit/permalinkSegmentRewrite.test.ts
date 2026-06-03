import { describe, it, expect } from 'vitest'
import { rewriteConfiguredSegment } from '@/lib/blog/segmentRewrite'
import {
  blogIndexUrl,
  postUrl,
  categoryUrl,
  tagUrl,
  projectUrl,
  feedUrl,
  DEFAULT_SEGMENTS,
} from '@/lib/blog/urls'
import { validatePageSlug } from '@/lib/cms/page-slug'
import { SLUG_RE } from '@/lib/cms/slug'

// ─── segment rewrite (the middleware hot path's pure core) ───
describe('rewriteConfiguredSegment', () => {
  const base = {
    blogSegment: 'news',
    projectsSegment: 'work',
    blogStructure: 'postname' as const,
  }

  it('is a NO-OP when both segments are the literal defaults (byte-identical to today)', () => {
    for (const p of ['/blog', '/blog/hello', '/blog/category/x', '/projects', '/projects/y', '/anything']) {
      expect(
        rewriteConfiguredSegment({
          pathname: p,
          blogSegment: 'blog',
          projectsSegment: 'projects',
          blogStructure: 'postname',
        }),
      ).toBeNull()
    }
  })

  it('maps a custom blog index + sub-paths to the canonical internal routes', () => {
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news' })).toBe('/blog')
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/' })).toBe('/blog')
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/hello-world' })).toBe('/blog/hello-world')
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/category/design' })).toBe('/blog/category/design')
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/tag/launch' })).toBe('/blog/tag/launch')
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/feed' })).toBe('/blog/feed')
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/feed.xml' })).toBe('/blog/feed')
  })

  it('maps a custom projects index + detail to the canonical internal routes', () => {
    expect(rewriteConfiguredSegment({ ...base, pathname: '/work' })).toBe('/projects')
    expect(rewriteConfiguredSegment({ ...base, pathname: '/work/lakeside-villa' })).toBe('/projects/lakeside-villa')
  })

  it('handles the year-month structure (validates yyyy/mm; resolves by slug)', () => {
    const ym = { ...base, blogStructure: 'year-month-postname' as const }
    expect(rewriteConfiguredSegment({ ...ym, pathname: '/news/2026/06/hello' })).toBe('/blog/hello')
    // Wrong arity / bad month / bad year → no rewrite (falls through to 404).
    expect(rewriteConfiguredSegment({ ...ym, pathname: '/news/2026/13/hello' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...ym, pathname: '/news/26/06/hello' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...ym, pathname: '/news/hello' })).toBeNull()
  })

  it('rejects a malformed slug tail under a custom segment (returns null)', () => {
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/Has Space' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/-bad' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...base, pathname: '/news/category/-bad' })).toBeNull()
  })

  it('does NOT re-rewrite the canonical /blog or /projects path on re-entry (no loop)', () => {
    // After the first rewrite, middleware re-runs on /blog/hello; first part is
    // 'blog' which != custom 'news', so the matcher returns null.
    expect(rewriteConfiguredSegment({ ...base, pathname: '/blog/hello' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...base, pathname: '/projects/y' })).toBeNull()
  })

  it('ignores paths that belong to neither configured segment', () => {
    expect(rewriteConfiguredSegment({ ...base, pathname: '/about' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...base, pathname: '/' })).toBeNull()
  })

  it('only the custom segment matches — the literal default no longer routes here', () => {
    // With blog=news, the literal /blog is NOT owned by the segment rewrite
    // (it's reached by the file route directly). A custom segment === default
    // for projects means /projects is untouched too.
    const mixed = { blogSegment: 'news', projectsSegment: 'projects', blogStructure: 'postname' as const }
    expect(rewriteConfiguredSegment({ ...mixed, pathname: '/projects/y' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...mixed, pathname: '/news/y' })).toBe('/blog/y')
  })

  // ─── C1: DEFAULT 'blog' segment + year-month must rewrite the dated post ───
  // There is no app/blog/[yyyy]/[mm]/[slug] file route; the dated shape must be
  // rewritten to the canonical /blog/<slug> (resolves by slug). Every NON-dated
  // path under the default segment must still return null (its file route serves
  // it directly) so default + postname stays byte-identical.
  it('rewrites the dated post path on the DEFAULT blog segment under year-month', () => {
    const def = { blogSegment: 'blog', projectsSegment: 'projects', blogStructure: 'year-month-postname' as const }
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/2026/06/my-post' })).toBe('/blog/my-post')
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/2026/06/my-post/' })).toBe('/blog/my-post')
  })

  it('leaves NON-dated default-segment paths untouched under year-month (file routes serve them)', () => {
    const def = { blogSegment: 'blog', projectsSegment: 'projects', blogStructure: 'year-month-postname' as const }
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/my-post' })).toBeNull() // 2-part → file route
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/category/news' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/tag/launch' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/feed' })).toBeNull()
  })

  it('returns null for an invalid date on the default blog segment under year-month', () => {
    const def = { blogSegment: 'blog', projectsSegment: 'projects', blogStructure: 'year-month-postname' as const }
    // Bad arity / bad year / bad month → no rewrite (falls through to 404).
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/20/6/x' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/2026/13/x' })).toBeNull()
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/2026/06/Has Space' })).toBeNull()
  })

  it('default blog segment + postname is a no-op even for a 4-part path (structure-gated)', () => {
    // Without year-month, the 4-part dated shape is NOT a post route — return
    // null so it 404s / falls to file routing exactly as today.
    const def = { blogSegment: 'blog', projectsSegment: 'projects', blogStructure: 'postname' as const }
    expect(rewriteConfiguredSegment({ ...def, pathname: '/blog/2026/06/my-post' })).toBeNull()
  })

  it('custom segment + year-month still rewrites the full dated shape (unchanged)', () => {
    const ym = { ...base, blogStructure: 'year-month-postname' as const }
    expect(rewriteConfiguredSegment({ ...ym, pathname: '/news/2026/06/my-post' })).toBe('/blog/my-post')
  })
})

// ─── SLUG_RE parity (the rewrite duplicates the regex for the Edge bundle) ───
describe('segmentRewrite SLUG_RE parity', () => {
  it('the rewrite accepts/rejects exactly what SLUG_RE does for the tail slug', () => {
    const base = { blogSegment: 'news', projectsSegment: 'work', blogStructure: 'postname' as const }
    const cases = ['hello', 'a2', 'multi-word-slug', 'UPPER', 'has space', '-lead', 'trail-', 'a--b', 'ok123']
    for (const slug of cases) {
      const viaRe = SLUG_RE.test(slug)
      const viaRewrite = rewriteConfiguredSegment({ ...base, pathname: `/news/${slug}` }) !== null
      expect(viaRewrite).toBe(viaRe)
    }
  })
})

// ─── url helpers: defaults preserve today's URLs; segments override ───
describe('lib/blog/urls helpers', () => {
  it('default segments produce today’s literal URLs', () => {
    expect(blogIndexUrl()).toBe('/blog')
    expect(blogIndexUrl(2)).toBe('/blog?page=2')
    expect(postUrl('hello')).toBe('/blog/hello')
    expect(categoryUrl('x')).toBe('/blog/category/x')
    expect(categoryUrl('x', 3)).toBe('/blog/category/x?page=3')
    expect(tagUrl('y')).toBe('/blog/tag/y')
    expect(feedUrl()).toBe('/blog/feed')
    expect(projectUrl('z')).toBe('/projects/z')
  })

  it('custom segments are honored', () => {
    const s = { blog: 'news', projects: 'work', structure: 'postname' as const }
    expect(blogIndexUrl(1, s)).toBe('/news')
    expect(postUrl('hello', s)).toBe('/news/hello')
    expect(categoryUrl('x', 1, s)).toBe('/news/category/x')
    expect(tagUrl('y', 2, s)).toBe('/news/tag/y?page=2')
    expect(feedUrl(s)).toBe('/news/feed')
    expect(projectUrl('z', s)).toBe('/work/z')
  })

  it('year-month structure produces the dated post path (UTC), with a postname fallback when no date', () => {
    const s = { blog: 'news', projects: 'work', structure: 'year-month-postname' as const }
    expect(postUrl('hello', s, '2026-06-15T12:00:00Z')).toBe('/news/2026/06/hello')
    // No publishedAt → falls back to post-name form (never breaks a link).
    expect(postUrl('hello', s, null)).toBe('/news/hello')
    // Defaults sanity.
    expect(DEFAULT_SEGMENTS.blog).toBe('blog')
  })

  // ─── L2: dated prefix is stable for a zone-naive MariaDB datetime string ───
  // '2026-06-30 23:30:00' (space-separated, no zone) is UTC as stored. A naive
  // `new Date(str)` would parse it in the runtime's LOCAL zone — behind UTC it
  // rolls into July → wrong month. The component-parse keeps it on June
  // regardless of the runner's TZ, and regardless of Date-vs-string driver shape.
  it('year-month prefix is TZ-stable for a zone-naive datetime string at a day boundary', () => {
    const s = { blog: 'news', projects: 'work', structure: 'year-month-postname' as const }
    expect(postUrl('p', s, '2026-06-30 23:30:00')).toBe('/news/2026/06/p')
    expect(postUrl('p', s, '2026-06-30T23:30:00')).toBe('/news/2026/06/p')
    expect(postUrl('p', s, '2026-06-30 23:30:00.000')).toBe('/news/2026/06/p')
    // Date object (some drivers) — already UTC-correct.
    expect(postUrl('p', s, new Date('2026-06-30T23:30:00Z'))).toBe('/news/2026/06/p')
    // Explicit-zone string still honors UTC getters.
    expect(postUrl('p', s, '2026-06-30T23:30:00Z')).toBe('/news/2026/06/p')
    // Unparseable → postname fallback (link never breaks).
    expect(postUrl('p', s, 'not-a-date')).toBe('/news/p')
  })
})

// ─── dynamic reserved set in validatePageSlug ───
describe('validatePageSlug extraReserved (Phase 5 dynamic segments)', () => {
  const LOGIN = 'kqt9ji3jrhz7'

  it('rejects a slug equal to a custom permalink segment', () => {
    const extra = new Set(['news', 'work'])
    expect(validatePageSlug('news', LOGIN, extra)).toEqual({ ok: false, reason: 'slug_reserved' })
    expect(validatePageSlug('work', LOGIN, extra)).toEqual({ ok: false, reason: 'slug_reserved' })
  })

  it('still accepts an unrelated slug when a custom segment set is present', () => {
    const extra = new Set(['news'])
    expect(validatePageSlug('about-us', LOGIN, extra)).toEqual({ ok: true })
  })

  it('the literal blog/projects words remain reserved with no extra set (back-compat)', () => {
    expect(validatePageSlug('blog', LOGIN)).toEqual({ ok: false, reason: 'slug_reserved' })
    expect(validatePageSlug('projects', LOGIN)).toEqual({ ok: false, reason: 'slug_reserved' })
  })
})
