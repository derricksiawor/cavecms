// Structural deep-equal that short-circuits on the first difference.
// Cheaper than `JSON.stringify(a) === JSON.stringify(b)` for any payload
// that has unequal prefixes (which is the common case while typing —
// the first changed key wins and we return false immediately).
//
// Same recursion limits / cycle-blindness as JSON.stringify: object
// cycles will overflow the stack. Caller must own structurally-acyclic
// data — which holds for Zod-validated settings/section payloads.

export function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  const ar = a as Record<string, unknown>
  const br = b as Record<string, unknown>
  const ak = Object.keys(ar)
  const bk = Object.keys(br)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(br, k)) return false
    if (!structuralEqual(ar[k], br[k])) return false
  }
  return true
}
