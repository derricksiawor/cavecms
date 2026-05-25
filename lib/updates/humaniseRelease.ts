// Human-friendly transformation of raw release metadata (SHA + commit
// message + timestamp) into copy a non-technical operator can read.
//
// Once cavecms.derricksiawor.com/releases/manifest.json is live, the upstream will
// carry proper semver versions + handwritten release notes, and most
// of this scrubbing becomes a no-op (versionLabel resolves to "1.4.0"
// instead of a date string, releaseNotes pass through clean). For
// now (GitHub-commits backend) we synthesise the friendliest possible
// copy from what we have.

interface RawRelease {
  /** Raw SHA — operator-facing UI MUST NEVER render this. */
  sha: string
  /** ISO timestamp. */
  ts: string
  /** Raw commit message OR future hand-written release notes. */
  changelog: string
  isSecurity: boolean
}

export interface HumanRelease {
  /**
   * Friendly version label.
   * - "Version 1.4.0" once a manifest provides one.
   * - "Released today" / "Released 3 days ago" / "Released March 12" as
   *   a fallback when we only have a timestamp.
   */
  versionLabel: string
  /** Always available — same date formatted as a relative phrase. */
  releasedRelative: string
  /** Absolute date, used as a secondary hint under the label. */
  releasedAbsolute: string
  /** Short title — first non-empty line of the changelog, cleaned. */
  title: string
  /** Body paragraphs after the title, ready for markdown rendering. */
  body: string
  /** Whether the security badge should show. */
  isSecurity: boolean
}

// Hoist regexes to module scope so we don't compile them per call.
const BACKTICK_RE = /`([^`]*)`/g
const THIS_PR_RE = /\bthis\s+PR\b/gi
const THE_PR_RE = /\bthe\s+PR\b/gi
const SENTENCE_PR_RE = /(^|[.!?]\s+)PR\b/g
const PR_REF_RE = /\s*\(#\d+\)\s*/g
// Full-SHA only (40 hex). Short refs are also stripped, but ONLY in
// a commit-context preamble like "commit abc1234" so plain English
// words that happen to be all hex letters (cafe, decade, defaced)
// survive.
const FULL_SHA_RE = /\b[0-9a-f]{40}\b/gi
const CONTEXT_SHORT_SHA_RE = /\b(?:commit|sha|ref|rev|hash)\s+[0-9a-f]{7,12}\b/gi
const WHITESPACE_COLLAPSE_RE = /[ \t]+/g
const ORPHAN_PERIOD_RE = /\s+\./g
const ORPHAN_COMMA_RE = /\s+,/g
const CONV_COMMIT_RE =
  /^(?:feat|fix|chore|refactor|docs|style|test|build|ci|perf|revert)(?:\([^)]*\))?:\s*/i
const WIP_PREFIX_RE = /^\s*WIP:\s*/i

// Strip dev-speak from operator-facing copy. Applied to title AND
// body. Once cavecms.derricksiawor.com/manifest ships hand-written notes, most of
// these substitutions become no-ops on already-clean copy.
function scrubDevSpeak(s: string): string {
  return s
    // Drop inline backticks but preserve their content.
    .replace(BACKTICK_RE, '$1')
    // "This PR" / "this PR" → "this update" (preserve original case
    // of the leading "T"/"t" so we don't lowercase a sentence start).
    .replace(THIS_PR_RE, (m) => (m[0] === 'T' ? 'This update' : 'this update'))
    .replace(THE_PR_RE, (m) => (m[0] === 'T' ? 'The update' : 'the update'))
    // Leading "PR " when at the start of a sentence.
    .replace(SENTENCE_PR_RE, '$1Update')
    // Drop `(#NNNN)` PR refs anywhere.
    .replace(PR_REF_RE, ' ')
    // Drop full-SHA only.
    .replace(FULL_SHA_RE, '')
    // Drop short SHAs only when in a commit-context preamble.
    .replace(CONTEXT_SHORT_SHA_RE, '')
    // Collapse the whitespace we just created.
    .replace(WHITESPACE_COLLAPSE_RE, ' ')
    .replace(ORPHAN_PERIOD_RE, '.')
    .replace(ORPHAN_COMMA_RE, ',')
}

// Split changelog into a short title (first non-empty cleaned line) +
// the rest as body. Strips conventional-commit prefixes (`feat:` /
// `fix:` / `chore:`), PR refs, backticks — operators don't speak
// code-review dialect.
//
// Loops the conv-commit strip up to 3 times to handle pathological
// nested cases like `feat(scope): fix: foo` → `foo`.
function splitChangelog(raw: string): { title: string; body: string } {
  const lines = raw.split(/\r?\n/)
  let titleIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed.length > 0) {
      titleIdx = i
      break
    }
  }
  if (titleIdx === -1) {
    return { title: 'New release available', body: '' }
  }
  let titleRaw = (lines[titleIdx] ?? '').trim()
  // Loop the conv-commit strip — handles nested cases.
  for (let i = 0; i < 3; i++) {
    const next = titleRaw.replace(CONV_COMMIT_RE, '')
    if (next === titleRaw) break
    titleRaw = next
  }
  const stripped = titleRaw.replace(WIP_PREFIX_RE, '').trim()
  const title = scrubDevSpeak(stripped).trim() || 'New release available'

  const rawBody = lines.slice(titleIdx + 1).join('\n').trim()
  const body = scrubDevSpeak(rawBody).trim()

  return { title, body }
}

/**
 * Friendly relative date string: "Today" / "Yesterday" / "3 days
 * ago" / "Last week" / etc.
 *
 * Single shared formatter — UpdatesClient also calls this so the
 * "current version released X" copy stays in lockstep with the
 * "available release X" copy. Pass `capitalise: false` for inline-
 * after-verb usage ("Last updated 3 days ago" — no opening capital).
 */
export function formatRelativeDays(
  when: Date,
  now: Date = new Date(),
  opts: { capitalise?: boolean } = {},
): string {
  const ms = now.getTime() - when.getTime()
  const dayMs = 24 * 60 * 60 * 1000
  // Use Math.round so DST transitions don't shift the bucket by an
  // hour on either side of midnight.
  const days = Math.round(ms / dayMs)
  const cap = opts.capitalise ?? true
  if (days < 0) return cap ? 'Just now' : 'just now'
  if (days === 0) return cap ? 'Today' : 'today'
  if (days === 1) return cap ? 'Yesterday' : 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return cap ? 'Last week' : 'last week'
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`
  if (days < 60) return cap ? 'Last month' : 'last month'
  return when.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
}

export function humaniseRelease(
  raw: RawRelease,
  now: Date = new Date(),
): HumanRelease {
  const releasedDate = new Date(raw.ts)
  // Two formattings of the same date: the standalone "Today" /
  // "3 days ago" badge (capitalised) AND the inline-after-verb form
  // used in versionLabel ("Released today"). Compute both once.
  const releasedRelative = formatRelativeDays(releasedDate, now)
  const releasedRelativeLower = formatRelativeDays(releasedDate, now, {
    capitalise: false,
  })
  const releasedAbsolute = releasedDate.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const { title, body } = splitChangelog(raw.changelog)

  // Friendly version label. With only GitHub commits we synthesise
  // from the release date; with the future cavecms.derricksiawor.com manifest this
  // will be replaced by the semver string carried in the manifest.
  const versionLabel = `Released ${releasedRelativeLower}`

  return {
    versionLabel,
    releasedRelative,
    releasedAbsolute,
    title,
    body,
    isSecurity: raw.isSecurity,
  }
}
