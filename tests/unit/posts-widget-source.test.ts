import { describe, it, expect } from 'vitest'
import { resolvePostsWidgetSource } from '@/lib/cms/postsWidgetSource'

// Source-descriptor resolution for the Posts widget (#2). resolvePostsWidgetSource
// maps a parsed block's source + operands → the fetcher descriptor (or null when
// the required operand is missing). It's the pure decision layer between the
// schema and the bounded DB query; lock its behaviour down here so a regression
// surfaces as a test failure, not as a widget that silently shows the wrong
// posts (or empties).

describe('resolvePostsWidgetSource', () => {
  it("latest → { kind: 'latest' } (no operand needed)", () => {
    expect(resolvePostsWidgetSource({ source: 'latest' }, undefined, undefined)).toEqual({
      kind: 'latest',
    })
  })

  it('category → resolves with a slug, null without', () => {
    expect(
      resolvePostsWidgetSource({ source: 'category', category: 'news' }, undefined, undefined),
    ).toEqual({ kind: 'category', slug: 'news' })
    expect(resolvePostsWidgetSource({ source: 'category' }, undefined, undefined)).toBeNull()
  })

  it('tag → resolves with a slug, null without', () => {
    expect(
      resolvePostsWidgetSource({ source: 'tag', tag: 'release-notes' }, undefined, undefined),
    ).toEqual({ kind: 'tag', slug: 'release-notes' })
    expect(resolvePostsWidgetSource({ source: 'tag' }, undefined, undefined)).toBeNull()
  })

  it('author → resolves with an id, null without', () => {
    expect(
      resolvePostsWidgetSource({ source: 'author', authorId: 7 }, undefined, undefined),
    ).toEqual({ kind: 'author', authorId: 7 })
    expect(resolvePostsWidgetSource({ source: 'author' }, undefined, undefined)).toBeNull()
  })

  it('manual → resolves with ids, null when empty/absent', () => {
    expect(
      resolvePostsWidgetSource({ source: 'manual', manualPostIds: [3, 1, 2] }, undefined, undefined),
    ).toEqual({ kind: 'manual', ids: [3, 1, 2] })
    expect(
      resolvePostsWidgetSource({ source: 'manual', manualPostIds: [] }, undefined, undefined),
    ).toBeNull()
    expect(resolvePostsWidgetSource({ source: 'manual' }, undefined, undefined)).toBeNull()
  })

  it('related → resolves ONLY with a current post id (anchor), null off a non-post page', () => {
    expect(
      resolvePostsWidgetSource({ source: 'related' }, 42, ['news', 'updates']),
    ).toEqual({ kind: 'related', currentPostId: 42, categorySlugs: ['news', 'updates'] })
    // No current post (placed on a non-post page) → no related list.
    expect(resolvePostsWidgetSource({ source: 'related' }, undefined, undefined)).toBeNull()
  })

  it("current → null here (handled by the loop/postsLoop path, not the self-contained fetcher)", () => {
    expect(resolvePostsWidgetSource({ source: 'current' }, undefined, undefined)).toBeNull()
  })

  it('an unknown source → null (fail-closed to empty rather than a wrong query)', () => {
    expect(resolvePostsWidgetSource({ source: 'whatever' }, 1, undefined)).toBeNull()
  })
})
