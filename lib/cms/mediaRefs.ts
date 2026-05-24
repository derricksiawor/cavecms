import 'server-only'

export interface MediaRefPath {
  mediaId: number
  /**
   * JSON path from the root of the block's `data` to the parent object
   * holding `media_id`. Uses dot for nested objects, `[N]` for array
   * indexes. Examples: `"image"`, `"gallery[2]"`, `"sections[0].hero.image"`.
   */
  field: string
}

/**
 * Walk an arbitrary block payload and surface every {media_id: number}
 * binding with its JSON path. Used by:
 *   - saveBlock to diff old vs new media_references on every update
 *   - hydratePage's phase-1 to collect media ids for a single bulk fetch
 *   - the weekly verifier cron (Plan 09) to rebuild the reverse index
 *
 * Numeric media_id is the only signal — strings/null are ignored so a
 * malformed payload (e.g. a string '7' from a manual SQL INSERT) doesn't
 * inject a phantom reference. Non-object inputs return [].
 */
// Depth cap mirrors lib/cms/parse.ts walkAndSanitize. This walker also
// runs on already-parsed data inside hydratePage; the cap closes the
// symmetry gap so a malformed cell that bypassed write-time validation
// still can't blow the read-path stack.
const MAX_DEPTH = 32

export function collectMediaPaths(
  value: unknown,
  prefix = '',
): MediaRefPath[] {
  const out: MediaRefPath[] = []
  walk(value, prefix, out, 0)
  return out
}

function walk(
  v: unknown,
  path: string,
  out: MediaRefPath[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) return // truncate; siblings already collected
  if (v == null || typeof v !== 'object') return
  if (Array.isArray(v)) {
    v.forEach((item, i) => walk(item, `${path}[${i}]`, out, depth + 1))
    return
  }
  const obj = v as Record<string, unknown>
  // Strict integer + positive guard. `typeof === 'number'` admits 1.5,
  // 0, -3, NaN, Infinity — any of which would feed assertMediaAvailable
  // a non-existent id and 404 the save, OR (worse) leak a fractional
  // value into media_references that the verifier cron can never
  // reconcile. Zod catches this on writes; this guard catches tampered
  // DB cells on the read path.
  if (
    typeof obj.media_id === 'number' &&
    Number.isInteger(obj.media_id) &&
    obj.media_id > 0
  ) {
    out.push({ mediaId: obj.media_id, field: path || 'media_id' })
  }
  for (const [k, val] of Object.entries(obj)) {
    walk(val, path ? `${path}.${k}` : k, out, depth + 1)
  }
}
