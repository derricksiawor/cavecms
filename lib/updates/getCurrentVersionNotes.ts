// Reads the release notes for the CURRENTLY-RUNNING version so the Updates
// page can show "what's new in the version you're on". The running build's
// own repo always ships the matching `release-notes/<version>.md` (it's
// git-tracked and committed by build-release.sh on every version bump), so
// this is an exact match for both fresh CLI installs and in-app updates,
// needs no network, and needs no stored state.
//
// The markdown is bundled into the standalone build via
// `outputFileTracingIncludes` in next.config.ts (same mechanism as
// docs/admin-help.md) — without that the read 500s with ENOENT in
// production because the standalone cwd is `.next/standalone/`.
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Build-inlined version — same single source of truth getCurrentVersion.ts
// uses. Webpack inlines the JSON import so reading it can't fail on a missing
// package.json in the standalone bundle.
import pkg from '../../package.json' with { type: 'json' }

const BUILT_VERSION: string = typeof pkg.version === 'string' ? pkg.version : 'unknown'

export interface CurrentVersionNotes {
  /** The running semver, e.g. `'0.1.90'`. */
  version: string
  /** Release-note markdown WITHOUT the leading `## <version>` heading line. */
  body: string
}

/**
 * Strip a leading `## <version>` heading (and the blank lines around it) so
 * the body starts at the lead paragraph — matching what <ReleaseNotesMarkdown>
 * expects (the version is carried by the card header). Only strips a heading
 * whose text equals the version, never a real `### New — …` section heading.
 */
export function stripVersionHeading(raw: string, version: string): string {
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  const heading = /^#{1,6}\s+(.*)$/.exec((lines[i] ?? '').trim())
  if (heading && (heading[1] ?? '').trim() === version) {
    i++
    while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  }
  return lines.slice(i).join('\n').trim()
}

/**
 * Read + parse the notes for a specific version. `baseDir` is injectable for
 * tests; production always uses `process.cwd()`. Returns null on any failure
 * (missing file, unreadable, empty body, non-semver version).
 */
export function readNotes(
  version: string,
  baseDir: string = process.cwd(),
): CurrentVersionNotes | null {
  // Defense in depth: `version` is built into the bundle, but it is used as a
  // path segment — never build a path from an unvalidated string.
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return null
  let raw: string
  try {
    raw = readFileSync(path.join(baseDir, 'release-notes', `${version}.md`), 'utf8')
  } catch {
    return null
  }
  const body = stripVersionHeading(raw, version)
  if (!body) return null
  return { version, body }
}

// Immutable for a process's lifetime — read once, cache (including null).
let cached: CurrentVersionNotes | null | undefined
export function getCurrentVersionNotes(): CurrentVersionNotes | null {
  if (cached !== undefined) return cached
  cached = readNotes(BUILT_VERSION)
  return cached
}
