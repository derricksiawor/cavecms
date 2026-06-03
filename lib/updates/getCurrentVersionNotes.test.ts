import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  stripVersionHeading,
  readNotes,
  getCurrentVersionNotes,
} from './getCurrentVersionNotes'

describe('stripVersionHeading', () => {
  it('strips a leading `## <version>` heading and following blank lines', () => {
    const raw = '## 0.1.90\n\nA big one.\n\n### New — thing'
    expect(stripVersionHeading(raw, '0.1.90')).toBe('A big one.\n\n### New — thing')
  })

  it('strips leading blank lines before the version heading', () => {
    const raw = '\n\n## 0.1.90\n\nLead.'
    expect(stripVersionHeading(raw, '0.1.90')).toBe('Lead.')
  })

  it('does NOT strip a heading whose text is not the version', () => {
    const raw = '## New — feature\n\nBody.'
    expect(stripVersionHeading(raw, '0.1.90')).toBe('## New — feature\n\nBody.')
  })

  it('returns trimmed body when there is no leading heading', () => {
    const raw = 'Just prose.\n'
    expect(stripVersionHeading(raw, '0.1.90')).toBe('Just prose.')
  })
})

describe('readNotes', () => {
  const repoRoot = process.cwd()

  it('reads the real current release note (0.1.90) from the repo root', () => {
    const notes = readNotes('0.1.90', repoRoot)
    expect(notes).not.toBeNull()
    expect(notes!.version).toBe('0.1.90')
    // body starts at the lead paragraph — the `## 0.1.90` line is gone.
    expect(notes!.body.startsWith('#')).toBe(false)
    expect(notes!.body.length).toBeGreaterThan(0)
  })

  it('returns null when the version file does not exist', () => {
    expect(readNotes('9.9.9', repoRoot)).toBeNull()
  })

  it('returns null for the dev sentinel version', () => {
    expect(readNotes('unknown', repoRoot)).toBeNull()
  })

  it('returns null when the base dir has no release-notes', () => {
    expect(readNotes('0.1.90', path.join(repoRoot, 'lib'))).toBeNull()
  })

  it('returns null for a non-semver version (path-traversal guard)', () => {
    expect(readNotes('../../etc/passwd', repoRoot)).toBeNull()
  })
})

describe('getCurrentVersionNotes', () => {
  it('returns the running version notes (repo is on a released version)', () => {
    const notes = getCurrentVersionNotes()
    // The repo's package.json version has a matching release-notes file.
    expect(notes).not.toBeNull()
    expect(notes!.body.length).toBeGreaterThan(0)
  })
})
