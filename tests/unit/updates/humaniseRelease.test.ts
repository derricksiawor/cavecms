import { describe, it, expect } from 'vitest'
import { humaniseRelease } from '@/lib/updates/humaniseRelease'

const NOW = new Date('2026-05-25T12:00:00Z')

describe('humaniseRelease', () => {
  it('strips conventional-commit prefix from title', () => {
    const h = humaniseRelease(
      {
        sha: 'a',
        ts: '2026-05-25T00:00:00Z',
        changelog: 'feat(updates): add release banner',
        isSecurity: false,
      },
      NOW,
    )
    expect(h.title).toBe('add release banner')
  })

  it('strips trailing (#NNNN) PR ref and backticks', () => {
    const h = humaniseRelease(
      {
        sha: 'a',
        ts: '2026-05-25T00:00:00Z',
        changelog: 'Expose `index` and `siblings` on walk context (#20109)',
        isSecurity: false,
      },
      NOW,
    )
    expect(h.title).toBe('Expose index and siblings on walk context')
  })

  it('rewrites "This PR" to "This update" in body', () => {
    const h = humaniseRelease(
      {
        sha: 'a',
        ts: '2026-05-25T00:00:00Z',
        changelog: 'Better walking\n\nThis PR improves the walking context for nested blocks.',
        isSecurity: false,
      },
      NOW,
    )
    expect(h.body).toBe('This update improves the walking context for nested blocks.')
    expect(h.body.toLowerCase()).not.toContain('this pr')
  })

  it('strips SHAs only when in a commit-context preamble', () => {
    const h = humaniseRelease(
      {
        sha: 'a',
        ts: '2026-05-25T00:00:00Z',
        changelog: 'Title\n\nReverts commit deadbeef0123 to fix the regression.',
        isSecurity: false,
      },
      NOW,
    )
    expect(h.body).not.toMatch(/commit deadbeef/)
    // Standalone hex-y English words survive (decade, deface, etc.)
    const h2 = humaniseRelease(
      {
        sha: 'a',
        ts: '2026-05-25T00:00:00Z',
        changelog: 'Title\n\nDecade-old defaced page now redirects properly.',
        isSecurity: false,
      },
      NOW,
    )
    expect(h2.body).toMatch(/decade/i)
    expect(h2.body).toMatch(/defaced/i)
  })

  it('strips full 40-char SHAs without context', () => {
    const h = humaniseRelease(
      {
        sha: 'a',
        ts: '2026-05-25T00:00:00Z',
        changelog: 'Title\n\nMerged deadbeefcafe1234567890abcdef0123456789ab into main.',
        isSecurity: false,
      },
      NOW,
    )
    expect(h.body).not.toMatch(/deadbeefcafe1234567890abcdef0123456789ab/)
  })

  it('formatRelativeDays preserves capitalisation via opts', async () => {
    const { formatRelativeDays } = await import('@/lib/updates/humaniseRelease')
    expect(formatRelativeDays(new Date('2026-05-25T08:00:00Z'), NOW)).toBe('Today')
    expect(
      formatRelativeDays(new Date('2026-05-25T08:00:00Z'), NOW, { capitalise: false }),
    ).toBe('today')
    expect(
      formatRelativeDays(new Date('2026-05-24T08:00:00Z'), NOW, { capitalise: false }),
    ).toBe('yesterday')
  })

  it('falls back to a friendly title when changelog is empty', () => {
    const h = humaniseRelease(
      { sha: 'a', ts: '2026-05-25T00:00:00Z', changelog: '', isSecurity: false },
      NOW,
    )
    expect(h.title).toBe('New release available')
  })

  it('relative date: today / yesterday / N days ago', () => {
    expect(
      humaniseRelease({ sha: 'a', ts: '2026-05-25T08:00:00Z', changelog: 'x', isSecurity: false }, NOW).releasedRelative,
    ).toBe('Today')
    expect(
      humaniseRelease({ sha: 'a', ts: '2026-05-24T08:00:00Z', changelog: 'x', isSecurity: false }, NOW).releasedRelative,
    ).toBe('Yesterday')
    expect(
      humaniseRelease({ sha: 'a', ts: '2026-05-22T08:00:00Z', changelog: 'x', isSecurity: false }, NOW).releasedRelative,
    ).toBe('3 days ago')
  })

  it('versionLabel never contains a SHA or hex hint', () => {
    const h = humaniseRelease(
      {
        sha: 'deadbeefcafe1234567890abcdef0123456789ab',
        ts: '2026-05-22T08:00:00Z',
        changelog: 'feat: x',
        isSecurity: false,
      },
      NOW,
    )
    expect(h.versionLabel).not.toMatch(/deadbeef|[a-f0-9]{7,}/i)
  })

  it('body excludes the title line', () => {
    const h = humaniseRelease(
      {
        sha: 'a',
        ts: '2026-05-25T00:00:00Z',
        changelog: 'Add updates feature\n\nLong description of what changed.',
        isSecurity: false,
      },
      NOW,
    )
    expect(h.title).toBe('Add updates feature')
    expect(h.body).toBe('Long description of what changed.')
  })
})
