// Coarse semver comparison for the update eligibility gate
// (minPreviousVersion). Shared by the prestage runner and the apply route so
// the "is this jump allowed?" decision is identical in both places.
//
// Deliberately core-only (major.minor.patch): prerelease / build metadata is
// ignored. The manifest's minPreviousVersion is a floor, not a strict
// precedence ranking, and manifest versions are clean semver upstream.

/** Parse the major.minor.patch core of a version; null if unparseable. */
export function parseSemverCore(v: string): [number, number, number] | null {
  const core = v.trim().split('+')[0]!.split('-')[0]!
  const parts = core.split('.')
  if (parts.length < 3) return null
  const nums = parts.slice(0, 3).map((p) => Number.parseInt(p, 10))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  return [nums[0]!, nums[1]!, nums[2]!]
}

/** -1 if a<b, 0 if equal, 1 if a>b. null if EITHER is unparseable. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemverCore(a)
  const pb = parseSemverCore(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1
    if (pa[i]! > pb[i]!) return 1
  }
  return 0
}

/**
 * Does `current` satisfy the `min` floor (current >= min)? Lenient on an
 * unparseable input (returns true) so a malformed version string never
 * blocks an update the operator explicitly approved — the floor is a guard
 * against known-incompatible jumps, not a hard parser.
 */
export function meetsMinPrevious(current: string, min: string): boolean {
  const cmp = compareSemver(current, min)
  if (cmp === null) return true
  return cmp >= 0
}
