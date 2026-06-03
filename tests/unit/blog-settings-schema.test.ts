import { describe, it, expect } from 'vitest'
import { registry } from '@/lib/cms/settings-registry'

describe('settings-registry: blog-system keys', () => {
  it('blog_settings default is valid and round-trips', () => {
    const e = registry['blog_settings']
    expect(e).toBeDefined()
    expect(e.schema.parse(e.default)).toEqual(e.default)
    expect(e.default.postsPerPage).toBe(9)
    expect(e.default.feedItemCount).toBe(20)
  })

  it('blog_settings rejects out-of-range postsPerPage', () => {
    const e = registry['blog_settings']
    expect(e.schema.safeParse({ ...e.default, postsPerPage: 0 }).success).toBe(false)
    expect(e.schema.safeParse({ ...e.default, postsPerPage: 51 }).success).toBe(false)
  })

  it('permalink_blog default is "blog"/"postname" and valid', () => {
    const e = registry['permalink_blog']
    expect(e.default).toEqual({ segment: 'blog', structure: 'postname' })
    expect(e.schema.parse(e.default)).toEqual(e.default)
  })

  it('permalink_blog allows its own canonical word but rejects other reserved words', () => {
    const e = registry['permalink_blog']
    // own canonical word is allowed (it is reserved *for* the blog)
    expect(e.schema.safeParse({ segment: 'blog', structure: 'postname' }).success).toBe(true)
    // a non-reserved custom word is allowed
    expect(e.schema.safeParse({ segment: 'news', structure: 'postname' }).success).toBe(true)
    // other reserved words are rejected
    expect(e.schema.safeParse({ segment: 'admin', structure: 'postname' }).success).toBe(false)
    expect(e.schema.safeParse({ segment: 'api', structure: 'postname' }).success).toBe(false)
    // cannot steal the projects word (it is reserved and not blog's canonical)
    expect(e.schema.safeParse({ segment: 'projects', structure: 'postname' }).success).toBe(false)
  })

  it('permalink_projects allows "projects"/custom but rejects other reserved words', () => {
    const e = registry['permalink_projects']
    expect(e.schema.safeParse({ segment: 'projects' }).success).toBe(true)
    expect(e.schema.safeParse({ segment: 'residences' }).success).toBe(true)
    expect(e.schema.safeParse({ segment: 'admin' }).success).toBe(false)
    // cannot steal the blog word
    expect(e.schema.safeParse({ segment: 'blog' }).success).toBe(false)
  })

  it('permalink_blog rejects a malformed segment', () => {
    const e = registry['permalink_blog']
    // spaces / uppercase
    expect(e.schema.safeParse({ segment: 'Bad Seg', structure: 'postname' }).success).toBe(false)
    // too short (min 2)
    expect(e.schema.safeParse({ segment: 'a', structure: 'postname' }).success).toBe(false)
  })

  it('permalink_blog rejects an unknown structure', () => {
    const e = registry['permalink_blog']
    expect(e.schema.safeParse({ segment: 'blog', structure: 'nope' }).success).toBe(false)
  })

  it('permalink_projects default is "projects" and valid', () => {
    const e = registry['permalink_projects']
    expect(e.default).toEqual({ segment: 'projects' })
    expect(e.schema.parse(e.default)).toEqual(e.default)
  })
})
